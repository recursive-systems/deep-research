#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { classifyRunError } from './error-classifier.js';
import { MAX_OPEN_ENDED_ITERATIONS, MAX_OPEN_ENDED_MINUTES } from './config.js';
import {
  loadPromptTemplates,
  materializeIterationPrompt,
  combineSystemAndTaskPrompt,
} from './prompt.js';
import { evaluateRunIteration } from './evaluator.js';
import { appendRunEvent, readRun, updateRun } from './store.js';
import { runAcpIteration } from './acp-runner.js';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--run-id') {
      args.runId = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }
  if (!args.runId) {
    throw new Error('Missing required --run-id');
  }
  return args;
}

async function countCompletedIterations(runDir, runId) {
  const iterationsDir = path.join(runDir, 'iterations');
  const entries = await fs.readdir(iterationsDir).catch(() => []);
  const mdFiles = entries.filter((entry) => entry.endsWith('.md'));

  // Skip empty files — they indicate a crash mid-write
  let nonEmptyCount = 0;
  for (const file of mdFiles) {
    const filePath = path.join(iterationsDir, file);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0) {
        nonEmptyCount += 1;
      }
    } catch {
      // File disappeared between readdir and stat — skip it
    }
  }

  // Cross-check against run.json completedIterations
  const run = await readRun(runId);
  const jsonCount = run ? Number(run.completedIterations || 0) : nonEmptyCount;

  let warning = null;
  if (nonEmptyCount !== jsonCount) {
    warning = `[worker] WARNING: Iteration file count (${nonEmptyCount}) differs from run.json completedIterations (${jsonCount}) — using lower value`;
  }

  return { count: Math.min(nonEmptyCount, jsonCount), warning };
}

async function createLogger(logFile) {
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const handle = await fs.open(logFile, 'a');

  return {
    async write(text, { raw = false } = {}) {
      const output = raw ? text : `${text}\n`;
      await handle.appendFile(output, 'utf8');
      if (process.stdout.writable) {
        process.stdout.write(output);
      }
    },
    async close() {
      await handle.close();
    },
  };
}

function describeIterations(run) {
  return run.requestedIterations == null ? 'open-ended' : String(run.requestedIterations);
}

function topicIterationFor(run, localIteration) {
  return Number(run.topicIterationOffset || 0) + localIteration;
}

async function hasJudgeableArtifacts(runDir) {
  const candidates = [path.join(runDir, 'report.md'), path.join(runDir, 'sources.md')];

  for (const filePath of candidates) {
    const content = await fs.readFile(filePath, 'utf8').catch(() => '');
    if (content.trim()) {
      return true;
    }
  }

  const libraryDir = path.join(runDir, 'library');
  const entries = await fs.readdir(libraryDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const content = await fs.readFile(path.join(libraryDir, entry), 'utf8').catch(() => '');
    if (content.trim()) {
      return true;
    }
  }

  return false;
}

function pidfilePath(runDir) {
  return path.join(runDir, 'worker.pid');
}

function writePidfile(runDir) {
  fsSync.writeFileSync(pidfilePath(runDir), String(process.pid), 'utf8');
}

function removePidfile(runDir) {
  try {
    fsSync.unlinkSync(pidfilePath(runDir));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(`[worker] Failed to remove pidfile: ${err.message}`);
    }
  }
}

