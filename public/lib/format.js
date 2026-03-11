export const PROVIDER_DEFAULT_MODELS = {
  claude: 'sonnet',
  codex: 'gpt-5.4',
  zai: 'zai/glm-5',
};

export const EVAL_CRITERIA = [
  ['brief_coverage', 'Brief'],
  ['directness', 'Direct'],
  ['coherence', 'Coherent'],
  ['citation_coverage', 'Citations'],
  ['source_quality', 'Sources'],
  ['source_resolvability', 'Resolvable'],
  ['specificity', 'Specific'],
  ['brevity', 'Brevity'],
  ['uncertainty_honesty', 'Honest'],
  ['support_confidence', 'Support'],
];

export const EVAL_SERIES = [
  { key: 'overall', label: 'Overall', color: '#ff6b35' },
  { key: 'brief_coverage', label: 'Brief', color: '#f59e0b' },
  { key: 'directness', label: 'Direct', color: '#f97316' },
  { key: 'coherence', label: 'Coherent', color: '#22c55e' },
  { key: 'citation_coverage', label: 'Citations', color: '#38bdf8' },
  { key: 'source_quality', label: 'Sources', color: '#60a5fa' },
  { key: 'source_resolvability', label: 'Resolvable', color: '#06b6d4' },
  { key: 'specificity', label: 'Specific', color: '#a78bfa' },
  { key: 'brevity', label: 'Brevity', color: '#f472b6' },
  { key: 'uncertainty_honesty', label: 'Honest', color: '#84cc16' },
  { key: 'support_confidence', label: 'Support', color: '#fb7185' },
];

export function esc(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function fmtDate(v) {
  return v ? new Date(v).toLocaleString() : '-';
}

export function fmtScore(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '-';
}

export function fmtDuration(run) {
  if (!run.startedAt) return '-';
  const ms = (run.endedAt ? new Date(run.endedAt) : new Date()) - new Date(run.startedAt);
  const s = Math.max(Math.round(ms / 1000), 0);
  const m = Math.floor(s / 60);
  return m === 0 ? `${s}s` : `${m}m ${s % 60}s`;
}

export function pct(run) {
  if (run.requestedIterations == null) return null;
  const t = Math.max(run.requestedIterations || 0, 1);
  return Math.max(0, Math.min(100, Math.round(((run.completedIterations || 0) / t) * 100)));
}

export function fmtIterations(run) {
  return run.requestedIterations == null
    ? `${run.completedIterations} / open-ended`
    : `${run.completedIterations} / ${run.requestedIterations}`;
}

export function fmtTopicIterations(run) {
  const offset = Number(run.topicIterationOffset || 0);
  const current = offset + Number(run.completedIterations || 0);
  if (run.requestedIterations == null) return `${current} / open-ended`;
  return `${current} / ${offset + run.requestedIterations}`;
}

export function fmtTimeout(run) {
  return run.maxMinutes == null ? 'none' : `${run.maxMinutes} min`;
}

export function isActive(run) {
  return run.status === 'running' || run.status === 'queued';
}

export function parseOptionalInt(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function defaultModelFor(provider) {
  return PROVIDER_DEFAULT_MODELS[provider] || '';
}
