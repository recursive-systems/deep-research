#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');
const DEFAULT_TIMEOUT_MS = 180000;
const PROVIDERS = ['claude', 'codex', 'zai'];

function parseArgs(argv) {
  const options = {
    provider: 'all',
    keepOutput: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--provider':
        options.provider = argv[++i] || '';
        break;
      case '--keep-output':
        options.keepOutput = true;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number.parseInt(argv[++i] || '', 10) || DEFAULT_TIMEOUT_MS;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function providersFor(value) {
  if (value === 'all') return [...PROVIDERS];
  if (PROVIDERS.includes(value)) return [value];
  throw new Error(`Unsupported provider: ${value}`);
}

function providerLabel(provider) {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'ZAI';
}

function buildBrief(provider) {
  const label = providerLabel(provider);
  if (provider === 'zai') {
    return [
      `${label} Smoke Topic`,
      'This is a local-only smoke test.',
      'Do not use web research, web fetch, shell commands, or any external tools.',
      'Work only with the files already present in the run directory.',
      `Write a very short report confirming the ${label} smoke test ran.`,
      'Write sources.md with exactly one item: "1. Internal smoke test - no external sources."',
      `Create one library markdown file mentioning ${label}.`,
      'Write iterations/001.md and end immediately.',
      'Do not broaden the topic or choose a different research topic.',
    ].join('\n');
  }

  return [
    `${label} Smoke Topic`,
    'This is a smoke test.',
    'Do not use web research or external tools beyond the allowed filesystem operations.',
    `Read the local files and write a very short report confirming the ${label} smoke test ran.`,
    'Write sources.md with exactly one item: "1. Internal smoke test - no external sources."',
    `Create one library markdown file mentioning ${label}.`,
    'Write iterations/001.md and end.',
  ].join('\n');
}

function ensureProviderEnv(provider) {
  if (provider === 'zai' && !process.env.ZAI_API_KEY) {
    throw new Error('ZAI_API_KEY is required for smoke provider zai');
  }
}

function runCli(args, env, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`CLI timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`CLI exited with code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });
}

async function readJsonFromCli(args, env, timeoutMs) {
  const { stdout } = await runCli(args, env, timeoutMs);
  return JSON.parse(stdout);
}

async function waitForCompletion(runId, env, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const statusPayload = await readJsonFromCli(['status', runId, '--json'], env, Math.min(timeoutMs, 30000));
    const status = statusPayload.run.status;
    if (status !== lastStatus) {
      console.log(`status=${status}`);
      lastStatus = status;
    } else {
      process.stdout.write('.');
    }
    if (status === 'completed' || status === 'failed' || status === 'stopped') {
      if (lastStatus) {
        process.stdout.write('\n');
      }
      return statusPayload.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function verifyRun(provider, run) {
  const reportPath = path.join(run.runDir, 'report.md');
  const sourcesPath = path.join(run.runDir, 'sources.md');
  const iterationPath = path.join(run.runDir, 'iterations', '001.md');
  const libraryEntries = await fs.readdir(path.join(run.runDir, 'library'));
  const libraryFiles = libraryEntries.filter((entry) => entry.endsWith('.md'));

  const [report, sources, iteration] = await Promise.all([
    fs.readFile(reportPath, 'utf8'),
    fs.readFile(sourcesPath, 'utf8'),
    fs.readFile(iterationPath, 'utf8'),
  ]);

  if (libraryFiles.length === 0) {
    throw new Error(`No library markdown files were written for ${provider}`);
  }

  const libraryPath = path.join(run.runDir, 'library', libraryFiles[0]);
  const library = await fs.readFile(libraryPath, 'utf8');

  const checks = [
    ['completed status', run.status === 'completed'],
    ['exit code 0', run.exitCode === 0],
    ['report written', report.trim().length > 0],
    ['expected source line', sources.includes('1. Internal smoke test - no external sources.')],
    ['iteration heading', iteration.includes('# Iteration 1')],
    ['provider mentioned in library', library.toLowerCase().includes(provider)],
  ];

  const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failures.length > 0) {
    throw new Error(`Smoke verification failed for ${provider}: ${failures.join(', ')}`);
  }

  return {
    report,
    sources,
    iteration,
    libraryPath,
    library,
  };
}

async function runSmoke(provider, options) {
  ensureProviderEnv(provider);
  const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), `deep-research-smoke-${provider}-`));
  const env = {
    ...process.env,
    DEEP_RESEARCH_HOME: runtimeHome,
  };

  try {
    const createPayload = await readJsonFromCli([
      'topic',
      'create',
      '--brief',
      buildBrief(provider),
      '--json',
    ], env, options.timeoutMs);

    const topic = createPayload.topic;
    const expectedSlug = `${provider}-smoke-topic`;
    if (topic.slug !== expectedSlug) {
      throw new Error(`Expected slug ${expectedSlug} but got ${topic.slug}`);
    }
    console.log(`topic=${topic.slug}`);

    const runPayload = await readJsonFromCli([
      'run',
      topic.slug,
      '--provider',
      provider,
      '--iterations',
      '1',
      '--detach',
      '--json',
    ], env, options.timeoutMs);
    console.log(`run=${runPayload.run.id}`);

    const run = await waitForCompletion(runPayload.run.id, env, options.timeoutMs);
    const verified = await verifyRun(provider, run);

    console.log(`PASS ${provider} ${run.id}`);
    console.log(`topic=${topic.slug}`);
    console.log(`library=${verified.libraryPath}`);
    return { runtimeHome, topic, run, verified };
  } catch (error) {
    console.error(`FAIL ${provider}`);
    console.error(error.message);
    console.error(`Runtime retained at: ${runtimeHome}`);
    throw error;
  } finally {
    if (!options.keepOutput) {
      await fs.rm(runtimeHome, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const providers = providersFor(options.provider);

  for (const provider of providers) {
    await runSmoke(provider, options);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