async function executeRun(runId) {
  let run = await readRun(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  writePidfile(run.runDir);

  const logger = await createLogger(run.logFile);
  let stopRequested = false;
  let activeState = run;
  let abortActiveIteration = null;
  let hardTimeoutTimer = null;

  const onStopSignal = async (signal) => {
    stopRequested = true;
    await logger.write(`[run] received ${signal}, stopping after current operation`);
    await appendRunEvent(runId, 'run.stop_requested', { signal });
    abortActiveIteration?.();
  };

  process.on('SIGTERM', onStopSignal);
  process.on('SIGINT', onStopSignal);

  try {
    const templates = await loadPromptTemplates();
    const startedAt = new Date().toISOString();
    const { count: completedIterations, warning: iterationWarning } =
      await countCompletedIterations(run.runDir, runId);
    if (iterationWarning) {
      await logger.write(iterationWarning);
    }

    activeState = await updateRun(runId, () => ({
      status: 'running',
      startedAt: startedAt,
      pid: process.pid,
      completedIterations,
      error: null,
      errorKind: null,
      errorHint: null,
      errorAction: null,
      exitCode: null,
    }));

    await appendRunEvent(runId, 'run.started', { pid: process.pid });
    await logger.write(`[run] ${runId} started for topic ${activeState.topicSlug}`);
    await logger.write(
      `[run] provider=${activeState.provider} model=${activeState.model || 'default'} iterations=${describeIterations(activeState)} timeout=${activeState.maxMinutes == null ? 'none' : `${activeState.maxMinutes}m`} topic-iteration-offset=${activeState.topicIterationOffset || 0}`
    );

    const startTime = Date.now();
    const hasIterationLimit = activeState.requestedIterations != null;
    const hasTimeLimit = activeState.maxMinutes != null;
    const isOpenEnded = !hasIterationLimit && !hasTimeLimit;
    let lastEval = null;

    function startHardTimeout() {
      clearTimeout(hardTimeoutTimer);
      if (activeState.maxMinutes != null) {
        const remainingMs = Math.max(0, activeState.maxMinutes * 60000 - (Date.now() - startTime));
        hardTimeoutTimer = setTimeout(() => {
          logger.write(`[run] hard timeout reached (${activeState.maxMinutes} min), aborting`);
          appendRunEvent(runId, 'run.time_limit_reached', { hard: true });
          stopRequested = true;
          abortActiveIteration?.();
        }, remainingMs);
      }
    }

    for (
      let iteration = completedIterations + 1;
      !hasIterationLimit || iteration <= activeState.requestedIterations;
      iteration += 1
    ) {
      if (stopRequested) {
        break;
      }

      if (activeState.maxMinutes != null) {
        const elapsedMinutes = (Date.now() - startTime) / 60000;
        if (elapsedMinutes >= activeState.maxMinutes) {
          await logger.write(`[run] time limit reached after ${activeState.maxMinutes} minute(s)`);
          await appendRunEvent(runId, 'run.time_limit_reached', { iteration: iteration - 1 });
          stopRequested = true;
          break;
        }
      }

      if (isOpenEnded) {
        const completed = iteration - 1;
        const elapsedMinutes = (Date.now() - startTime) / 60000;

        if (completed >= MAX_OPEN_ENDED_ITERATIONS) {
          await logger.write(
            `[run] Reached open-ended iteration ceiling (${MAX_OPEN_ENDED_ITERATIONS})`
          );
          await appendRunEvent(runId, 'run.open_ended_ceiling', {
            reason: 'iteration_limit',
            completedIterations: completed,
          });
          break;
        }

        if (elapsedMinutes >= MAX_OPEN_ENDED_MINUTES) {
          await logger.write(
            `[run] Reached open-ended time ceiling (${MAX_OPEN_ENDED_MINUTES} min)`
          );
          await appendRunEvent(runId, 'run.open_ended_ceiling', {
            reason: 'time_limit',
            elapsedMinutes: Math.round(elapsedMinutes),
          });
          break;
        }

        if (
          completed >= MAX_OPEN_ENDED_ITERATIONS * 0.8 ||
          elapsedMinutes >= MAX_OPEN_ENDED_MINUTES * 0.8
        ) {
          await logger.write(`[run] Approaching open-ended ceiling...`);
        }
      }

      const taskPrompt = materializeIterationPrompt(templates.prompt, {
        iteration,
        totalIterations: activeState.requestedIterations,
        topicIteration: topicIterationFor(activeState, iteration),
        outputDir: activeState.runDir,
        priorEval: lastEval,
      });
      const fullPrompt = combineSystemAndTaskPrompt(templates.agents, taskPrompt);

      await fs.writeFile(
        path.join(activeState.runDir, `prompt-${String(iteration).padStart(3, '0')}.md`),
        `${fullPrompt}\n`,
        'utf8'
      );
      await appendRunEvent(runId, 'iteration.started', {
        iteration,
        topicIteration: topicIterationFor(activeState, iteration),
      });
      await logger.write(
        `[run] starting iteration ${hasIterationLimit ? `${iteration}/${activeState.requestedIterations}` : String(iteration)}`
      );

      startHardTimeout();
      let iterationCompleted = false;

      try {
        await runAcpIteration({
          provider: activeState.provider,
          model: activeState.model,
          outputDir: activeState.runDir,
          promptText: fullPrompt,
          log: (message, options) => logger.write(message, options),
          shouldStop: () => stopRequested,
          registerAbort: (abortHandler) => {
            abortActiveIteration = abortHandler;
          },
        });
        iterationCompleted = true;
      } catch (error) {
        if (!stopRequested) {
          throw error;
        }
        await logger.write(`[run] iteration ${iteration} interrupted: ${error.message}`);
      } finally {
        clearTimeout(hardTimeoutTimer);
      }

      const shouldEvaluatePartial =
        stopRequested && (await hasJudgeableArtifacts(activeState.runDir));
      if (iterationCompleted || shouldEvaluatePartial) {
        try {
          const evalRecord = await evaluateRunIteration({
            runId,
            iteration,
            topicIteration: topicIterationFor(activeState, iteration),
            provider: activeState.provider,
            model: activeState.model,
            incompleteIteration: !iterationCompleted,
            log: (message, options) => logger.write(message, options),
            shouldStop: () => false,
            registerAbort: (abortHandler) => {
              abortActiveIteration = abortHandler;
            },
          });
          lastEval = evalRecord;
        } catch (error) {
          lastEval = null;
          await appendRunEvent(runId, 'evaluation.failed', {
            iteration,
            topicIteration: topicIterationFor(activeState, iteration),
            incompleteIteration: !iterationCompleted,
            error: error.message,
          });
          await logger.write(`[judge] failed for iteration ${iteration}: ${error.message}`);
        }
      }

      if (iterationCompleted) {
        activeState = await updateRun(runId, (current) => ({
          completedIterations: Math.max(current.completedIterations || 0, iteration),
        }));
        await appendRunEvent(runId, 'iteration.completed', {
          iteration,
          topicIteration: topicIterationFor(activeState, iteration),
        });
        await logger.write(
          `[run] completed iteration ${hasIterationLimit ? `${iteration}/${activeState.requestedIterations}` : String(iteration)}`
        );
      }
    }

    const endedAt = new Date().toISOString();
    if (stopRequested) {
      activeState = await updateRun(runId, () => ({
        status: 'stopped',
        endedAt,
        exitCode: 0,
        errorKind: null,
        errorHint: null,
        errorAction: null,
      }));
      await appendRunEvent(runId, 'run.stopped', {
        completedIterations: activeState.completedIterations,
      });
      await logger.write(`[run] stopped after ${activeState.completedIterations} iteration(s)`);
      return;
    }

    activeState = await updateRun(runId, () => ({
      status: 'completed',
      endedAt,
      exitCode: 0,
      errorKind: null,
      errorHint: null,
      errorAction: null,
    }));
    await appendRunEvent(runId, 'run.completed', {
      completedIterations: activeState.completedIterations,
    });
    await logger.write(`[run] completed successfully`);
  } catch (error) {
    const endedAt = new Date().toISOString();
    const classified = classifyRunError(error.message, {
      provider: activeState.provider,
      model: activeState.model,
    });
    await updateRun(runId, () => ({
      status: stopRequested ? 'stopped' : 'failed',
      endedAt,
      exitCode: stopRequested ? 0 : 1,
      error: stopRequested ? null : error.message,
      errorKind: stopRequested ? null : classified.errorKind,
      errorHint: stopRequested ? null : classified.errorHint,
      errorAction: stopRequested ? null : classified.errorAction,
    }));
    await appendRunEvent(runId, stopRequested ? 'run.stopped' : 'run.failed', {
      ...(stopRequested
        ? {}
        : {
            error: error.message,
            errorKind: classified.errorKind,
            errorHint: classified.errorHint,
            errorAction: classified.errorAction,
          }),
    });
    await logger.write(`[run] ${stopRequested ? 'stopped' : 'failed'}: ${error.message}`);
    if (stopRequested) {
      return;
    }
    throw error;
  } finally {
    clearTimeout(hardTimeoutTimer);
    process.off('SIGTERM', onStopSignal);
    process.off('SIGINT', onStopSignal);
    removePidfile(activeState.runDir);
    await logger.close();
  }
}

async function main() {
  const { runId } = parseArgs(process.argv.slice(2));
  await executeRun(runId);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
