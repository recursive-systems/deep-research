#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { PUBLIC_DIR } from '../core/config.js';
import { createTopic, deleteRun, deleteTopic, ensureTopic, listRunFiles, listRuns, listRunsForTopic, listTopics, readRun, readRunFile, readRunLog } from '../core/store.js';
import { createRun } from '../core/store.js';
import { launchRunDetached, stopRun } from '../core/launcher.js';

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
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
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
    throw new Error(`Invalid ${name}: ${value}`);
  }
  if (parsed < min) {
    throw new Error(`${name} must be at least ${min}`);
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
  const lastAgentLine = [...lines].reverse().find((line) => !line.startsWith('[acp]') && !line.startsWith('[run]') && !line.startsWith('-')) || '';
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

async function handleApi(req, res, url) {
  try {
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

      if (parts.length === 5 && parts[4] === 'file') {
        const relPath = url.searchParams.get('path') || '';
        return sendJson(res, 200, {
          runId,
          path: relPath,
          content: await readRunFile(runId, relPath),
        });
      }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/stop')) {
      const runId = decodeURIComponent(url.pathname.split('/')[3]);
      await stopRun(runId);
      return sendJson(res, 200, { ok: true, runId });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/runs/')) {
      const runId = decodeURIComponent(url.pathname.split('/')[3]);
      await deleteRun(runId);
      return sendJson(res, 200, { deleted: runId });
    }
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let requestPath = url.pathname;
  if (requestPath === '/') requestPath = '/index.html';
  const relative = path.normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
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

function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(`Deep Research dashboard listening on http://${HOST}:${PORT}\n`);
  });
}

main();
