import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
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

  const next = await updateRun(
    runId,
    () => ({
      status: 'queued',
      pid: child.pid,
    }),
    env
  );

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

  const pidfile = path.join(run.runDir, 'worker.pid');
  let pidfileContent;
  try {
    pidfileContent = fsSync.readFileSync(pidfile, 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Pidfile gone — worker already exited.
      const updated = await updateRun(
        runId,
        () => ({
          status: 'stopped',
          endedAt: new Date().toISOString(),
          exitCode: 0,
        }),
        env
      );
      return updated;
    }
    // Other errors (EACCES, EIO, etc.) — log and fall through to kill by run.pid
    console.error(`[stopRun] Failed to read pidfile for ${runId}: ${err.message}`);
  }

  if (Number(pidfileContent) !== run.pid) {
    console.error(
      `[stopRun] PID mismatch for ${runId}: pidfile=${pidfileContent}, run.json=${run.pid} — skipping SIGTERM`
    );
    const updated = await updateRun(
      runId,
      () => ({
        status: 'stopped',
        endedAt: new Date().toISOString(),
        error: 'PID mismatch — worker may have already exited',
        errorKind: 'pid_mismatch',
      }),
      env
    );
    return updated;
  }

  process.kill(run.pid, 'SIGTERM');
  return run;
}
