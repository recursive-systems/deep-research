#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadPromptTemplates, materializeIterationPrompt, combineSystemAndTaskPrompt } from './prompt.js';
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

async function countCompletedIterations(runDir) {
  const iterationsDir = path.join(runDir, 'iterations');
  const entries = await fs.readdir(iterationsDir).catch(() => []);
  return entries.filter((entry) => entry.endsWith('.md')).length;
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

async function executeRun(runId) {
  let run = await readRun(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  const logger = await createLogger(run.logFile);
  let stopRequested = false;
  let activeState = run;
  let abortActiveIteration = null;

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
    const completedIterations = await countCompletedIterations(run.runDir);

    activeState = await updateRun(runId, () => ({
      status: 'running',
      startedAt: startedAt,
      pid: process.pid,
      completedIterations,
      error: null,
      exitCode: null,
    }));

    await appendRunEvent(runId, 'run.started', { pid: process.pid });
    await logger.write(`[run] ${runId} started for topic ${activeState.topicSlug}`);
    await logger.write(`[run] provider=${activeState.provider} model=${activeState.model || 'default'} iterations=${activeState.requestedIterations}`);

    const startTime = Date.now();
    let hardTimeoutTimer = null;

    function startHardTimeout() {
      clearTimeout(hardTimeoutTimer);
      if (activeState.maxMinutes > 0) {
        const remainingMs = Math.max(0, (activeState.maxMinutes * 60000) - (Date.now() - startTime));
        hardTimeoutTimer = setTimeout(() => {
          logger.write(`[run] hard timeout reached (${activeState.maxMinutes} min), aborting`);
          appendRunEvent(runId, 'run.time_limit_reached', { hard: true });
          stopRequested = true;
          abortActiveIteration?.();
        }, remainingMs);
      }
    }

    for (let iteration = completedIterations + 1; iteration <= activeState.requestedIterations; iteration += 1) {
      if (stopRequested) {
        break;
      }

      if (activeState.maxMinutes > 0) {
        const elapsedMinutes = (Date.now() - startTime) / 60000;
        if (elapsedMinutes >= activeState.maxMinutes) {
          await logger.write(`[run] time limit reached after ${activeState.maxMinutes} minute(s)`);
          await appendRunEvent(runId, 'run.time_limit_reached', { iteration: iteration - 1 });
          stopRequested = true;
          break;
        }
      }

      const taskPrompt = materializeIterationPrompt(templates.prompt, {
        iteration,
        totalIterations: activeState.requestedIterations,
        outputDir: activeState.runDir,
      });
      const fullPrompt = combineSystemAndTaskPrompt(templates.agents, taskPrompt);

      await fs.writeFile(path.join(activeState.runDir, `prompt-${String(iteration).padStart(3, '0')}.md`), `${fullPrompt}\n`, 'utf8');
      await appendRunEvent(runId, 'iteration.started', { iteration });
      await logger.write(`[run] starting iteration ${iteration}/${activeState.requestedIterations}`);

      startHardTimeout();

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

      clearTimeout(hardTimeoutTimer);

      activeState = await updateRun(runId, (current) => ({
        completedIterations: Math.max(current.completedIterations || 0, iteration),
      }));
      await appendRunEvent(runId, 'iteration.completed', { iteration });
      await logger.write(`[run] completed iteration ${iteration}/${activeState.requestedIterations}`);
    }

    const endedAt = new Date().toISOString();
    if (stopRequested) {
      activeState = await updateRun(runId, () => ({
        status: 'stopped',
        endedAt,
        exitCode: 0,
      }));
      await appendRunEvent(runId, 'run.stopped', { completedIterations: activeState.completedIterations });
      await logger.write(`[run] stopped after ${activeState.completedIterations} iteration(s)`);
      return;
    }

    activeState = await updateRun(runId, () => ({
      status: 'completed',
      endedAt,
      exitCode: 0,
    }));
    await appendRunEvent(runId, 'run.completed', { completedIterations: activeState.completedIterations });
    await logger.write(`[run] completed successfully`);
  } catch (error) {
    const endedAt = new Date().toISOString();
    await updateRun(runId, () => ({
      status: stopRequested ? 'stopped' : 'failed',
      endedAt,
      exitCode: stopRequested ? 0 : 1,
      error: stopRequested ? null : error.message,
    }));
    await appendRunEvent(runId, stopRequested ? 'run.stopped' : 'run.failed', {
      ...(stopRequested ? {} : { error: error.message }),
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
