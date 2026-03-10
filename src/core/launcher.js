import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, updateRun } from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'worker.js');

export async function launchRunDetached(runId, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  if (run.status === 'running') {
    throw new Error(`Run is already running: ${runId}`);
  }

  const child = spawn(process.execPath, [WORKER_PATH, '--run-id', runId], {
    cwd: run.runDir,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const next = await updateRun(runId, () => ({
    status: 'queued',
    pid: child.pid,
  }), env);

  return { run: next, pid: child.pid };
}

export async function launchRunAttached(runId, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH, '--run-id', runId], {
      cwd: run.runDir,
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(code);
        return;
      }
      reject(new Error(`Run exited with code ${code}`));
    });
  });
}

export async function stopRun(runId, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  if (!run.pid) {
    throw new Error(`Run has no recorded pid: ${runId}`);
  }
  if (run.status !== 'running' && run.status !== 'queued') {
    throw new Error(`Run is not active: ${runId}`);
  }

  process.kill(run.pid, 'SIGTERM');
  return run;
}
