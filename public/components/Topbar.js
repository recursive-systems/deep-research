import { html } from '../lib/html.js';

export function Topbar({ view, connected, onBack, onBrand }) {
  return html`
    <header class="topbar">
      <div class="topbar__left">
        <button
          class="topbar__back"
          style=${{ display: view === 'detail' ? 'flex' : 'none' }}
          onClick=${onBack}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M10 12L6 8l4-4" />
          </svg>
          Back
        </button>
        <div class="topbar__brand" onClick=${onBrand}>
          <div class="topbar__icon">DR</div>
          <div class="topbar__text">
            <div class="topbar__title">Deep Research</div>
            <div class="topbar__subtitle">Mission Control</div>
          </div>
        </div>
      </div>
      <div class="topbar__right">
        <div class="topbar__pulse">
          <span class=${`dot-live${connected === false ? ' disconnected' : ''}`}></span>
          <span>${connected === false ? 'Reconnecting' : 'Live'}</span>
        </div>
      </div>
    </header>
  `;
}
