import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getStorePaths, PROVIDER_BINARIES, PROVIDER_DEFAULT_MODELS } from './config.js';

function safeSlug(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.slice(0, 64);
}

function firstMeaningfulLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function deriveTopicTitleFromBrief(brief) {
  const firstLine = firstMeaningfulLine(brief);
  if (!firstLine) {
    throw new Error('Brief must contain at least one non-empty line');
  }
  return firstLine.slice(0, 120);
}

function deriveTopicSlugFromBrief(brief) {
  const title = deriveTopicTitleFromBrief(brief);
  const slug = safeSlug(title);
  if (!slug) {
    throw new Error('Unable to derive slug from brief');
  }
  return slug;
}

function ensureTopicSlug(value) {
  const slug = safeSlug(value);
  if (!slug) {
    throw new Error('Topic slug must contain letters or numbers');
  }
  return slug;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeProvider(value) {
  const provider = String(value || 'claude').trim().toLowerCase();
  if (!Object.hasOwn(PROVIDER_BINARIES, provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return provider;
}

function makeRunId() {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `run-${stamp}-${suffix}`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function appendJsonLine(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function listDirectories(root) {
  await ensureDir(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function findLatestExistingRunForTopic(topicSlug, env = process.env) {
  const runs = await listRunsForTopic(topicSlug, env);
  return runs[0] || null;
}

async function copyStateFromBaseRun(baseRun, targetRunDir) {
  const filesToCopy = ['brief.md', 'report.md', 'sources.md'];
  for (const fileName of filesToCopy) {
    const source = path.join(baseRun.runDir, fileName);
    if (await exists(source)) {
      await fs.copyFile(source, path.join(targetRunDir, fileName));
    }
  }

  for (const dirName of ['library']) {
    const sourceDir = path.join(baseRun.runDir, dirName);
    if (await exists(sourceDir)) {
      await fs.cp(sourceDir, path.join(targetRunDir, dirName), { recursive: true });
    }
  }
}

export async function ensureStore(env = process.env) {
  const paths = getStorePaths(env);
  await Promise.all([
    ensureDir(paths.home),
    ensureDir(paths.topicsRoot),
    ensureDir(paths.runsRoot),
    ensureDir(paths.tmpRoot),
  ]);
  return paths;
}

export async function createTopic({ slug, title, brief }, env = process.env) {
  const paths = await ensureStore(env);
  const normalizedBrief = `${String(brief || '').trim()}\n`;
  const topicSlug = slug
    ? ensureTopicSlug(slug)
    : deriveTopicSlugFromBrief(normalizedBrief);
  const topicDir = path.join(paths.topicsRoot, topicSlug);
  const topicFile = path.join(topicDir, 'topic.json');

  const createdAt = nowIso();
  const topic = {
    id: topicSlug,
    slug: topicSlug,
    title: String(title || deriveTopicTitleFromBrief(normalizedBrief)),
    createdAt,
    updatedAt: createdAt,
    latestRunId: null,
  };

  try {
    await fs.mkdir(topicDir);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Topic already exists: ${topicSlug}`);
    }
    throw error;
  }

  try {
    await writeJson(topicFile, topic);
    await fs.writeFile(path.join(topicDir, 'brief.md'), normalizedBrief, 'utf8');
    return topic;
  } catch (error) {
    await fs.rm(topicDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function ensureTopic({ slug, title, brief }, env = process.env) {
  try {
    const topic = await createTopic({ slug, title, brief }, env);
    return { topic, created: true };
  } catch (error) {
    const message = String(error?.message || '');
    if (!message.startsWith('Topic already exists: ')) {
      throw error;
    }

    const existingSlug = message.slice('Topic already exists: '.length).trim();
    const topic = await readTopic(existingSlug, env);
    if (!topic) {
      throw error;
    }
    return { topic, created: false };
  }
}

export async function readTopic(slug, env = process.env) {
  const paths = await ensureStore(env);
  const topicSlug = ensureTopicSlug(slug);
  const topicFile = path.join(paths.topicsRoot, topicSlug, 'topic.json');
  if (!await exists(topicFile)) {
    return null;
  }
  return readJson(topicFile);
}

export async function listTopics(env = process.env) {
  const paths = await ensureStore(env);
  const slugs = await listDirectories(paths.topicsRoot);
  const topics = [];
  for (const slug of slugs) {
    const topic = await readTopic(slug, env);
    if (topic) topics.push(topic);
  }
  return topics.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function deleteTopic(slug, env = process.env) {
  const paths = await ensureStore(env);
  const topicSlug = ensureTopicSlug(slug);
  const topicDir = path.join(paths.topicsRoot, topicSlug);
  if (!await exists(topicDir)) {
    throw new Error(`Topic not found: ${topicSlug}`);
  }

  const runs = await listRuns(env);
  const topicRuns = runs.filter((r) => r.topicSlug === topicSlug);
  const runningRuns = topicRuns.filter((r) => r.status === 'running');
  if (runningRuns.length > 0) {
    throw new Error(`Cannot delete topic with running runs: ${topicSlug}`);
  }

  for (const run of topicRuns) {
    await fs.rm(run.runDir, { recursive: true, force: true });
  }

  await fs.rm(topicDir, { recursive: true, force: true });
  return { slug: topicSlug, deletedRuns: topicRuns.length };
}

export async function updateTopic(slug, updater, env = process.env) {
  const paths = await ensureStore(env);
  const topicSlug = ensureTopicSlug(slug);
  const topicFile = path.join(paths.topicsRoot, topicSlug, 'topic.json');
  const current = await readJson(topicFile);
  const next = {
    ...current,
    ...updater(current),
    updatedAt: nowIso(),
  };
  await writeJson(topicFile, next);
  return next;
}

export async function readTopicBrief(slug, env = process.env) {
  const paths = await ensureStore(env);
  const topicSlug = ensureTopicSlug(slug);
  return fs.readFile(path.join(paths.topicsRoot, topicSlug, 'brief.md'), 'utf8');
}

export async function createRun({
  topicSlug,
  provider,
  model,
  iterations,
  maxMinutes,
  baseRunId = null,
}, env = process.env) {
  const topic = await readTopic(topicSlug, env);
  if (!topic) {
    throw new Error(`Unknown topic: ${topicSlug}`);
  }

  const paths = await ensureStore(env);
  const runId = makeRunId();
  const runDir = path.join(paths.runsRoot, runId);
  await ensureDir(runDir);
  await ensureDir(path.join(runDir, 'iterations'));
  await ensureDir(path.join(runDir, 'library'));

  const preferredBaseRunId = baseRunId || topic.latestRunId || null;
  let baseRun = preferredBaseRunId ? await readRun(preferredBaseRunId, env) : null;
  if (!baseRun && !baseRunId) {
    baseRun = await findLatestExistingRunForTopic(topic.slug, env);
  }
  if (baseRunId && !baseRun) {
    throw new Error(`Base run not found: ${baseRunId}`);
  }

  if (baseRun) {
    await copyStateFromBaseRun(baseRun, runDir);
  } else {
    const brief = await readTopicBrief(topic.slug, env);
    await fs.writeFile(path.join(runDir, 'brief.md'), `${brief.trim()}\n`, 'utf8');
    await fs.writeFile(path.join(runDir, 'report.md'), '', 'utf8');
    await fs.writeFile(path.join(runDir, 'sources.md'), '', 'utf8');
  }

  const createdAt = nowIso();
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = String(model || PROVIDER_DEFAULT_MODELS[normalizedProvider] || '').trim();
  const run = {
    id: runId,
    topicSlug: topic.slug,
    topicTitle: topic.title,
    status: 'created',
    provider: normalizedProvider,
    model: normalizedModel,
    requestedIterations: Number(iterations || 1),
    completedIterations: 0,
    maxMinutes: Number(maxMinutes || 0),
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    endedAt: null,
    pid: null,
    exitCode: null,
    error: null,
    baseRunId: baseRun?.id || null,
    runDir,
    logFile: path.join(runDir, 'stdout.log'),
    eventsFile: path.join(runDir, 'events.ndjson'),
  };

  await writeJson(path.join(runDir, 'run.json'), run);
  await appendJsonLine(run.eventsFile, {
    timestamp: createdAt,
    type: 'run.created',
    runId,
    topicSlug: topic.slug,
  });

  await updateTopic(topic.slug, (current) => ({
    latestRunId: runId,
    lastBaseRunId: baseRun?.id || current.lastBaseRunId || null,
  }), env);

  return run;
}

export async function readRun(runId, env = process.env) {
  const paths = await ensureStore(env);
  const runDir = path.join(paths.runsRoot, runId);
  const runFile = path.join(runDir, 'run.json');
  if (!await exists(runFile)) {
    return null;
  }
  return readJson(runFile);
}

export async function updateRun(runId, updater, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  const next = {
    ...run,
    ...updater(run),
    updatedAt: nowIso(),
  };
  await writeJson(path.join(run.runDir, 'run.json'), next);
  return next;
}

export async function appendRunEvent(runId, type, payload = {}, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  await appendJsonLine(run.eventsFile, {
    timestamp: nowIso(),
    type,
    runId,
    ...payload,
  });
}

export async function listRuns(env = process.env) {
  const paths = await ensureStore(env);
  const ids = await listDirectories(paths.runsRoot);
  const runs = [];
  for (const id of ids) {
    const run = await readRun(id, env);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function listRunsForTopic(topicSlug, env = process.env) {
  const runs = await listRuns(env);
  const slug = ensureTopicSlug(topicSlug);
  return runs.filter((run) => run.topicSlug === slug);
}

export async function readRunLog(runId, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  if (!await exists(run.logFile)) {
    return '';
  }
  return fs.readFile(run.logFile, 'utf8');
}

export async function deleteRun(runId, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  if (run.status === 'running') {
    throw new Error(`Cannot delete running run: ${runId}`);
  }
  await fs.rm(run.runDir, { recursive: true, force: true });
  const latestRemaining = await findLatestExistingRunForTopic(run.topicSlug, env);
  await updateTopic(run.topicSlug, (current) => ({
    latestRunId: current.latestRunId === runId ? latestRemaining?.id || null : current.latestRunId,
    lastBaseRunId: current.lastBaseRunId === runId ? latestRemaining?.baseRunId || null : current.lastBaseRunId,
  }), env);
  return run;
}

export async function listRunFiles(runId, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  const files = {
    runId,
    topFiles: [],
    iterations: [],
    library: [],
  };

  for (const fileName of ['brief.md', 'report.md', 'sources.md', 'stdout.log', 'run.json', 'events.ndjson']) {
    if (await exists(path.join(run.runDir, fileName))) {
      files.topFiles.push(fileName);
    }
  }

  const iterationDir = path.join(run.runDir, 'iterations');
  if (await exists(iterationDir)) {
    const entries = await fs.readdir(iterationDir);
    files.iterations = entries.filter((entry) => entry.endsWith('.md')).sort().map((entry) => `iterations/${entry}`);
  }

  const libraryDir = path.join(run.runDir, 'library');
  if (await exists(libraryDir)) {
    const entries = await fs.readdir(libraryDir);
    files.library = entries.filter((entry) => entry.endsWith('.md')).sort().map((entry) => `library/${entry}`);
  }

  return files;
}

export async function readRunFile(runId, relativePath, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  const normalized = path.posix.normalize(String(relativePath || '')).replace(/^\/+/, '');
  const allowedTopLevel = new Set(['brief.md', 'report.md', 'sources.md', 'stdout.log', 'run.json', 'events.ndjson']);
  let absolutePath = null;

  if (allowedTopLevel.has(normalized)) {
    absolutePath = path.join(run.runDir, normalized);
  } else {
    const parts = normalized.split('/');
    if (parts.length === 2 && (parts[0] === 'iterations' || parts[0] === 'library') && parts[1].endsWith('.md')) {
      absolutePath = path.join(run.runDir, parts[0], parts[1]);
    }
  }

  if (!absolutePath) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }

  const resolved = path.resolve(absolutePath);
  if (!resolved.startsWith(path.resolve(run.runDir) + path.sep)) {
    throw new Error(`File path escapes run directory: ${relativePath}`);
  }
  return fs.readFile(resolved, 'utf8');
}
