import { html } from '../lib/html.js';
import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { api } from '../lib/api.js';
import { createSSE } from '../lib/sse.js';
import { Topbar } from './Topbar.js';
import { ResearchList } from './ResearchList.js';
import { DetailView } from './DetailView.js';
import { NewModal, RerunModal } from './Modals.js';

export function App() {
  const [topics, setTopics] = useState([]);
  const [runs, setRuns] = useState([]);
  const [view, setView] = useState('list');
  const [selectedTopicSlug, setSelectedTopicSlug] = useState(null);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [sseConnected, setSseConnected] = useState(null);
  const [evalCache, setEvalCache] = useState({});

  // Modal state: null | 'new' | { type: 'rerun', topicSlug, topicTitle, baseRun }
  const [modal, setModal] = useState(null);

  const runsForTopic = useCallback(
    (slug) => {
      return runs
        .filter((r) => r.topicSlug === slug)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    },
    [runs]
  );

  // Data fetching
  const refresh = useCallback(async () => {
    try {
      const [topicsRes, runsRes] = await Promise.all([api('/api/topics'), api('/api/runs')]);
      setTopics(topicsRes.topics || []);
      setRuns(runsRes.runs || []);
    } catch (err) {
      console.error('refresh failed:', err);
    }
  }, []);

  const refreshTopics = useCallback(async () => {
    try {
      const res = await api('/api/topics');
      setTopics(res.topics || []);
    } catch (err) {
      console.error('refreshTopics failed:', err);
    }
  }, []);

  // SSE + initial fetch + fallback poll
  useEffect(() => {
    refresh();

    const sse = createSSE();

    sse.on('run:updated', (run) => {
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === run.id);
        if (idx === -1) return [...prev, run];
        const next = [...prev];
        next[idx] = run;
        return next;
      });
    });

    sse.on('run:evaluations', ({ runId, evaluations }) => {
      setEvalCache((prev) => ({ ...prev, [runId]: evaluations }));
    });

    sse.on('topic:updated', () => {
      refreshTopics();
    });

    sse.onStatusChange((connected) => {
      setSseConnected(connected);
    });

    const fallback = setInterval(() => refresh(), 30_000);

    return () => {
      sse.close();
      clearInterval(fallback);
    };
  }, [refresh, refreshTopics]);

  // Navigation
  const showList = useCallback(() => {
    setView('list');
    setSelectedTopicSlug(null);
    setSelectedRunId(null);
  }, []);

  const showDetail = useCallback((topicSlug, runId) => {
    setView('detail');
    setSelectedTopicSlug(topicSlug);
    setSelectedRunId(runId || null);
  }, []);

  // When entering detail view without a specific runId, pick the latest
  const currentTopicRuns = useMemo(() => {
    if (!selectedTopicSlug) return [];
    return runsForTopic(selectedTopicSlug);
  }, [selectedTopicSlug, runsForTopic]);

  const effectiveRunId = useMemo(() => {
    if (selectedRunId && currentTopicRuns.find((r) => r.id === selectedRunId)) {
      return selectedRunId;
    }
    return currentTopicRuns[0]?.id || null;
  }, [selectedRunId, currentTopicRuns]);

  // Actions
  const onStop = useCallback(
    async (runId) => {
      await api(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
      await refresh();
    },
    [refresh]
  );

  const onDelete = useCallback(
    async (topicSlug) => {
      await api(`/api/topics/${encodeURIComponent(topicSlug)}`, { method: 'DELETE' });
      if (view === 'detail') showList();
      await refresh();
    },
    [refresh, view, showList]
  );

  const onRerun = useCallback(
    (topicSlug, baseRun) => {
      const topic = topics.find((t) => t.slug === topicSlug);
      setModal({ type: 'rerun', topicSlug, topicTitle: topic?.title || topicSlug, baseRun });
    },
    [topics]
  );

  const onModalComplete = useCallback(
    (topicSlug, runId) => {
      refresh();
      showDetail(topicSlug, runId);
    },
    [refresh, showDetail]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (modal) {
          setModal(null);
          return;
        }
        if (view === 'detail') {
          showList();
          return;
        }
      }
      const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
      if (inInput || e.ctrlKey || e.metaKey) return;
      if (e.key === 'r') refresh();
      if (e.key === 'n') setModal('new');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, view, showList, refresh]);

  const selectedTopic = topics.find((t) => t.slug === selectedTopicSlug);

  return html`
    <${Topbar}
      view=${view}
      connected=${sseConnected}
      onBack=${showList}
      onBrand=${() => {
        if (view !== 'list') showList();
      }}
    />

    ${view === 'list' &&
    html`
      <${ResearchList}
        topics=${topics}
        runs=${runs}
        onSelect=${(slug) => showDetail(slug)}
        onStop=${onStop}
        onRerun=${onRerun}
        onDelete=${onDelete}
        onNew=${() => setModal('new')}
        onRefresh=${refresh}
      />
    `}
    ${view === 'detail' &&
    selectedTopic &&
    html`
      <${DetailView}
        topic=${selectedTopic}
        runs=${currentTopicRuns}
        selectedRunId=${effectiveRunId}
        onSelectRun=${(id) => setSelectedRunId(id)}
        onRerun=${onRerun}
        onStop=${onStop}
        onDelete=${onDelete}
        evalCache=${evalCache}
      />
    `}

    <${NewModal}
      isOpen=${modal === 'new'}
      onClose=${() => setModal(null)}
      onComplete=${onModalComplete}
    />

    <${RerunModal}
      isOpen=${modal?.type === 'rerun'}
      topicSlug=${modal?.topicSlug}
      topicTitle=${modal?.topicTitle}
      baseRun=${modal?.baseRun}
      onClose=${() => setModal(null)}
      onComplete=${onModalComplete}
    />
  `;
}
