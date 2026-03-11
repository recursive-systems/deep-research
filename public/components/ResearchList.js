import { html } from '../lib/html.js';
import { useMemo } from 'preact/hooks';
import { fmtDuration, fmtTopicIterations, pct, isActive } from '../lib/format.js';

function StatusDot({ status }) {
  return html`<span class="status"
    ><span class=${`dot ${status || ''}`}></span>${status || 'no runs'}</span
  >`;
}

function ResearchCard({ topic, latestRun, topicRuns, onSelect, onStop, onRerun, onDelete }) {
  const running = latestRun && isActive(latestRun);
  const p = latestRun ? pct(latestRun) : 0;

  const stopClick = (e) => {
    e.stopPropagation();
    onStop(latestRun.id);
  };
  const rerunClick = (e) => {
    e.stopPropagation();
    onRerun(topic.slug, latestRun);
  };
  const deleteClick = (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${topic.title}" and all ${topicRuns.length} run(s)?`)) {
      onDelete(topic.slug);
    }
  };

  return html`
    <div
      class=${`research-card${running ? ' is-active' : ''}`}
      onClick=${() => onSelect(topic.slug)}
    >
      <div class="research-card__row1">
        <span class="research-card__title">${topic.title}</span>
        <div class="research-card__actions">
          ${running &&
          html`<button class="btn btn--ghost btn--xs" onClick=${stopClick}>Stop</button>`}
          <button class="btn btn--primary btn--xs" onClick=${rerunClick}>Rerun</button>
          ${!running &&
          html`<button class="btn btn--danger btn--xs" onClick=${deleteClick}>Delete</button>`}
        </div>
      </div>
      <div class="research-card__row2">
        ${latestRun ? html`<${StatusDot} status=${latestRun.status} />` : html`<${StatusDot} />`}
        <span class="tag">${topicRuns.length} run${topicRuns.length !== 1 ? 's' : ''}</span>
        ${latestRun && html`<span class="tag">${latestRun.provider}</span>`}
        ${latestRun && html`<span class="tag">topic ${fmtTopicIterations(latestRun)}</span>`}
        ${latestRun && html`<span class="tag">${fmtDuration(latestRun)}</span>`}
      </div>
      ${latestRun?.summary?.lastAgentLine &&
      html` <div class="research-card__agent">${latestRun.summary.lastAgentLine}</div> `}
      ${latestRun &&
      p != null &&
      html`
        <div class="research-card__progress">
          <div
            class=${`research-card__progress-fill${running ? ' running' : ''}`}
            style=${{ width: `${p}%` }}
          ></div>
        </div>
      `}
    </div>
  `;
}

export function ResearchList({
  topics,
  runs,
  onSelect,
  onStop,
  onRerun,
  onDelete,
  onNew,
  onRefresh,
}) {
  const runsForTopic = useMemo(() => {
    const map = {};
    for (const r of runs) {
      if (!map[r.topicSlug]) map[r.topicSlug] = [];
      map[r.topicSlug].push(r);
    }
    for (const slug of Object.keys(map)) {
      map[slug].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    }
    return map;
  }, [runs]);

  const activeCount = runs.filter(isActive).length;
  const completedCount = runs.filter((r) => r.status === 'completed').length;

  const sorted = useMemo(() => {
    return [...topics].sort((a, b) => {
      const aRuns = runsForTopic[a.slug] || [];
      const bRuns = runsForTopic[b.slug] || [];
      const aActive = aRuns[0] && isActive(aRuns[0]) ? 1 : 0;
      const bActive = bRuns[0] && isActive(bRuns[0]) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
  }, [topics, runsForTopic]);

  return html`
    <div class="view container">
      <div class="list-header">
        <div class="list-header__left">
          <h1>Research</h1>
          <p>
            ${activeCount > 0
              ? `${activeCount} active now`
              : `${topics.length} topic${topics.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div class="list-header__actions">
          <button class="btn btn--ghost btn--sm" onClick=${onRefresh}>Refresh</button>
          <button class="btn btn--primary" onClick=${onNew}>+ New Research</button>
        </div>
      </div>

      <div class="stats-row">
        <div class="stat-cell">
          <div class="stat-cell__label">Research</div>
          <div class="stat-cell__value">${topics.length}</div>
        </div>
        <div class="stat-cell">
          <div class="stat-cell__label">Total Runs</div>
          <div class="stat-cell__value">${runs.length}</div>
        </div>
        <div class="stat-cell">
          <div class="stat-cell__label">Active</div>
          <div class="stat-cell__value stat-cell__value--amber">${activeCount}</div>
        </div>
        <div class="stat-cell">
          <div class="stat-cell__label">Completed</div>
          <div class="stat-cell__value stat-cell__value--green">${completedCount}</div>
        </div>
      </div>

      <div>
        ${topics.length === 0 &&
        html`
          <div class="empty-state">
            <div class="empty-state__icon">${'\u25C9'}</div>
            <div class="empty-state__text">No research yet</div>
            <div class="empty-state__sub">Click "+ New Research" to get started</div>
          </div>
        `}
        ${topics.length > 0 &&
        html`
          <div class="research-list">
            ${sorted.map((topic) => {
              const topicRuns = runsForTopic[topic.slug] || [];
              return html`
                <${ResearchCard}
                  key=${topic.slug}
                  topic=${topic}
                  latestRun=${topicRuns[0] || null}
                  topicRuns=${topicRuns}
                  onSelect=${onSelect}
                  onStop=${onStop}
                  onRerun=${onRerun}
                  onDelete=${onDelete}
                />
              `;
            })}
          </div>
        `}
      </div>
    </div>
  `;
}
