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
  return (
    String(value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ''
  );
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
  const provider = String(value || 'claude')
    .trim()
    .toLowerCase();
  if (!Object.hasOwn(PROVIDER_BINARIES, provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return provider;
}

function normalizeRunConstraints({ iterations, maxMinutes }) {
  const normalizedIterations = iterations == null || iterations === '' ? null : Number(iterations);
  const normalizedMaxMinutes = maxMinutes == null || maxMinutes === '' ? null : Number(maxMinutes);

  if (
    normalizedIterations != null &&
    (!Number.isInteger(normalizedIterations) || normalizedIterations < 1)
  ) {
    throw new Error(`Invalid iterations: ${iterations}`);
  }
  if (
    normalizedMaxMinutes != null &&
    (!Number.isInteger(normalizedMaxMinutes) || normalizedMaxMinutes < 1)
  ) {
    throw new Error(`Invalid maxMinutes: ${maxMinutes}`);
  }

  return {
    iterations: normalizedIterations,
    maxMinutes: normalizedMaxMinutes,
  };
}

function makeRunId() {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `run-${stamp}-${suffix}`;
}

async function withFileLock(lockPath, fn) {
  const maxWait = 2000;
  const interval = 50;
  let waited = 0;

  while (true) {
    try {
      await fs.writeFile(lockPath, `${process.pid}`, { flag: 'wx' });
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      // Check if the process holding the lock is still alive
      try {
        const rawPid = await fs.readFile(lockPath, 'utf8');
        const pid = Number(rawPid.trim());
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            // Process is alive (or EPERM) — keep waiting
          } catch (killErr) {
            if (killErr?.code === 'ESRCH') {
              // Process no longer exists — stale lock
              console.warn(
                `[store] Removing stale lock file ${lockPath} (PID ${pid} no longer running)`
              );
              await fs.unlink(lockPath).catch(() => {});
              continue;
            }
            // EPERM means process exists but different user — keep waiting
          }
        }
      } catch (readErr) {
        // Lock file disappeared between EEXIST and read — retry
        if (readErr?.code === 'ENOENT') continue;
      }

      if (waited >= maxWait) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, interval));
      waited += interval;
    }
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch((err) => {
      console.error(`[store] WARNING: Failed to remove lock file ${lockPath}: ${err.message}`);
    });
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
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

export async function appendJsonLine(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const buffer = Buffer.from(JSON.stringify(value) + '\n');
  const fileHandle = await fs.open(filePath, 'a');
  try {
    await fileHandle.write(buffer);
  } finally {
    await fileHandle.close();
  }
}

