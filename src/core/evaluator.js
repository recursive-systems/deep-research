import fs from 'node:fs/promises';
import path from 'node:path';
import { PROMPTS_DIR, getStorePaths } from './config.js';
import { runAcpIteration } from './acp-runner.js';
import { appendJsonLine, appendRunEvent, readRun } from './store.js';

const EVALUATION_PROMPT_FILE = path.join(PROMPTS_DIR, 'PROMPT_evaluate.md');
const RUBRIC_VERSION = 'research-v2';
const MODEL_SCORE_KEYS = [
  'brief_coverage',
  'directness',
  'coherence',
  'citation_coverage',
  'source_quality',
  'specificity',
  'brevity',
  'uncertainty_honesty',
  'support_confidence',
];
const SCORE_KEYS = [...MODEL_SCORE_KEYS, 'source_resolvability'];
const SOURCE_AUDIT_TIMEOUT_MS = 4000;
const SOURCE_AUDIT_MAX_ENTRIES = 12;
const SOURCE_AUDIT_USER_AGENT = 'deep-research-evaluator/0.1';

function wordCount(text) {
  const matches = String(text || '')
    .trim()
    .match(/\b[\p{L}\p{N}'-]+\b/gu);
  return matches ? matches.length : 0;
}

function sourceCount(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s/.test(line)).length;
}

function citationStats(text) {
  const matches = [...String(text || '').matchAll(/\[(\d+)\]/g)].map((match) =>
    Number.parseInt(match[1], 10)
  );
  return {
    total: matches.length,
    unique: new Set(matches.filter(Number.isFinite)).size,
  };
}

function safeScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(1, Math.min(5, Math.round(num)));
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return null;
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(2));
}

function normalizeStringArray(value, limit = 3) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function fencedBlock(label, content) {
  const normalized = String(content || '').trim();
  return [`## ${label}`, '```text', normalized || '(empty)', '```'].join('\n');
}

function citedSourceIds(report) {
  return [
    ...new Set(
      [...String(report || '').matchAll(/\[(\d+)\]/g)]
        .map((match) => Number.parseInt(match[1], 10))
        .filter(Number.isFinite)
    ),
  ].sort((a, b) => a - b);
}

function parseSources(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\.\s+(.*)$/);
      if (!match) return null;
      const index = Number.parseInt(match[1], 10);
      const body = match[2].trim();
      const linkMatch = body.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/i);
      const fallbackUrlMatch = body.match(/\bhttps?:\/\/\S+/i);
      const rawUrl = linkMatch?.[2] || fallbackUrlMatch?.[0] || '';
      const title =
        linkMatch?.[1] ||
        body
          .replace(/\s+-\s+.*$/, '')
          .replace(/\bhttps?:\/\/\S+/gi, '')
          .trim();
      const description = body.includes(' - ')
        ? body
            .split(/\s+-\s+/)
            .slice(1)
            .join(' - ')
            .trim()
        : '';
      return {
        index,
        title,
        description,
        url: rawUrl,
        raw: line,
      };
    })
    .filter(Boolean);
}

function summarizeAuditStatus(entry) {
  const status = entry.status || 'unknown';
  if (status === 'resolved') {
    return `resolved${entry.httpStatus ? ` (${entry.httpStatus})` : ''}`;
  }
  if (status === 'restricted') {
    return `reachable but restricted${entry.httpStatus ? ` (${entry.httpStatus})` : ''}`;
  }
  if (status === 'redirected') {
    return `resolved via redirect${entry.httpStatus ? ` (${entry.httpStatus})` : ''}`;
  }
  if (status === 'missing_url') return 'no URL provided';
  if (status === 'invalid_url') return 'invalid URL';
  if (status === 'not_found') return 'not found (404)';
  if (status === 'http_error') {
    return `HTTP error${entry.httpStatus ? ` (${entry.httpStatus})` : ''}`;
  }
  if (status === 'timeout') return 'timed out';
  if (status === 'network_error') return `network error${entry.error ? `: ${entry.error}` : ''}`;
  return status;
}

