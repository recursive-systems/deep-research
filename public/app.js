// ===== State =====
const state = {
  topics: [],
  runs: [],
  runMap: new Map(),
  currentView: 'list',
  // detail view state
  selectedTopicSlug: null,
  selectedRunId: null,
  selectedPath: null,
  pollTimer: null,
};

// ===== Helpers =====
function $(id) { return document.getElementById(id); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
  return payload;
}

function esc(v) {
  return String(v || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function statusHtml(s) {
  return `<span class="status"><span class="dot ${s}"></span>${s}</span>`;
}

function fmtDate(v) { return v ? new Date(v).toLocaleString() : '-'; }

function fmtDuration(run) {
  if (!run.startedAt) return '-';
  const ms = (run.endedAt ? new Date(run.endedAt) : new Date()) - new Date(run.startedAt);
  const s = Math.max(Math.round(ms / 1000), 0);
  const m = Math.floor(s / 60);
  return m === 0 ? `${s}s` : `${m}m ${s % 60}s`;
}

function pct(run) {
  if (run.requestedIterations == null) return null;
  const t = Math.max(run.requestedIterations || 0, 1);
  return Math.max(0, Math.min(100, Math.round(((run.completedIterations || 0) / t) * 100)));
}

function fmtIterations(run) {
  return run.requestedIterations == null
    ? `${run.completedIterations} / open-ended`
    : `${run.completedIterations} / ${run.requestedIterations}`;
}

function fmtTimeout(run) {
  return run.maxMinutes == null ? 'none' : `${run.maxMinutes} min`;
}

function topicIterationOffset(run) {
  return Number(run.topicIterationOffset || 0);
}

function fmtTopicIterations(run) {
  const offset = topicIterationOffset(run);
  const current = offset + Number(run.completedIterations || 0);
  if (run.requestedIterations == null) {
    return `${current} / open-ended`;
  }
  return `${current} / ${offset + run.requestedIterations}`;
}

function parseOptionalInt(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isActive(run) { return run.status === 'running' || run.status === 'queued'; }

function runsForTopic(slug) {
  return state.runs
    .filter((r) => r.topicSlug === slug)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function latestRun(slug) {
  return runsForTopic(slug)[0] || null;
}

// ===== Navigation =====
function showList() {
  state.currentView = 'list';
  state.selectedTopicSlug = null;
  state.selectedRunId = null;
  state.selectedPath = null;
  $('listView').classList.remove('view--hidden');
  $('detailView').classList.add('view--hidden');
  $('backBtn').style.display = 'none';
}

function showDetail(topicSlug, runId) {
  state.currentView = 'detail';
  state.selectedTopicSlug = topicSlug;
  state.selectedPath = null;

  const topicRuns = runsForTopic(topicSlug);
  state.selectedRunId = runId || topicRuns[0]?.id || null;

  $('listView').classList.add('view--hidden');
  $('detailView').classList.remove('view--hidden');
  $('detailView').classList.remove('view');
  void $('detailView').offsetWidth;
  $('detailView').classList.add('view');
  $('backBtn').style.display = 'flex';

  renderDetail();
}

// ===== Data =====
async function refresh() {
  try {
    const [topicsRes, runsRes] = await Promise.all([
      api('/api/topics'),
      api('/api/runs'),
    ]);
    state.topics = topicsRes.topics || [];
    state.runs = runsRes.runs || [];
    state.runMap = new Map(state.runs.map((r) => [r.id, r]));
  } catch (err) {
    console.error('refresh failed:', err);
  }

  renderStats();
  renderResearchList();

  if (state.currentView === 'detail' && state.selectedTopicSlug) {
    renderDetail();
  }
}

function renderStats() {
  $('statTopics').textContent = state.topics.length;
  $('statRuns').textContent = state.runs.length;
  const active = state.runs.filter(isActive).length;
  $('statActive').textContent = active;
  $('statCompleted').textContent = state.runs.filter((r) => r.status === 'completed').length;
  $('listSubtitle').textContent = active > 0
    ? `${active} active now`
    : `${state.topics.length} topic${state.topics.length !== 1 ? 's' : ''}`;
}

// ===== List View =====
function renderResearchList() {
  const container = $('researchList');
  container.innerHTML = '';

  if (state.topics.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">&#9673;</div>
        <div class="empty-state__text">No research yet</div>
        <div class="empty-state__sub">Click "+ New Research" to get started</div>
      </div>`;
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'research-list';

  // Sort: topics with active runs first, then by latest run date
  const sorted = [...state.topics].sort((a, b) => {
    const aLatest = latestRun(a.slug);
    const bLatest = latestRun(b.slug);
    const aActive = aLatest && isActive(aLatest) ? 1 : 0;
    const bActive = bLatest && isActive(bLatest) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });

  for (const topic of sorted) {
    const latest = latestRun(topic.slug);
    const topicRuns = runsForTopic(topic.slug);
    const running = latest && isActive(latest);
    const p = latest ? pct(latest) : 0;

    const card = document.createElement('div');
    card.className = `research-card${running ? ' is-active' : ''}`;

    card.innerHTML = `
      <div class="research-card__row1">
        <span class="research-card__title">${esc(topic.title)}</span>
        <div class="research-card__actions"></div>
      </div>
      <div class="research-card__row2">
        ${latest ? statusHtml(latest.status) : '<span class="status"><span class="dot"></span>no runs</span>'}
        <span class="tag">${topicRuns.length} run${topicRuns.length !== 1 ? 's' : ''}</span>
        ${latest ? `<span class="tag">${latest.provider}</span>` : ''}
        ${latest ? `<span class="tag">topic ${fmtTopicIterations(latest)}</span>` : ''}
        ${latest ? `<span class="tag">${fmtDuration(latest)}</span>` : ''}
      </div>
      ${latest?.summary?.lastAgentLine ? `<div class="research-card__agent">${esc(latest.summary.lastAgentLine)}</div>` : ''}
      ${latest && p != null ? `<div class="research-card__progress"><div class="research-card__progress-fill${running ? ' running' : ''}" style="width:${p}%"></div></div>` : ''}
    `;

    // Hover actions
    const actions = card.querySelector('.research-card__actions');

    if (running) {
      const stopBtn = makeBtn('Stop', 'btn--ghost btn--xs', async (e) => {
        e.stopPropagation();
        await api(`/api/runs/${encodeURIComponent(latest.id)}/stop`, { method: 'POST' });
        await refresh();
      });
      actions.appendChild(stopBtn);
    }

    const rerunBtn = makeBtn('Rerun', 'btn--primary btn--xs', (e) => {
      e.stopPropagation();
      openRerunModal(topic.slug, latest);
    });
    actions.appendChild(rerunBtn);

    if (!running) {
      const delBtn = makeBtn('Delete', 'btn--danger btn--xs', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${topic.title}" and all ${topicRuns.length} run(s)?`)) return;
        await api(`/api/topics/${encodeURIComponent(topic.slug)}`, { method: 'DELETE' });
        await refresh();
      });
      actions.appendChild(delBtn);
    }

    card.addEventListener('click', () => showDetail(topic.slug));
    wrapper.appendChild(card);
  }

  container.appendChild(wrapper);
}

