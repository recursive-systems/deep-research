function contains(text, pattern) {
  return String(text || '')
    .toLowerCase()
    .includes(String(pattern || '').toLowerCase());
}

export function classifyRunError(errorMessage, { provider = '', model = '' } = {}) {
  const message = String(errorMessage || '').trim();
  if (!message) {
    return {
      errorKind: null,
      errorHint: null,
      errorAction: null,
    };
  }

  if (
    contains(message, 'authentication_error') ||
    contains(message, 'invalid authentication credentials') ||
    contains(message, 'failed to authenticate') ||
    contains(message, '401')
  ) {
    const label = provider ? `${provider}${model ? ` (${model})` : ''}` : 'the provider';
    return {
      errorKind: 'provider_auth',
      errorHint: `Authentication failed for ${label}. Re-authenticate that provider or set valid credentials, then rerun this research.`,
      errorAction:
        provider === 'claude'
          ? 'Sign in to Claude again or provide a valid Anthropic API key for this process.'
          : 'Refresh the provider credentials for this process and rerun.',
    };
  }

  if (contains(message, 'query closed before response received')) {
    return {
      errorKind: 'provider_startup',
      errorHint: `The provider connection closed during startup. This is usually transient; rerun once before deeper debugging.`,
      errorAction: 'Retry the run. If it repeats, inspect the provider adapter logs.',
    };
  }

  return {
    errorKind: 'generic',
    errorHint: null,
    errorAction: null,
  };
}
