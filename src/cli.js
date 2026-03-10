#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createTopic, createRun, deleteRun, ensureStore, ensureTopic, listRuns, listTopics, readRun, readRunLog, readTopic } from './core/store.js';
import { getRuntimeHome } from './core/config.js';
import { launchRunAttached, launchRunDetached, stopRun } from './core/launcher.js';

function parseFlags(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      positionals.push(current);
      continue;
    }

    const flag = current.slice(2);
    if (flag === 'detach' || flag === 'json' || flag === 'follow') {
      flags[flag] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for --${flag}`);
    }
    flags[flag] = value;
    index += 1;
  }

  return { flags, positionals };
}

function printUsage() {
  process.stdout.write(`Deep Research CLI

Usage:
  deep-research topic create --brief-file <path>
  deep-research topic create --brief "<text>"
  deep-research topic list
  deep-research start --brief "<text>" [--provider claude|codex|zai] [--iterations N] [--max-minutes M] [--model NAME] [--detach]
  deep-research run <topic-slug> [--iterations N] [--max-minutes M] [--provider claude|codex|zai] [--model NAME] [--detach]
  deep-research resume <run-id> [--iterations N] [--max-minutes M] [--provider claude|codex|zai] [--model NAME] [--detach]
  deep-research list
  deep-research status <run-id>
  deep-research logs <run-id> [--follow]
  deep-research stop <run-id>
  deep-research delete <run-id>
  deep-research serve

Environment:
  DEEP_RESEARCH_HOME  Override runtime data directory (default: ${getRuntimeHome()})
  ZAI_API_KEY         Required when --provider zai
`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

async function readBrief(flags) {
  if (flags['brief-file']) {
    return fs.readFile(path.resolve(flags['brief-file']), 'utf8');
  }
  if (flags.brief) {
    return String(flags.brief);
  }
  throw new Error('Provide --brief-file or --brief');
}

async function runCreateTopic(positionals, flags) {
  const topic = await createTopic({
    slug: flags.slug || positionals[0] || '',
    title: flags.title || '',
    brief: await readBrief(flags),
  });
  if (flags.json) {
    printJson({ topic });
    return;
  }
  process.stdout.write(`Created topic ${topic.slug} (${topic.title})\n`);
}

async function runTopicList(flags) {
  const topics = await listTopics();
  if (flags.json) {
    printJson({ topics });
    return;
  }
  for (const topic of topics) {
    process.stdout.write(`${topic.slug}\t${topic.title}\tlatest=${topic.latestRunId || '-'}\n`);
  }
}

async function runLaunch(topicSlug, flags, { baseRunId = null } = {}) {
  const run = await createRun({
    topicSlug,
    provider: flags.provider || 'claude',
    model: flags.model || '',
    iterations: normalizeNumber(flags.iterations, 1),
    maxMinutes: normalizeNumber(flags['max-minutes'], 0),
    baseRunId,
  });

  if (flags.detach) {
    const launched = await launchRunDetached(run.id);
    if (flags.json) {
      printJson({ run: launched.run, detached: true });
      return;
    }
    process.stdout.write(`Queued ${run.id} for topic ${topicSlug}\n`);
    return;
  }

  if (flags.json) {
    printJson({ run, detached: false });
  }
  await launchRunAttached(run.id);
}

async function runStart(flags) {
  const { topic } = await ensureTopic({
    slug: flags.slug || '',
    title: flags.title || '',
    brief: await readBrief(flags),
  });

  const run = await createRun({
    topicSlug: topic.slug,
    provider: flags.provider || 'claude',
    model: flags.model || '',
    iterations: normalizeNumber(flags.iterations, 1),
    maxMinutes: normalizeNumber(flags['max-minutes'], 0),
    baseRunId: null,
  });

  if (flags.detach) {
    const launched = await launchRunDetached(run.id);
    if (flags.json) {
      printJson({ topic, run: launched.run, detached: true });
      return;
    }
    process.stdout.write(`Started topic ${topic.slug} with run ${run.id}\n`);
    return;
  }

  if (flags.json) {
    printJson({ topic, run, detached: false });
  }
  await launchRunAttached(run.id);
}

async function runResume(positionals, flags) {
  const baseRunId = positionals[0];
  if (!baseRunId) {
    throw new Error('Missing run id to resume');
  }
  const baseRun = await readRun(baseRunId);
  if (!baseRun) {
    throw new Error(`Unknown run: ${baseRunId}`);
  }
  await runLaunch(baseRun.topicSlug, flags, { baseRunId });
}

async function runList(flags) {
  const runs = await listRuns();
  if (flags.json) {
    printJson({ runs });
    return;
  }
  for (const run of runs) {
    process.stdout.write(`${run.id}\t${run.topicSlug}\t${run.status}\t${run.completedIterations}/${run.requestedIterations}\n`);
  }
}

async function runStatus(positionals, flags) {
  const identifier = positionals[0];
  if (!identifier) {
    throw new Error('Missing run id');
  }
  const run = await readRun(identifier);
  if (run) {
    if (flags.json) {
      printJson({ run });
      return;
    }
    process.stdout.write(`${run.id}\n`);
    process.stdout.write(`topic: ${run.topicSlug}\nstatus: ${run.status}\niterations: ${run.completedIterations}/${run.requestedIterations}\nprovider: ${run.provider}\nmodel: ${run.model || '-'}\n`);
    return;
  }

  const topic = await readTopic(identifier);
  if (!topic) {
    throw new Error(`Unknown run or topic: ${identifier}`);
  }
  if (flags.json) {
    printJson({ topic });
    return;
  }
  process.stdout.write(`${topic.slug}\n`);
  process.stdout.write(`title: ${topic.title}\nlatestRunId: ${topic.latestRunId || '-'}\n`);
}

async function runLogs(positionals, flags) {
  const runId = positionals[0];
  if (!runId) {
    throw new Error('Missing run id');
  }
  let previous = '';
  while (true) {
    const current = await readRunLog(runId);
    if (current !== previous) {
      process.stdout.write(current.slice(previous.length));
      previous = current;
    }
    if (!flags.follow) {
      break;
    }
    const run = await readRun(runId);
    if (!run || !['running', 'queued'].includes(run.status)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function runStop(positionals, flags) {
  const runId = positionals[0];
  if (!runId) {
    throw new Error('Missing run id');
  }
  const run = await stopRun(runId);
  if (flags.json) {
    printJson({ runId: run.id, stopped: true });
    return;
  }
  process.stdout.write(`Stopped ${run.id}\n`);
}

async function runDelete(positionals, flags) {
  const runId = positionals[0];
  if (!runId) {
    throw new Error('Missing run id');
  }
  await deleteRun(runId);
  if (flags.json) {
    printJson({ deleted: runId });
    return;
  }
  process.stdout.write(`Deleted ${runId}\n`);
}

async function runServe() {
  const module = await import('./server/server.js');
  return module;
}

async function main() {
  await ensureStore();
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const command = argv[0];
  const { flags, positionals } = parseFlags(argv.slice(1));

  if (command === 'topic') {
    const subcommand = positionals.shift();
    if (subcommand === 'create') {
      await runCreateTopic(positionals, flags);
      return;
    }
    if (subcommand === 'list') {
      await runTopicList(flags);
      return;
    }
    throw new Error(`Unknown topic subcommand: ${subcommand}`);
  }

  if (command === 'run') {
    const topicSlug = positionals[0];
    if (!topicSlug) {
      throw new Error('Missing topic slug');
    }
    await runLaunch(topicSlug, flags);
    return;
  }

  if (command === 'start') {
    await runStart(flags);
    return;
  }

  if (command === 'resume') {
    await runResume(positionals, flags);
    return;
  }

  if (command === 'list') {
    await runList(flags);
    return;
  }

  if (command === 'status') {
    await runStatus(positionals, flags);
    return;
  }

  if (command === 'logs') {
    await runLogs(positionals, flags);
    return;
  }

  if (command === 'stop') {
    await runStop(positionals, flags);
    return;
  }

  if (command === 'delete') {
    await runDelete(positionals, flags);
    return;
  }

  if (command === 'serve') {
    await runServe();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