function makeBtn(text, classes, handler) {
  const btn = document.createElement('button');
  btn.className = `btn ${classes}`;
  btn.textContent = text;
  btn.addEventListener('click', handler);
  return btn;
}

// ===== Detail View =====
function renderDetail() {
  const slug = state.selectedTopicSlug;
  const topic = state.topics.find((t) => t.slug === slug);
  if (!topic) { showList(); return; }

  const topicRuns = runsForTopic(slug);
  if (!state.selectedRunId || !topicRuns.find((r) => r.id === state.selectedRunId)) {
    state.selectedRunId = topicRuns[0]?.id || null;
  }

  const run = state.selectedRunId ? state.runMap.get(state.selectedRunId) : null;
  const running = run && isActive(run);
  const hasAnyActive = topicRuns.some(isActive);

  const detail = $('detailView');
  detail.innerHTML = `
    <div class="detail-topline">
      <div class="detail-topline__info">
        <h1>${esc(topic.title)}</h1>
        <p>${esc(topic.slug)} &middot; ${topicRuns.length} run${topicRuns.length !== 1 ? 's' : ''}</p>
      </div>
      <div class="detail-topline__actions" id="detailActions"></div>
    </div>
    ${topicRuns.length > 1 ? '<div class="run-picker" id="runPicker"></div>' : ''}
    ${run ? `
      <div class="detail-grid" id="detailMeta"></div>
      <div class="tail-section">
        <div class="tail-header">
          <div class="tail-label"><span class="live-indicator"></span> Live Tail</div>
          <button class="btn btn--ghost btn--xs" id="fullLogBtn">Full Log</button>
        </div>
        <pre class="tail-content" id="detailTail"></pre>
      </div>
      <div class="file-section">
        <div class="file-section__header">Files</div>
        <div class="file-layout">
          <div class="file-nav" id="fileList"></div>
          <pre class="file-viewer" id="fileContent"></pre>
        </div>
      </div>
    ` : `
      <div class="empty-state">
        <div class="empty-state__icon">&#9655;</div>
        <div class="empty-state__text">No runs yet for this research</div>
      </div>
    `}
  `;

  // Actions
  const actionsEl = $('detailActions');

  actionsEl.appendChild(makeBtn('Rerun', 'btn--primary btn--sm', () => {
    openRerunModal(slug, run);
  }));

  if (running) {
    actionsEl.appendChild(makeBtn('Stop', 'btn--ghost btn--sm', async () => {
      await api(`/api/runs/${encodeURIComponent(run.id)}/stop`, { method: 'POST' });
      await refresh();
    }));
  }

  if (!hasAnyActive) {
    actionsEl.appendChild(makeBtn('Delete Research', 'btn--danger btn--sm', async () => {
      if (!confirm(`Delete "${topic.title}" and all ${topicRuns.length} run(s)?`)) return;
      await api(`/api/topics/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      showList();
      await refresh();
    }));
  }

  // Run picker dropdown
  if (topicRuns.length > 1) {
    const picker = $('runPicker');
    if (picker) {
      const select = document.createElement('select');
      select.className = 'run-picker__select';
      for (let i = 0; i < topicRuns.length; i++) {
        const r = topicRuns[i];
        const label = i === 0 ? 'Latest' : `Run ${topicRuns.length - i}`;
        const date = r.startedAt ? new Date(r.startedAt).toLocaleDateString() : '';
        const time = r.startedAt ? new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = `${label} — ${r.status} — ${r.provider} — topic ${fmtTopicIterations(r)} — ${date} ${time} — ${fmtDuration(r)}`;
        if (r.id === state.selectedRunId) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        state.selectedRunId = select.value;
        state.selectedPath = null;
        renderDetail();
      });
      picker.appendChild(select);
    }
  }

  // Fill run detail
  if (run) {
    fillRunDetail(run);
  }
}

async function fillRunDetail(run) {
  // Meta grid
  $('detailMeta').innerHTML = `
    <div class="detail-cell"><div class="detail-cell__label">Status</div><div class="detail-cell__value">${statusHtml(run.status)}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Iterations</div><div class="detail-cell__value">${fmtIterations(run)}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Topic Iterations</div><div class="detail-cell__value">${fmtTopicIterations(run)}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Timeout</div><div class="detail-cell__value">${fmtTimeout(run)}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Provider</div><div class="detail-cell__value">${run.provider}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Model</div><div class="detail-cell__value">${run.model || 'default'}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Started</div><div class="detail-cell__value">${fmtDate(run.startedAt)}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Duration</div><div class="detail-cell__value">${fmtDuration(run)}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Log Lines</div><div class="detail-cell__value">${run.summary?.lineCount || 0}</div></div>
    <div class="detail-cell"><div class="detail-cell__label">Last Tool</div><div class="detail-cell__value" style="font-size:11px">${esc(run.summary?.lastToolLine || '-')}</div></div>
  `;

  // Tail
  $('detailTail').textContent = (run.summary?.tail || []).join('\n');

  // Full log button
  const fullLogBtn = $('fullLogBtn');
  fullLogBtn.addEventListener('click', async () => {
    state.selectedPath = 'stdout.log';
    await loadFile(run.id, 'stdout.log');
    renderFileNav(run.id);
  });

  // Load files
  try {
    const filesPayload = await api(`/api/runs/${encodeURIComponent(run.id)}/files`);
    state._currentFiles = filesPayload;
    renderFileNav(run.id);
  } catch {
    // run may have been deleted
  }
}

function renderFileNav(runId) {
  const fp = state._currentFiles;
  if (!fp) return;

  const available = [
    ...fp.topFiles.filter((f) => f !== 'stdout.log'),
    'stdout.log',
    ...fp.iterations,
    ...fp.library,
  ].filter(Boolean);

  const nav = $('fileList');
  if (!nav) return;
  nav.innerHTML = '';

  if (!state.selectedPath || !available.includes(state.selectedPath)) {
    state.selectedPath = available.includes('report.md') ? 'report.md' : (available[0] || null);
  }

  for (const f of available) {
    const item = document.createElement('div');
    item.className = `file-nav__item${f === state.selectedPath ? ' selected' : ''}`;
    item.textContent = f;
    item.addEventListener('click', async () => {
      state.selectedPath = f;
      nav.querySelectorAll('.file-nav__item').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
      await loadFile(runId, f);
    });
    nav.appendChild(item);
  }

  if (state.selectedPath) loadFile(runId, state.selectedPath);
}

async function loadFile(runId, filePath) {
  const viewer = $('fileContent');
  if (!viewer) return;
  const wasEmpty = !viewer.textContent;
  const isLog = filePath === 'stdout.log';
  const nearBottom = isLog && Math.abs((viewer.scrollTop + viewer.clientHeight) - viewer.scrollHeight) < 40;

  const payload = await api(`/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(filePath)}`);
  viewer.textContent = payload.content || '';

  if (isLog && (nearBottom || wasEmpty)) viewer.scrollTop = viewer.scrollHeight;
}

// ===== Rerun Modal =====
function openRerunModal(topicSlug, baseRun) {
  $('rerunModal').classList.remove('hidden');
  $('rerunModalTitle').textContent = `Rerun: ${state.topics.find((t) => t.slug === topicSlug)?.title || topicSlug}`;
  $('rerunTopicSlug').value = topicSlug;
  $('rerunBaseRunId').value = baseRun?.id || '';
  $('rerunProvider').value = baseRun?.provider || 'claude';
  $('rerunModel').value = baseRun?.model || '';
  $('rerunIterations').value = baseRun?.requestedIterations ?? '';
  $('rerunMaxMinutes').value = baseRun?.maxMinutes ?? '';
}

function closeRerunModal() {
  $('rerunModal').classList.add('hidden');
  $('rerunForm').reset();
}

async function onRerunSubmit(e) {
  e.preventDefault();
  const btn = $('rerunSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Launching...';
  try {
    const result = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        topicSlug: $('rerunTopicSlug').value,
        provider: $('rerunProvider').value,
        model: $('rerunModel').value,
        iterations: parseOptionalInt($('rerunIterations').value),
        maxMinutes: parseOptionalInt($('rerunMaxMinutes').value),
        baseRunId: $('rerunBaseRunId').value || null,
      }),
    });
    closeRerunModal();
    await refresh();
    showDetail($('rerunTopicSlug').value, result.run.id);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Launch';
  }
}

// ===== New Research Modal =====
function openNewModal() { $('modal').classList.remove('hidden'); }
function closeNewModal() { $('modal').classList.add('hidden'); $('newForm').reset(); }

async function onNewSubmit(e) {
  e.preventDefault();
  const btn = $('newSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Launching...';
  try {
    const result = await api('/api/start', {
      method: 'POST',
      body: JSON.stringify({
        brief: $('newBrief').value,
        provider: $('newProvider').value,
        model: $('newModel').value,
        iterations: parseOptionalInt($('newIterations').value),
        maxMinutes: parseOptionalInt($('newMaxMinutes').value),
      }),
    });
    closeNewModal();
    await refresh();
    showDetail(result.topic.slug, result.run.id);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Launch';
  }
}

// ===== Polling =====
function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => refresh().catch(console.error), 3000);
}

// ===== Init =====
async function main() {
  $('backBtn').addEventListener('click', showList);
  $('brandBtn').addEventListener('click', () => { if (state.currentView !== 'list') showList(); });

  $('newBtn').addEventListener('click', openNewModal);
  $('modalCloseBtn').addEventListener('click', closeNewModal);
  $('modalCancelBtn').addEventListener('click', closeNewModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeNewModal(); });
  $('newForm').addEventListener('submit', onNewSubmit);

  $('rerunModalCloseBtn').addEventListener('click', closeRerunModal);
  $('rerunCancelBtn').addEventListener('click', closeRerunModal);
  $('rerunModal').addEventListener('click', (e) => { if (e.target === $('rerunModal')) closeRerunModal(); });
  $('rerunForm').addEventListener('submit', onRerunSubmit);

  $('refreshBtn').addEventListener('click', () => refresh());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('modal').classList.contains('hidden')) return closeNewModal();
      if (!$('rerunModal').classList.contains('hidden')) return closeRerunModal();
      if (state.currentView === 'detail') return showList();
    }
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    if (e.key === 'r' && !inInput && !e.ctrlKey && !e.metaKey) refresh();
    if (e.key === 'n' && !inInput && !e.ctrlKey && !e.metaKey) openNewModal();
  });

  await refresh();
  startPolling();
}

main().catch((err) => {
  console.error(err);
  $('researchList').innerHTML = `<div class="empty-state"><div class="empty-state__icon">!</div><div class="empty-state__text">${esc(err.message)}</div></div>`;
});