function computeSourceResolvabilityScore(audit) {
  if (!audit.auditableCount) return 3;
  const resolvable = audit.resolvableCount + audit.restrictedCount;
  const ratio = resolvable / audit.auditableCount;
  if (ratio >= 0.95) return 5;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio > 0) return 2;
  return 1;
}

function mergeHighlights(base, additions, limit = 3) {
  const seen = new Set();
  const merged = [];
  for (const item of [...base, ...additions]) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(text);
    if (merged.length >= limit) break;
  }
  return merged;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SOURCE_AUDIT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': SOURCE_AUDIT_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      ...options,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function auditSourceUrl(source) {
  if (!source.url) {
    return {
      ...source,
      status: 'missing_url',
      httpStatus: null,
      finalUrl: '',
      host: '',
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(source.url);
  } catch {
    return {
      ...source,
      status: 'invalid_url',
      httpStatus: null,
      finalUrl: '',
      host: '',
    };
  }

  const base = {
    ...source,
    finalUrl: source.url,
    host: parsedUrl.host,
  };

  const classifyResponse = (response, method) => {
    const finalUrl = response.url || source.url;
    const finalHost = (() => {
      try {
        return new URL(finalUrl).host;
      } catch {
        return parsedUrl.host;
      }
    })();
    const redirected = finalUrl !== source.url;
    const status = response.status;
    if (response.ok) {
      return {
        ...base,
        status: redirected ? 'redirected' : 'resolved',
        httpStatus: status,
        finalUrl,
        host: finalHost,
        method,
      };
    }
    if (status === 401 || status === 403) {
      return {
        ...base,
        status: 'restricted',
        httpStatus: status,
        finalUrl,
        host: finalHost,
        method,
      };
    }
    if (status === 404) {
      return {
        ...base,
        status: 'not_found',
        httpStatus: status,
        finalUrl,
        host: finalHost,
        method,
      };
    }
    return {
      ...base,
      status: 'http_error',
      httpStatus: status,
      finalUrl,
      host: finalHost,
      method,
    };
  };

  try {
    const headResponse = await fetchWithTimeout(source.url, { method: 'HEAD' });
    if (headResponse.status === 405 || headResponse.status === 501) {
      const getResponse = await fetchWithTimeout(source.url, { method: 'GET' });
      return classifyResponse(getResponse, 'GET');
    }
    return classifyResponse(headResponse, 'HEAD');
  } catch (error) {
    if (error?.name === 'AbortError') {
      return {
        ...base,
        status: 'timeout',
        httpStatus: null,
        error: 'request timed out',
      };
    }
    return {
      ...base,
      status: 'network_error',
      httpStatus: null,
      error: error?.message ? String(error.message) : 'network request failed',
    };
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  return results;
}

async function buildSourceAudit({ report, sources }) {
  const entries = parseSources(sources);
  const cited = new Set(citedSourceIds(report));
  const prioritized = [
    ...entries.filter((entry) => cited.has(entry.index)),
    ...entries.filter((entry) => !cited.has(entry.index)),
  ];
  const entriesToAudit = prioritized.slice(0, SOURCE_AUDIT_MAX_ENTRIES);
  const auditedEntries = await mapWithConcurrency(entriesToAudit, 4, (entry) =>
    auditSourceUrl({
      ...entry,
      cited: cited.has(entry.index),
    })
  );

  const auditableCount = auditedEntries.filter((entry) => entry.status !== 'missing_url').length;
  const resolvableCount = auditedEntries.filter(
    (entry) => entry.status === 'resolved' || entry.status === 'redirected'
  ).length;
  const restrictedCount = auditedEntries.filter((entry) => entry.status === 'restricted').length;
  const unresolvedCount = auditedEntries.filter((entry) =>
    ['invalid_url', 'not_found', 'http_error', 'timeout', 'network_error'].includes(entry.status)
  ).length;

  return {
    totalSources: entries.length,
    citedSourceCount: cited.size,
    auditedCount: auditedEntries.length,
    auditableCount,
    resolvableCount,
    restrictedCount,
    unresolvedCount,
    score: computeSourceResolvabilityScore({
      auditableCount,
      resolvableCount,
      restrictedCount,
    }),
    entries: auditedEntries,
  };
}

function sourceAuditBlock(audit) {
  if (!audit.auditedCount) {
    return fencedBlock('Source Audit', 'No sources were available for audit.');
  }

  const summary = [
    `Audited ${audit.auditedCount} source entries (${audit.auditableCount} with URLs).`,
    `Resolvable: ${audit.resolvableCount}. Restricted: ${audit.restrictedCount}. Unresolved: ${audit.unresolvedCount}.`,
  ];
  const details = audit.entries.map((entry) => {
    const prefix = entry.cited ? '*' : '-';
    return `${prefix} [${entry.index}] ${entry.title || '(untitled)'} :: ${summarizeAuditStatus(entry)}${entry.url ? ` :: ${entry.url}` : ''}`;
  });
  return fencedBlock('Source Audit', [...summary, '', ...details].join('\n'));
}

function materializeEvaluationPrompt(
  template,
  {
    iteration,
    topicIteration,
    provider,
    model,
    brief,
    report,
    sources,
    latestIteration,
    sourceAudit,
  }
) {
  return template
    .replaceAll('{{ITERATION}}', String(iteration))
    .replaceAll('{{TOPIC_ITERATION}}', String(topicIteration))
    .replaceAll('{{PROVIDER}}', String(provider))
    .replaceAll('{{MODEL}}', String(model || 'default'))
    .replaceAll('{{BRIEF_BLOCK}}', fencedBlock('Brief', brief))
    .replaceAll('{{REPORT_BLOCK}}', fencedBlock('Report', report))
    .replaceAll('{{SOURCES_BLOCK}}', fencedBlock('Sources', sources))
    .replaceAll('{{SOURCE_AUDIT_BLOCK}}', sourceAuditBlock(sourceAudit))
    .replaceAll(
      '{{LATEST_ITERATION_BLOCK}}',
      latestIteration ? fencedBlock('Latest Iteration Log', latestIteration) : ''
    )
    .trim();
}

async function loadEvaluationPrompt() {
  return fs.readFile(EVALUATION_PROMPT_FILE, 'utf8');
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function createWorkspace(run, iteration, env = process.env) {
  const padded = String(iteration).padStart(3, '0');
  const root = path.join(getStorePaths(env).tmpRoot, 'evaluations');
  await ensureDir(root);
  const workspaceDir = await fs.mkdtemp(path.join(root, `${run.id}-${padded}-`));
  const filesToCopy = [
    ['brief.md', 'brief.md'],
    ['report.md', 'report.md'],
    ['sources.md', 'sources.md'],
    [path.join('iterations', `${padded}.md`), 'latest-iteration.md'],
  ];

  for (const [sourceRelative, targetRelative] of filesToCopy) {
    const source = path.join(run.runDir, sourceRelative);
    if (await pathExists(source)) {
      await ensureDir(path.dirname(path.join(workspaceDir, targetRelative)));
      await fs.copyFile(source, path.join(workspaceDir, targetRelative));
    }
  }

  return workspaceDir;
}

function evaluationMetrics({ report, sources }) {
  const citations = citationStats(report);
  return {
    reportWords: wordCount(report),
    reportChars: String(report || '').length,
    sourceCount: sourceCount(sources),
    citationMentions: citations.total,
    uniqueCitations: citations.unique,
  };
}

function normalizeEvaluationPayload(raw, fallbackOverall) {
  const scoresMissing = !raw?.scores || typeof raw.scores !== 'object';
  if (scoresMissing) {
    console.warn(
      "[evaluator] WARNING: Agent output missing 'scores' object entirely — using fallback scores"
    );
  }

  const scores = Object.fromEntries(
    MODEL_SCORE_KEYS.map((key) => [key, safeScore(raw?.scores?.[key])])
  );
  const nullCount = Object.values(scores).filter((v) => v === null).length;
  if (!scoresMissing && nullCount >= 5) {
    console.warn(
      `[evaluator] WARNING: ${nullCount}/9 score keys missing or invalid — agent may have used wrong format`
    );
  }

  const normalizedScores = Object.fromEntries(
    Object.entries(scores).map(([key, value]) => [key, value ?? 1])
  );
  const modelOverall = Number(
    (Number.isFinite(Number(raw?.overall))
      ? Number(raw.overall)
      : (fallbackOverall ?? average(Object.values(normalizedScores)) ?? 1)
    ).toFixed(2)
  );

  return {
    modelOverall: Math.max(1, Math.min(5, modelOverall)),
    scores: normalizedScores,
    summary: String(raw?.summary || '')
      .trim()
      .slice(0, 400),
    strengths: normalizeStringArray(raw?.strengths),
    weaknesses: normalizeStringArray(raw?.weaknesses),
  };
}

function artifactFileName(iteration, evaluatedAt, ext) {
  const padded = String(iteration).padStart(3, '0');
  const stamp = evaluatedAt.replace(/[:.]/g, '-');
  return `${padded}-${stamp}.${ext}`;
}

function extractInlineArtifact(text, fileName, fenceLanguage) {
  const normalized = String(text || '').replace(/\[judge\]\s*/g, '');
  const escapedFileName = fileName.replace('.', '\\.');
  const escapedFence = fenceLanguage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\`?${escapedFileName}\`?[\\s\\S]*?\`\`\`${escapedFence}\\s*([\\s\\S]*?)\`\`\``,
    'i'
  );
  const match = normalized.match(pattern);
  return match?.[1]?.trim() || '';
}

async function readEvaluationArtifacts(workspaceDir, judgeMessages) {
  let rawEvaluation = await readOptionalFile(path.join(workspaceDir, 'evaluation.json'));
  let judgment = await readOptionalFile(path.join(workspaceDir, 'judgment.md'));

  if (rawEvaluation && judgment) {
    return { rawEvaluation, judgment };
  }

  const joined = judgeMessages.join('');
  if (!rawEvaluation) {
    rawEvaluation = extractInlineArtifact(joined, 'evaluation.json', 'json');
    if (rawEvaluation) {
      await fs.writeFile(path.join(workspaceDir, 'evaluation.json'), `${rawEvaluation}\n`, 'utf8');
    }
  }

  if (!judgment) {
    judgment = extractInlineArtifact(joined, 'judgment.md', 'md');
    if (judgment) {
      await fs.writeFile(path.join(workspaceDir, 'judgment.md'), `${judgment}\n`, 'utf8');
    }
  }

  if (!rawEvaluation) {
    throw new Error(
      `ENOENT: no such file or directory, open '${path.join(workspaceDir, 'evaluation.json')}'`
    );
  }

  return { rawEvaluation, judgment };
}

export async function readRunEvaluations(runId, env = process.env) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  const traceFile = path.join(run.runDir, 'evaluations.ndjson');
  if (!(await pathExists(traceFile))) {
    return [];
  }

  const raw = await fs.readFile(traceFile, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      if ((a.iteration || 0) !== (b.iteration || 0)) {
        return (a.iteration || 0) - (b.iteration || 0);
      }
      return String(a.evaluatedAt || '').localeCompare(String(b.evaluatedAt || ''));
    });
}

