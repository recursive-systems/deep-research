#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { readRunEvaluations } from '../core/evaluator.js';
import { PUBLIC_DIR, getStorePaths } from '../core/config.js';
import {
  createTopic,
  deleteRun,
  deleteTopic,
  ensureTopic,
  listRunFiles,
  listRuns,
  listRunsByStatus,
  listRunsForTopic,
  listTopics,
  readRun,
  readRunFile,
  readRunLog,
  updateRun,
} from '../core/store.js';
import { createRun } from '../core/store.js';
import { launchRunDetached, stopRun } from '../core/launcher.js';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4310);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

// ===== SSE Infrastructure =====

const sseClients = new Set();

function broadcast(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Debounce run broadcasts (stdout.log changes rapidly)
const pendingRunUpdates = new Map();

function scheduleRunBroadcast(runId) {
  if (pendingRunUpdates.has(runId)) return;
  pendingRunUpdates.set(
    runId,
    setTimeout(async () => {
      pendingRunUpdates.delete(runId);
      if (sseClients.size === 0) return;
      try {
        const run = await readRun(runId);
        if (run) broadcast('run:updated', await enrichRun(run));
      } catch (err) {
        if (err?.code !== 'ENOENT' && !(err?.message || '').includes('Unknown run')) {
          console.error(`[sse] Error broadcasting run ${runId}:`, err.message);
        }
      }
    }, 500)
  );
}

function scheduleEvalBroadcast(runId) {
  if (sseClients.size === 0) return;
  setTimeout(async () => {
    try {
      const evaluations = await readRunEvaluations(runId);
      broadcast('run:evaluations', { runId, evaluations });
    } catch (err) {
      if (err?.code !== 'ENOENT' && !(err?.message || '').includes('Unknown run')) {
        console.error(`[sse] Error broadcasting eval ${runId}:`, err.message);
      }
    }
  }, 300);
}

function startRunWatcher() {
  const paths = getStorePaths();
  const runsRoot = paths.runsRoot;

  // Ensure the directory exists before watching
  fs.mkdirSync(runsRoot, { recursive: true });

  try {
    fs.watch(runsRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename || sseClients.size === 0) return;

      // filename is relative to runsRoot, e.g. "run-2026.../run.json"
      const parts = filename.split(path.sep);
      const runId = parts[0];
      if (!runId) return;

      const basename = parts[parts.length - 1];
      if (basename === 'run.json' || basename === 'stdout.log') {
        scheduleRunBroadcast(runId);
      }
      if (basename === 'evaluations.ndjson') {
        scheduleEvalBroadcast(runId);
      }
    });
  } catch (err) {
    // fs.watch with recursive may not be supported on all platforms
    console.error(
      'Warning: fs.watch failed, SSE will rely on API-triggered broadcasts only:',
      err.message
    );
  }
}

// ===== Helpers =====

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new ApiError(400, 'Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new ApiError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeOptionalNumber(value, { min, name }) {
  if (value == null || String(value).trim() === '') {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, `Invalid ${name}: ${value}`);
  }
  if (parsed < min) {
    throw new ApiError(400, `${name} must be at least ${min}`);
  }
  return parsed;
}

function summarizeLogs(logs) {
  const lines = String(logs || '')
    .replaceAll('[acp] stop reason:', '\n[acp] stop reason:')
    .replaceAll('[run] completed iteration', '\n[run] completed iteration')
    .replaceAll('[run] completed successfully', '\n[run] completed successfully')
    .replaceAll('[run] stopped:', '\n[run] stopped:')
    .replaceAll('[run] failed:', '\n[run] failed:')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-12);
  const lastToolLine = [...lines].reverse().find((line) => line.includes('[acp] tool ')) || '';
  const lastAgentLine =
    [...lines]
      .reverse()
      .find(
        (line) => !line.startsWith('[acp]') && !line.startsWith('[run]') && !line.startsWith('-')
      ) || '';
  return {
    lineCount: lines.length,
    tail,
    lastToolLine,
    lastAgentLine,
  };
}

async function enrichRun(run) {
  const logs = await readRunLog(run.id).catch(() => '');
  return {
    ...run,
    summary: summarizeLogs(logs),
  };
}

// ===== API =====

