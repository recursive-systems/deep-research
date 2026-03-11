import { html } from '../lib/html.js';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';
import { parseOptionalInt, defaultModelFor, PROVIDER_DEFAULT_MODELS } from '../lib/format.js';

function Modal({ isOpen, onClose, children }) {
  const backdropRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const onBackdropClick = (e) => {
    if (e.target === backdropRef.current) onClose();
  };

  return html`
    <div class="modal-backdrop" ref=${backdropRef} onClick=${onBackdropClick}>
      <div class="modal">${children}</div>
    </div>
  `;
}

function useProviderModelSync(initialProvider, initialModel) {
  const [provider, setProvider] = useState(initialProvider || 'claude');
  const [model, setModel] = useState(initialModel || '');

  const onProviderChange = useCallback(
    (e) => {
      const next = e.target.value;
      const prevDefault = defaultModelFor(provider);
      const nextDefault = defaultModelFor(next);
      setProvider(next);
      if (!model || model === prevDefault) {
        setModel(nextDefault);
      }
    },
    [provider, model]
  );

  const placeholder = PROVIDER_DEFAULT_MODELS[provider]
    ? `auto (${PROVIDER_DEFAULT_MODELS[provider]})`
    : 'auto';

  return { provider, model, setModel, setProvider, onProviderChange, placeholder };
}

export function NewModal({ isOpen, onClose, onComplete }) {
  const { provider, model, setModel, setProvider, onProviderChange, placeholder } =
    useProviderModelSync('claude', '');
  const [brief, setBrief] = useState('');
  const [iterations, setIterations] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setBrief('');
      setIterations('');
      setMaxMinutes('');
      setProvider('claude');
      setModel('');
      setSubmitting(false);
    }
  }, [isOpen]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await api('/api/start', {
        method: 'POST',
        body: JSON.stringify({
          brief,
          provider,
          model,
          iterations: parseOptionalInt(iterations),
          maxMinutes: parseOptionalInt(maxMinutes),
        }),
      });
      onClose();
      onComplete(result.topic.slug, result.run.id);
    } finally {
      setSubmitting(false);
    }
  };

  return html`
    <${Modal} isOpen=${isOpen} onClose=${onClose}>
      <div class="modal__header">
        <span class="modal__title">New Research</span>
        <button class="modal__close" onClick=${onClose}>${'\u00D7'}</button>
      </div>
      <form onSubmit=${onSubmit}>
        <div class="form-group">
          <label class="form-label" for="newBrief">Research Brief</label>
          <textarea
            id="newBrief"
            rows="5"
            placeholder="Describe what you want to research..."
            required
            value=${brief}
            onInput=${(e) => setBrief(e.target.value)}
          ></textarea>
          <div class="form-hint">The first line becomes the research name.</div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="newProvider">Provider</label>
            <select id="newProvider" value=${provider} onChange=${onProviderChange}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="zai">Z.AI</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="newModel">Model</label>
            <input
              id="newModel"
              placeholder=${placeholder}
              value=${model}
              onInput=${(e) => setModel(e.target.value)}
            />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="newIterations">Iterations</label>
            <input
              id="newIterations"
              type="number"
              min="1"
              placeholder="blank = no limit"
              value=${iterations}
              onInput=${(e) => setIterations(e.target.value)}
            />
          </div>
          <div class="form-group">
            <label class="form-label" for="newMaxMinutes">Timeout (min)</label>
            <input
              id="newMaxMinutes"
              type="number"
              min="1"
              placeholder="blank = no limit"
              value=${maxMinutes}
              onInput=${(e) => setMaxMinutes(e.target.value)}
            />
          </div>
        </div>
        <div class="modal__footer">
          <button type="button" class="btn btn--ghost" onClick=${onClose}>Cancel</button>
          <button type="submit" class="btn btn--primary" disabled=${submitting}>
            ${submitting ? 'Launching...' : 'Launch'}
          </button>
        </div>
      </form>
    <//>
  `;
}

export function RerunModal({ isOpen, topicSlug, topicTitle, baseRun, onClose, onComplete }) {
  const { provider, model, setModel, setProvider, onProviderChange, placeholder } =
    useProviderModelSync(baseRun?.provider || 'claude', baseRun?.model || '');
  const [iterations, setIterations] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen && baseRun) {
      setProvider(baseRun.provider || 'claude');
      setModel(baseRun.model || '');
      setIterations(baseRun.requestedIterations != null ? String(baseRun.requestedIterations) : '');
      setMaxMinutes(baseRun.maxMinutes != null ? String(baseRun.maxMinutes) : '');
      setSubmitting(false);
    }
  }, [isOpen, baseRun]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          topicSlug,
          provider,
          model,
          iterations: parseOptionalInt(iterations),
          maxMinutes: parseOptionalInt(maxMinutes),
          baseRunId: baseRun?.id || null,
        }),
      });
      onClose();
      onComplete(topicSlug, result.run.id);
    } finally {
      setSubmitting(false);
    }
  };

  return html`
    <${Modal} isOpen=${isOpen} onClose=${onClose}>
      <div class="modal__header">
        <span class="modal__title">Rerun: ${topicTitle || topicSlug}</span>
        <button class="modal__close" onClick=${onClose}>${'\u00D7'}</button>
      </div>
      <form onSubmit=${onSubmit}>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="rerunProvider">Provider</label>
            <select id="rerunProvider" value=${provider} onChange=${onProviderChange}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="zai">Z.AI</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="rerunModel">Model</label>
            <input
              id="rerunModel"
              placeholder=${placeholder}
              value=${model}
              onInput=${(e) => setModel(e.target.value)}
            />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="rerunIterations">Iterations</label>
            <input
              id="rerunIterations"
              type="number"
              min="1"
              placeholder="blank = no limit"
              value=${iterations}
              onInput=${(e) => setIterations(e.target.value)}
            />
          </div>
          <div class="form-group">
            <label class="form-label" for="rerunMaxMinutes">Timeout (min)</label>
            <input
              id="rerunMaxMinutes"
              type="number"
              min="1"
              placeholder="blank = no limit"
              value=${maxMinutes}
              onInput=${(e) => setMaxMinutes(e.target.value)}
            />
          </div>
        </div>
        <div class="modal__footer">
          <button type="button" class="btn btn--ghost" onClick=${onClose}>Cancel</button>
          <button type="submit" class="btn btn--primary" disabled=${submitting}>
            ${submitting ? 'Launching...' : 'Launch'}
          </button>
        </div>
      </form>
    <//>
  `;
}