export { safeScore, normalizeEvaluationPayload, extractInlineArtifact };

export async function evaluateRunIteration(
  {
    runId,
    iteration,
    topicIteration,
    provider,
    model,
    incompleteIteration = false,
    log,
    shouldStop = () => false,
    registerAbort = () => {},
  },
  env = process.env
) {
  const run = await readRun(runId, env);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }

  const workspaceDir = await createWorkspace(run, iteration, env);
  const promptTemplate = await loadEvaluationPrompt();
  const [brief, report, sources, latestIteration] = await Promise.all([
    readOptionalFile(path.join(run.runDir, 'brief.md')),
    readOptionalFile(path.join(run.runDir, 'report.md')),
    readOptionalFile(path.join(run.runDir, 'sources.md')),
    readOptionalFile(
      path.join(run.runDir, 'iterations', `${String(iteration).padStart(3, '0')}.md`)
    ),
  ]);
  const sourceAudit = await buildSourceAudit({ report, sources });
  const promptText = materializeEvaluationPrompt(promptTemplate, {
    iteration,
    topicIteration,
    provider,
    model,
    brief,
    report,
    sources,
    latestIteration,
    sourceAudit,
  });

  await fs.writeFile(path.join(workspaceDir, 'judge-prompt.md'), `${promptText}\n`, 'utf8');
  await appendRunEvent(runId, 'evaluation.started', { iteration, topicIteration }, env);
  const judgeMessages = [];
  const judgeLog = (message, options) => {
    judgeMessages.push(String(message || ''));
    log(`[judge] ${message}`, options);
  };

  try {
    await runAcpIteration({
      provider,
      model,
      outputDir: workspaceDir,
      promptText,
      log: judgeLog,
      shouldStop,
      registerAbort,
    });

    const { rawEvaluation, judgment } = await readEvaluationArtifacts(workspaceDir, judgeMessages);

    const parsed = JSON.parse(rawEvaluation);
    const metrics = {
      ...evaluationMetrics({ report, sources }),
      auditedSources: sourceAudit.auditedCount,
      auditableSources: sourceAudit.auditableCount,
      resolvableSources: sourceAudit.resolvableCount,
      restrictedSources: sourceAudit.restrictedCount,
      unresolvedSources: sourceAudit.unresolvedCount,
      citedSources: sourceAudit.citedSourceCount,
    };
    const fallbackOverall = average(
      MODEL_SCORE_KEYS.map((key) => safeScore(parsed?.scores?.[key])).filter(Number.isFinite)
    );
    const normalized = normalizeEvaluationPayload(parsed, fallbackOverall);
    const scores = {
      ...normalized.scores,
      source_resolvability: sourceAudit.score,
    };
    const overall =
      average(SCORE_KEYS.map((key) => scores[key]).filter(Number.isFinite)) ??
      normalized.modelOverall;
    const strengths = mergeHighlights(
      normalized.strengths,
      sourceAudit.auditableCount > 0 && sourceAudit.unresolvedCount === 0
        ? [
            `${sourceAudit.resolvableCount + sourceAudit.restrictedCount}/${sourceAudit.auditableCount || sourceAudit.auditedCount} audited URLs resolved`,
          ]
        : []
    );
    const weaknesses = mergeHighlights(
      normalized.weaknesses,
      sourceAudit.unresolvedCount > 0
        ? [
            `${sourceAudit.unresolvedCount} audited URL${sourceAudit.unresolvedCount === 1 ? '' : 's'} unresolved`,
          ]
        : []
    );
    const evaluatedAt = new Date().toISOString();
    const artifactsDir = path.join(run.runDir, 'evaluations');
    await ensureDir(artifactsDir);

    const jsonFileName = artifactFileName(iteration, evaluatedAt, 'json');
    const mdFileName = artifactFileName(iteration, evaluatedAt, 'md');
    const record = {
      schemaVersion: 2,
      rubricVersion: RUBRIC_VERSION,
      runId,
      topicSlug: run.topicSlug,
      iteration,
      topicIteration,
      provider,
      model: model || run.model || '',
      incompleteIteration: Boolean(incompleteIteration),
      evaluatedAt,
      overall,
      modelOverall: normalized.modelOverall,
      scores,
      summary: normalized.summary,
      strengths,
      weaknesses,
      metrics,
      sourceAudit,
      artifacts: {
        json: `evaluations/${jsonFileName}`,
        markdown: `evaluations/${mdFileName}`,
      },
    };

    await Promise.all([
      fs.writeFile(
        path.join(artifactsDir, jsonFileName),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8'
      ),
      fs.writeFile(
        path.join(artifactsDir, mdFileName),
        `${String(judgment || '').trim()}\n`,
        'utf8'
      ),
      appendJsonLine(path.join(run.runDir, 'evaluations.ndjson'), record),
      appendRunEvent(
        runId,
        'evaluation.completed',
        {
          iteration,
          topicIteration,
          incompleteIteration: record.incompleteIteration,
          overall: record.overall,
        },
        env
      ),
    ]);

    log(
      `[judge] recorded evaluation for iteration ${iteration}${record.incompleteIteration ? ' (partial)' : ''} (overall ${record.overall}/5)`
    );
    return record;
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}