async function handleApi(req, res, url) {
  try {
    // SSE endpoint
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(':\n\n'); // flush comment
      const client = { res };
      sseClients.add(client);
      req.on('close', () => sseClients.delete(client));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/topics') {
      const topics = await listTopics();
      const runs = await Promise.all((await listRuns()).map((run) => enrichRun(run)));
      const latestByTopic = new Map();
      for (const run of runs) {
        if (!latestByTopic.has(run.topicSlug)) {
          latestByTopic.set(run.topicSlug, run);
        }
      }
      return sendJson(res, 200, {
        topics: topics.map((topic) => ({
          ...topic,
          latestRun: latestByTopic.get(topic.slug) || null,
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/topics') {
      const body = await parseBody(req);
      const topic = await createTopic({
        slug: body.slug || '',
        title: body.title || '',
        brief: body.brief,
      });
      broadcast('topic:updated', { action: 'created', topic });
      return sendJson(res, 201, { topic });
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await parseBody(req);
      const { topic } = await ensureTopic({
        slug: body.slug || '',
        title: body.title || '',
        brief: body.brief,
      });
      const run = await createRun({
        topicSlug: topic.slug,
        provider: body.provider || 'claude',
        model: body.model || '',
        iterations: normalizeOptionalNumber(body.iterations, { min: 1, name: 'iterations' }),
        maxMinutes: normalizeOptionalNumber(body.maxMinutes, { min: 1, name: 'maxMinutes' }),
        baseRunId: null,
      });
      const launched = await launchRunDetached(run.id);
      broadcast('topic:updated', { action: 'started', topic });
      broadcast('run:updated', launched.run);
      return sendJson(res, 202, { topic, run: launched.run });
    }

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const runs = await Promise.all((await listRuns()).map((run) => enrichRun(run)));
      return sendJson(res, 200, { runs });
    }

    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const body = await parseBody(req);
      const run = await createRun({
        topicSlug: body.topicSlug,
        provider: body.provider || 'claude',
        model: body.model || '',
        iterations: normalizeOptionalNumber(body.iterations, { min: 1, name: 'iterations' }),
        maxMinutes: normalizeOptionalNumber(body.maxMinutes, { min: 1, name: 'maxMinutes' }),
        baseRunId: body.baseRunId || null,
      });
      const launched = await launchRunDetached(run.id);
      broadcast('topic:updated', { action: 'rerun' });
      broadcast('run:updated', launched.run);
      return sendJson(res, 202, { run: launched.run });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/topics/')) {
      const parts = url.pathname.split('/');
      if (parts.length === 5 && parts[4] === 'runs') {
        const topicSlug = decodeURIComponent(parts[3]);
        return sendJson(res, 200, { runs: await listRunsForTopic(topicSlug) });
      }
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/topics/')) {
      const topicSlug = decodeURIComponent(url.pathname.split('/')[3]);
      const result = await deleteTopic(topicSlug);
      broadcast('topic:updated', { action: 'deleted', slug: topicSlug });
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
      const parts = url.pathname.split('/');
      const runId = decodeURIComponent(parts[3] || parts[2] || '');
      if (!runId) {
        return sendJson(res, 404, { error: 'Run not found' });
      }

      if (parts.length === 4) {
        const run = await readRun(runId);
        if (!run) return sendJson(res, 404, { error: 'Run not found' });
        return sendJson(res, 200, { run: await enrichRun(run) });
      }

      if (parts.length === 5 && parts[4] === 'logs') {
        return sendJson(res, 200, { runId, logs: await readRunLog(runId) });
      }

      if (parts.length === 5 && parts[4] === 'files') {
        return sendJson(res, 200, await listRunFiles(runId));
      }

      if (parts.length === 5 && parts[4] === 'evaluations') {
        return sendJson(res, 200, {
          runId,
          evaluations: await readRunEvaluations(runId),
        });
      }

      if (parts.length === 5 && parts[4] === 'file') {
        const relPath = url.searchParams.get('path') || '';
        return sendJson(res, 200, {
          runId,
          path: relPath,
          content: await readRunFile(runId, relPath),
        });
      }
    }

    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/api/runs/') &&
      url.pathname.endsWith('/stop')
    ) {
      const runId = decodeURIComponent(url.pathname.split('/')[3]);
      await stopRun(runId);
      broadcast('run:updated', await enrichRun(await readRun(runId)));
      return sendJson(res, 200, { ok: true, runId });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/runs/')) {
      const runId = decodeURIComponent(url.pathname.split('/')[3]);
      await deleteRun(runId);
      broadcast('topic:updated', { action: 'run_deleted', runId });
      return sendJson(res, 200, { deleted: runId });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return sendJson(res, error.status, { error: error.message });
    }
    // Classify known store/launcher errors as 400/404/409
    const msg = error.message || '';
    if (/not found|unknown (run|topic)/i.test(msg)) {
      return sendJson(res, 404, { error: msg });
    }
    if (/already exists|already running|cannot delete running/i.test(msg)) {
      return sendJson(res, 409, { error: msg });
    }
    if (
      /unsupported provider|invalid|must contain|unable to derive|cannot delete|has no recorded pid|is not active|file path escapes/i.test(
        msg
      )
    ) {
      return sendJson(res, 400, { error: msg });
    }
    // Unexpected error — log and return 500
    console.error('[api] Unexpected error:', error);
    return sendJson(res, 500, { error: 'Internal server error' });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let requestPath = url.pathname;
  if (requestPath === '/') requestPath = '/index.html';
  const relative = path
    .normalize(requestPath)
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^[/\\]+/, '');
  const absolute = path.join(PUBLIC_DIR, relative);
  const resolved = path.resolve(absolute);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return sendText(res, 404, 'Not found');
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

async function cleanupStaleTempDirs() {
  const paths = getStorePaths();
  const evalTmpDir = path.join(paths.home, 'tmp', 'evaluations');

  let entries;
  try {
    entries = fs.readdirSync(evalTmpDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  const maxAgeMs = 2 * 60 * 60 * 1000; // 2 hours
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(evalTmpDir, entry.name);
    try {
      const stat = fs.statSync(dirPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`[cleanup] Removed stale temp dir: ${entry.name}`);
      }
    } catch (err) {
      console.warn(`[cleanup] Failed to process temp dir ${entry.name}: ${err.message}`);
    }
  }
}

async function cleanupStaleRuns() {
  const staleRuns = await listRunsByStatus('running');
  const now = Date.now();
  for (const run of staleRuns) {
    // Grace period: skip runs updated (or created) less than 30 seconds ago
    const lastActivity = run.updatedAt || run.createdAt;
    const lastActivityMs = lastActivity ? new Date(lastActivity).getTime() : 0;
    if (now - lastActivityMs < 30_000) continue;

    // Determine PID: prefer the worker.pid file (written by the actual worker)
    // over run.pid (set by the launcher, which may be stale)
    let checkPid = run.pid;
    if (run.runDir) {
      const pidFile = path.join(run.runDir, 'worker.pid');
      try {
        const pidContent = fs.readFileSync(pidFile, 'utf8').trim();
        const parsed = Number.parseInt(pidContent, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          checkPid = parsed;
        }
      } catch {
        // pidfile doesn't exist or unreadable — fall back to run.pid
      }
    }

    let alive = false;
    if (checkPid) {
      try {
        process.kill(checkPid, 0);
        alive = true;
      } catch (err) {
        if (err.code === 'EPERM') {
          // Process exists but we lack permission to signal it
          alive = true;
        }
        // ESRCH means process doesn't exist — alive stays false
      }
    }
    if (!alive) {
      await updateRun(run.id, () => ({
        status: 'failed',
        error: 'Process died unexpectedly',
        errorKind: 'zombie',
        errorHint: 'Worker process exited without updating run status',
        errorAction: 'Resume the run to continue',
      }));
      console.log(
        `[cleanup] Marked stale run ${run.id} as failed (PID ${checkPid} no longer running)`
      );
    }
  }
}

async function main() {
  // Clean up runs whose worker processes died without updating status
  await cleanupStaleRuns();

  // Clean up stale temp evaluation directories
  await cleanupStaleTempDirs();
  setInterval(cleanupStaleTempDirs, 30 * 60 * 1000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        console.error('[api] Unhandled error in API handler:', err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal server error' });
        }
      });
      return;
    }
    serveStatic(req, res, url);
  });

  // Start SSE keepalive pings
  setInterval(() => {
    for (const client of sseClients) {
      try {
        client.res.write(':\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 30_000);

  // Start filesystem watcher for live updates
  startRunWatcher();

  server.listen(PORT, HOST, () => {
    process.stdout.write(`Deep Research dashboard listening on http://${HOST}:${PORT}\n`);
  });
}

main();