async function listDirectories(root) {
  await ensureDir(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function findLatestExistingRunForTopic(topicSlug, env = process.env) {
  const runs = await listRunsForTopic(topicSlug, env);
  return runs[0] || null;
}

async function getRunTopicIterationOffset(run, env = process.env) {
  if (!run) {
    return 0;
  }
  if (Number.isInteger(run.topicIterationOffset) && run.topicIterationOffset >= 0) {
    return run.topicIterationOffset;
  }
  if (!run.baseRunId) {
    return 0;
  }
  const baseRun = await readRun(run.baseRunId, env);
  if (!baseRun) {
    return 0;
  }
  return (
    (await getRunTopicIterationOffset(baseRun, env)) + Number(baseRun.completedIterations || 0)
  );
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
  const topicSlug = slug ? ensureTopicSlug(slug) : deriveTopicSlugFromBrief(normalizedBrief);
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
    await fs.rm(topicDir, { recursive: true, force: true }).catch((cleanupErr) => {
      console.error(
        `[store] WARNING: Failed to clean up partial topic dir ${topicDir}: ${cleanupErr.message}`
      );
    });
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
  if (!(await exists(topicFile))) {
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
  if (!(await exists(topicDir))) {
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
  const topicDir = path.join(paths.topicsRoot, topicSlug);
  const lockPath = path.join(topicDir, '.lock');

  return withFileLock(lockPath, async () => {
    const topicFile = path.join(topicDir, 'topic.json');
    const current = await readJson(topicFile);
    const next = {
      ...current,
      ...updater(current),
      updatedAt: nowIso(),
    };
    await writeJson(topicFile, next);
    return next;
  });
}

export async function readTopicBrief(slug, env = process.env) {
  const paths = await ensureStore(env);
  const topicSlug = ensureTopicSlug(slug);
  return fs.readFile(path.join(paths.topicsRoot, topicSlug, 'brief.md'), 'utf8');
}

export async function createRun(
  { topicSlug, provider, model, iterations, maxMinutes, baseRunId = null },
  env = process.env
) {
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
  const constraints = normalizeRunConstraints({ iterations, maxMinutes });
  const topicIterationOffset = baseRun
    ? (await getRunTopicIterationOffset(baseRun, env)) + Number(baseRun.completedIterations || 0)
    : 0;
  const run = {
    id: runId,
    topicSlug: topic.slug,
    topicTitle: topic.title,
    status: 'created',
    provider: normalizedProvider,
    model: normalizedModel,
    requestedIterations: constraints.iterations,
    completedIterations: 0,
    maxMinutes: constraints.maxMinutes,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    endedAt: null,
    pid: null,
    exitCode: null,
    error: null,
    errorKind: null,
    errorHint: null,
    errorAction: null,
    baseRunId: baseRun?.id || null,
    topicIterationOffset,
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

  await updateTopic(
    topic.slug,
    (current) => ({
      latestRunId: runId,
      lastBaseRunId: baseRun?.id || current.lastBaseRunId || null,
    }),
    env
  );

  return run;
}

export async function readRun(runId, env = process.env) {
  const paths = await ensureStore(env);
  const runDir = path.join(paths.runsRoot, runId);
  const runFile = path.join(runDir, 'run.json');
  if (!(await exists(runFile))) {
    return null;
  }
  return readJson(runFile);
}

export async function updateRun(runId, updater, env = process.env) {
  const paths = await ensureStore(env);
  const runDir = path.join(paths.runsRoot, runId);

  // Verify the run exists before trying to acquire the lock
  const runFile = path.join(runDir, 'run.json');
  if (!(await exists(runFile))) {
    throw new Error(`Unknown run: ${runId}`);
  }

  const lockPath = path.join(runDir, '.lock');
  return withFileLock(lockPath, async () => {
    const run = await readJson(runFile);
    const next = {
      ...run,
      ...updater(run),
      updatedAt: nowIso(),
    };
    await writeJson(runFile, next);
    return next;
  });
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

export async function listRunsByStatus(status, env = process.env) {
  const runs = await listRuns(env);
  return runs.filter((run) => run.status === status);
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
  if (!(await exists(run.logFile))) {
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
  await updateTopic(
    run.topicSlug,
    (current) => ({
      latestRunId:
        current.latestRunId === runId ? latestRemaining?.id || null : current.latestRunId,
      lastBaseRunId:
        current.lastBaseRunId === runId
          ? latestRemaining?.baseRunId || null
          : current.lastBaseRunId,
    }),
    env
  );
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
    evaluations: [],
  };

  for (const fileName of [
    'brief.md',
    'report.md',
    'sources.md',
    'stdout.log',
    'run.json',
    'events.ndjson',
    'evaluations.ndjson',
  ]) {
    if (await exists(path.join(run.runDir, fileName))) {
      files.topFiles.push(fileName);
    }
  }

  const iterationDir = path.join(run.runDir, 'iterations');
  if (await exists(iterationDir)) {
    const entries = await fs.readdir(iterationDir);
    files.iterations = entries
      .filter((entry) => entry.endsWith('.md'))
      .sort()
      .map((entry) => `iterations/${entry}`);
  }

  const libraryDir = path.join(run.runDir, 'library');
  if (await exists(libraryDir)) {
    const entries = await fs.readdir(libraryDir);
    files.library = entries
      .filter((entry) => entry.endsWith('.md'))
      .sort()
      .map((entry) => `library/${entry}`);
  }

  const evaluationsDir = path.join(run.runDir, 'evaluations');
  if (await exists(evaluationsDir)) {
    const entries = await fs.readdir(evaluationsDir);
    files.evaluations = entries
      .filter((entry) => entry.endsWith('.md') || entry.endsWith('.json'))
      .sort()
      .map((entry) => `evaluations/${entry}`);
  }

  return files;
}

export async function readRunFile(runId, relativePath, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  const normalized = path.posix.normalize(String(relativePath || '')).replace(/^\/+/, '');
  const allowedTopLevel = new Set([
    'brief.md',
    'report.md',
    'sources.md',
    'stdout.log',
    'run.json',
    'events.ndjson',
    'evaluations.ndjson',
  ]);
  let absolutePath = null;

  if (allowedTopLevel.has(normalized)) {
    absolutePath = path.join(run.runDir, normalized);
  } else {
    const parts = normalized.split('/');
    if (
      parts.length === 2 &&
      ((parts[0] === 'iterations' && parts[1].endsWith('.md')) ||
        (parts[0] === 'library' && parts[1].endsWith('.md')) ||
        (parts[0] === 'evaluations' && (parts[1].endsWith('.md') || parts[1].endsWith('.json'))))
    ) {
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
