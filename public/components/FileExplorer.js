import { html } from '../lib/html.js';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';

export function FileExplorer({ runId, onSelectLogFile }) {
  const [files, setFiles] = useState(null);
  const [selectedPath, setSelectedPath] = useState(null);
  const [content, setContent] = useState('');
  const viewerRef = useRef(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    api(`/api/runs/${encodeURIComponent(runId)}/files`)
      .then((payload) => {
        if (cancelled) return;
        setFiles(payload);
        const available = [
          ...(payload.topFiles || []).filter((f) => f !== 'stdout.log'),
          'stdout.log',
          ...(payload.iterations || []),
          ...(payload.library || []),
          ...(payload.evaluations || []),
        ].filter(Boolean);
        const defaultPath = available.includes('report.md') ? 'report.md' : available[0] || null;
        setSelectedPath((prev) => (prev && available.includes(prev) ? prev : defaultPath));
      })
      .catch(() => {
        if (!cancelled) setFiles(null);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const loadFile = useCallback(
    async (filePath) => {
      if (!runId || !filePath) return;
      try {
        const payload = await api(
          `/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(filePath)}`
        );
        setContent(payload.content || '');
        if (filePath === 'stdout.log' && viewerRef.current) {
          requestAnimationFrame(() => {
            if (viewerRef.current) viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
          });
        }
      } catch {
        setContent('');
      }
    },
    [runId]
  );

  useEffect(() => {
    if (selectedPath) loadFile(selectedPath);
  }, [selectedPath, loadFile]);

  // Expose a way for parent to select stdout.log
  useEffect(() => {
    if (onSelectLogFile) {
      onSelectLogFile.current = () => setSelectedPath('stdout.log');
    }
  }, [onSelectLogFile]);

  if (!files) return null;

  const available = [
    ...(files.topFiles || []).filter((f) => f !== 'stdout.log'),
    'stdout.log',
    ...(files.iterations || []),
    ...(files.library || []),
    ...(files.evaluations || []),
  ].filter(Boolean);

  return html`
    <div class="file-section">
      <div class="file-section__header">Files</div>
      <div class="file-layout">
        <div class="file-nav">
          ${available.map(
            (f) => html`
              <div
                key=${f}
                class=${`file-nav__item${f === selectedPath ? ' selected' : ''}`}
                onClick=${() => setSelectedPath(f)}
              >
                ${f}
              </div>
            `
          )}
        </div>
        <pre class="file-viewer" ref=${viewerRef}>${content}</pre>
      </div>
    </div>
  `;
}
