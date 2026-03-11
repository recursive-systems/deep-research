import { html } from '../lib/html.js';
import { useState, useCallback } from 'preact/hooks';
import { fmtDate, fmtScore, EVAL_CRITERIA, EVAL_SERIES } from '../lib/format.js';

function loadEvalVisibility() {
  try {
    const raw = localStorage.getItem('deepResearch.evalSeriesVisibility');
    if (raw) {
      const parsed = JSON.parse(raw);
      return Object.fromEntries(EVAL_SERIES.map((s) => [s.key, parsed[s.key] !== false]));
    }
  } catch {
    /* ignore */
  }
  return Object.fromEntries(EVAL_SERIES.map((s) => [s.key, true]));
}

function saveEvalVisibility(map) {
  try {
    localStorage.setItem('deepResearch.evalSeriesVisibility', JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function chartPoint(index, total, score, width, height, padding) {
  const usableW = width - padding * 2;
  const usableH = height - padding * 2;
  const x = total === 1 ? width / 2 : padding + (usableW * index) / (total - 1);
  const normalized = (Math.max(1, Math.min(5, Number(score) || 1)) - 1) / 4;
  const y = height - padding - normalized * usableH;
  return [Number(x.toFixed(2)), Number(y.toFixed(2))];
}

function scoreForSeries(item, key) {
  const value = key === 'overall' ? Number(item.overall) : Number(item.scores?.[key]);
  return Number.isFinite(value) ? value : null;
}

function EvalChart({ evaluations, visibleSeries }) {
  if (!evaluations.length) return null;

  const width = 640,
    height = 210,
    padding = 26;
  const gridScores = [1, 2, 3, 4, 5];

  return html`
    <svg viewBox="0 0 ${width} ${height}" class="eval-chart" aria-label="Evaluation trend chart">
      ${gridScores.map((score) => {
        const y = chartPoint(0, 1, score, width, height, padding)[1];
        return html`
          <line x1=${padding} y1=${y} x2=${width - padding} y2=${y} class="eval-chart__grid" />
          <text x="6" y=${y + 4} class="eval-chart__axis">${score}</text>
        `;
      })}
      ${visibleSeries.map((series) => {
        const points = evaluations.map((item, i) => {
          const score = scoreForSeries(item, series.key);
          if (!Number.isFinite(score)) return null;
          const [x, y] = chartPoint(i, evaluations.length, score, width, height, padding);
          return { x, y, item, score };
        });
        const segments = [];
        let current = [];
        for (const pt of points) {
          if (pt) {
            current.push(pt);
          } else if (current.length) {
            segments.push(current);
            current = [];
          }
        }
        if (current.length) segments.push(current);

        const isOverall = series.key === 'overall';
        const sw = isOverall ? 3 : 2;
        const op = isOverall ? 1 : 0.82;
        const r = isOverall ? 4 : 3;

        return html`
          <g>
            ${segments
              .filter((s) => s.length >= 2)
              .map(
                (seg) => html`
                  <polyline
                    points=${seg.map((p) => `${p.x},${p.y}`).join(' ')}
                    class="eval-chart__line"
                    style=${{ stroke: series.color, strokeWidth: sw, opacity: op }}
                  />
                `
              )}
            ${points.filter(Boolean).map(
              (p) => html`
                <circle
                  cx=${p.x}
                  cy=${p.y}
                  r=${r}
                  class="eval-chart__dot"
                  style=${{ stroke: series.color, fill: isOverall ? '#08080c' : series.color }}
                >
                  <title>
                    ${series.label} · Iteration ${p.item.iteration}: ${fmtScore(p.score)}/5
                  </title>
                </circle>
              `
            )}
          </g>
        `;
      })}
      ${evaluations.map((item, i) => {
        const [x] = chartPoint(i, evaluations.length, 1, width, height, padding);
        return html`<text x=${x} y=${height - 6} text-anchor="middle" class="eval-chart__axis"
          >${item.iteration}</text
        >`;
      })}
    </svg>
  `;
}

export function EvalSection({ evaluations, error }) {
  const [visibility, setVisibility] = useState(loadEvalVisibility);

  const toggleSeries = useCallback((key) => {
    setVisibility((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveEvalVisibility(next);
      return next;
    });
  }, []);

  if (error) {
    return html`
      <div class="eval-section">
        <div class="eval-header">
          <div>
            <div class="eval-kicker">Evaluation</div>
            <h2>Judge Trend</h2>
          </div>
        </div>
        <div class="empty-state eval-empty">
          <div class="empty-state__text">${error.message || 'Evaluation unavailable'}</div>
        </div>
      </div>
    `;
  }

  if (!evaluations || !evaluations.length) {
    return html`
      <div class="eval-section">
        <div class="eval-header">
          <div>
            <div class="eval-kicker">Evaluation</div>
            <h2>Judge Trend</h2>
          </div>
        </div>
        <div class="empty-state eval-empty">
          <div class="empty-state__text">No evaluation traces yet</div>
          <div class="empty-state__sub">
            A judge pass will appear after the run produces enough output to evaluate.
          </div>
        </div>
      </div>
    `;
  }

  const latest = evaluations[evaluations.length - 1];
  const delta =
    evaluations.length >= 2
      ? Number(latest.overall) - Number(evaluations[evaluations.length - 2].overall)
      : null;
  const deltaText =
    delta == null || !Number.isFinite(delta) ? 'n/a' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`;
  const metrics = latest.metrics || {};
  const iterationLabel = latest.incompleteIteration
    ? `Iteration ${latest.iteration} (partial)`
    : `Iteration ${latest.iteration}`;
  const visibleSeries = EVAL_SERIES.filter((s) => visibility[s.key] !== false);

  return html`
    <div class="eval-section">
      <div class="eval-header">
        <div>
          <div class="eval-kicker">Evaluation</div>
          <h2>Judge Trend</h2>
        </div>
        <div class="eval-meta">${iterationLabel} · ${fmtDate(latest.evaluatedAt)}</div>
      </div>

      <div class="eval-stats">
        <div class="detail-cell">
          <div class="detail-cell__label">Latest Overall</div>
          <div class="detail-cell__value">${fmtScore(latest.overall)} / 5</div>
        </div>
        <div class="detail-cell">
          <div class="detail-cell__label">Model Overall</div>
          <div class="detail-cell__value">${fmtScore(latest.modelOverall)} / 5</div>
        </div>
        <div class="detail-cell">
          <div class="detail-cell__label">Delta vs Prior</div>
          <div class="detail-cell__value">${deltaText}</div>
        </div>
        <div class="detail-cell">
          <div class="detail-cell__label">Report Words</div>
          <div class="detail-cell__value">${metrics.reportWords ?? '-'}</div>
        </div>
        <div class="detail-cell">
          <div class="detail-cell__label">Sources</div>
          <div class="detail-cell__value">${metrics.sourceCount ?? '-'}</div>
        </div>
        <div class="detail-cell">
          <div class="detail-cell__label">Audited URLs</div>
          <div class="detail-cell__value">${metrics.auditedSources ?? '-'}</div>
        </div>
        <div class="detail-cell">
          <div class="detail-cell__label">Resolvable URLs</div>
          <div class="detail-cell__value">
            ${metrics.auditableSources != null
              ? `${metrics.resolvableSources ?? 0}/${metrics.auditableSources}`
              : '-'}
          </div>
        </div>
      </div>

      <div class="eval-chart-wrap">
        <div class="eval-toolbar">
          <div class="eval-toolbar__label">Series</div>
          <div class="eval-toggle-group">
            ${EVAL_SERIES.map(
              (series) => html`
                <button
                  type="button"
                  class=${`eval-toggle${visibility[series.key] !== false ? ' is-active' : ''}`}
                  onClick=${() => toggleSeries(series.key)}
                >
                  <span class="eval-toggle__swatch" style=${{ background: series.color }}></span>
                  <span>${series.label}</span>
                </button>
              `
            )}
          </div>
        </div>
        ${visibleSeries.length
          ? html`<${EvalChart} evaluations=${evaluations} visibleSeries=${visibleSeries} />`
          : html`<div class="eval-chart__empty">Select at least one series.</div>`}
      </div>

      <div class="eval-criteria">
        ${EVAL_CRITERIA.map(([key, label]) => {
          const value = Number(latest.scores?.[key]);
          const pctValue = Math.max(0, Math.min(100, ((value || 0) / 5) * 100));
          return html`
            <div class="criterion">
              <div class="criterion__row">
                <span>${label}</span>
                <span>${Number.isFinite(value) ? value : '-'}/5</span>
              </div>
              <div class="criterion__bar">
                <div class="criterion__fill" style=${{ width: `${pctValue}%` }}></div>
              </div>
            </div>
          `;
        })}
      </div>

      <div class="eval-notes">
        <div class="eval-note">
          <div class="detail-cell__label">Summary</div>
          <div class="eval-note__body">${latest.summary || '-'}</div>
        </div>
        <div class="eval-note">
          <div class="detail-cell__label">Strengths</div>
          <div class="eval-note__tags">
            ${(latest.strengths || []).length
              ? (latest.strengths || []).map((s) => html`<span class="tag">${s}</span>`)
              : html`<span class="tag">none</span>`}
          </div>
        </div>
        <div class="eval-note">
          <div class="detail-cell__label">Weaknesses</div>
          <div class="eval-note__tags">
            ${(latest.weaknesses || []).length
              ? (latest.weaknesses || []).map((w) => html`<span class="tag tag--weak">${w}</span>`)
              : html`<span class="tag">none</span>`}
          </div>
        </div>
      </div>
    </div>
  `;
}
