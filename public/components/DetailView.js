import { html } from '../lib/html.js';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { api } from '../lib/api.js';
import {
  fmtDate,
  fmtDuration,
  fmtIterations,
  fmtTopicIterations,
  fmtTimeout,
  isActive,
} from '../lib/format.js';
import { EvalSection } from './EvalSection.js';
import { FileExplorer } from './FileExplorer.js';

function StatusDot({ status }) {
  return html`<span class="status"
    ><span class=${`dot ${status || ''}`}></span>${status || '-'}</span
  >`;
}

function MetaGrid({ run }) {
  return html`
    <div class="detail-grid">
      <div class="detail-cell">
        <div class="detail-cell__label">Status</div>
        <div class="detail-cell__value"><${StatusDot} status=${run.status} /></div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Iterations</div>
        <div class="detail-cell__value">${fmtIterations(run)}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Topic Iterations</div>
        <div class="detail-cell__value">${fmtTopicIterations(run)}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Timeout</div>
        <div class="detail-cell__value">${fmtTimeout(run)}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Provider</div>
        <div class="detail-cell__value">${run.provider}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Model</div>
        <div class="detail-cell__value">${run.model || 'default'}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Started</div>
        <div class="detail-cell__value">${fmtDate(run.startedAt)}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Duration</div>
        <div class="detail-cell__value">${fmtDuration(run)}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Log Lines</div>
        <div class="detail-cell__value">${run.summary?.lineCount || 0}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-cell__label">Last Tool</div>
        <div class="detail-cell__value" style=${{ fontSize: '11px' }}>
          ${run.summary?.lastToolLine || '-'}
        </div>
      </div>
    </div>
  `;
}

function ErrorPanel({ run }) {
  if (run.status !== 'failed' || (!run.errorHint && !run.error)) return null;

  const title =
    run.errorKind === 'provider_auth'
      ? 'Authentication Required'
      : run.errorKind === 'provider_startup'
        ? 'Provider Startup Failure'
        : 'Run Failed';

  return html`
    <div class="error-panel">
      <div class="error-panel__header">
        <div class="error-panel__title">${title}</div>
        ${run.errorKind && html`<span class="tag">${run.errorKind}</span>`}
      </div>
      ${run.errorHint && html`<div class="error-panel__hint">${run.errorHint}</div>`}
      ${run.errorAction && html`<div class="error-panel__action">${run.errorAction}</div>`}
      <details class="error-panel__raw">
        <summary>Raw error</summary>
        <pre>${run.error || ''}</pre>
      </details>
    </div>
  `;
}

function RunPicker({ runs, selectedRunId, onSelectRun }) {
  if (runs.length <= 1) return null;

  return html`
    <div class="run-picker">
      <select
        class="run-picker__select"
        value=${selectedRunId}
        onChange=${(e) => onSelectRun(e.target.value)}
      >
        ${runs.map((r, index) => {
          const label = index === 0 ? 'Latest' : `Run ${runs.length - index}`;
          const date = r.startedAt ? new Date(r.startedAt).toLocaleDateString() : '';
          const time = r.startedAt
            ? new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';
          return html`
            <option key=${r.id} value=${r.id}>
              ${`${label} \u2014 ${r.status} \u2014 ${r.provider} \u2014 topic ${fmtTopicIterations(r)} \u2014 ${date} ${time} \u2014 ${fmtDuration(r)}`}
            </option>
          `;
        })}
      </select>
    </div>
  `;
}

function LogTail({ run, onFullLog }) {
  const tail = (run.summary?.tail || []).join('\n');

  return html`
    <div class="tail-section">
      <div class="tail-header">
        <div class="tail-label"><span class="live-indicator"></span> Live Tail</div>
        <button class="btn btn--ghost btn--xs" onClick=${onFullLog}>Full Log</button>
      </div>
      <pre class="tail-content">${tail}</pre>
    </div>
  `;
}

export function DetailView({
  topic,
  runs,
  selectedRunId,
  onSelectRun,
  onRerun,
  onStop,
  onDelete,
  evalCache,
}) {
  const [evaluations, setEvaluations] = useState([]);
  const [evalError, setEvalError] = useState(null);
  const selectLogFileRef = useRef(null);

  const run = useMemo(
    () => runs.find((r) => r.id === selectedRunId) || null,
    [runs, selectedRunId]
  );
  const running = run && isActive(run);
  const hasAnyActive = runs.some(isActive);

  // Fetch evaluations when run changes (or use cache)
  useEffect(() => {
    if (!run) return;
    if (evalCache && evalCache[run.id]) {
      setEvaluations(evalCache[run.id]);
      setEvalError(null);
      return;
    }
    let cancelled = false;
    api(`/api/runs/${encodeURIComponent(run.id)}/evaluations`)
      .then((payload) => {
        if (!cancelled) {
          setEvaluations(payload.evaluations || []);
          setEvalError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setEvaluations([]);
          setEvalError(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [run?.id, run?.completedIterations, evalCache]);

  if (!run) {
    return html`
      <div class="view container">
        <div class="detail-topline">
          <div class="detail-topline__info">
            <h1>${topic.title}</h1>
            <p>${topic.slug} · ${runs.length} run${runs.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <div class="empty-state">
          <div class="empty-state__icon">${'\u25B7'}</div>
          <div class="empty-state__text">No runs yet for this research</div>
        </div>
      </div>
    `;
  }

  const onFullLog = () => {
    if (selectLogFileRef.current) selectLogFileRef.current();
  };

  return html`
    <div class="view container">
      <div class="detail-topline">
        <div class="detail-topline__info">
          <h1>${topic.title}</h1>
          <p>${topic.slug} · ${runs.length} run${runs.length !== 1 ? 's' : ''}</p>
        </div>
        <div class="detail-topline__actions">
          <button class="btn btn--primary btn--sm" onClick=${() => onRerun(topic.slug, run)}>
            Rerun
          </button>
          ${running &&
          html`
            <button class="btn btn--ghost btn--sm" onClick=${() => onStop(run.id)}>Stop</button>
          `}
          ${!hasAnyActive &&
          html`
            <button
              class="btn btn--danger btn--sm"
              onClick=${() => {
                if (confirm(`Delete "${topic.title}" and all ${runs.length} run(s)?`)) {
                  onDelete(topic.slug);
                }
              }}
            >
              Delete Research
            </button>
          `}
        </div>
      </div>

      <${RunPicker} runs=${runs} selectedRunId=${selectedRunId} onSelectRun=${onSelectRun} />
      <${MetaGrid} run=${run} />
      <${ErrorPanel} run=${run} />
      <${EvalSection} runId=${run.id} evaluations=${evaluations} error=${evalError} />
      <${LogTail} run=${run} onFullLog=${onFullLog} />
      <${FileExplorer} runId=${run.id} onSelectLogFile=${selectLogFileRef} />
    </div>
  `;
}
