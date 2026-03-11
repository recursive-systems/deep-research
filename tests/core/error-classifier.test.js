import { describe, it, expect } from 'vitest';
import { classifyRunError } from '../../src/core/error-classifier.js';

describe('classifyRunError', () => {
  describe('provider_auth errors', () => {
    it('classifies "authentication_error" as provider_auth', () => {
      const result = classifyRunError('authentication_error: invalid key');
      expect(result.errorKind).toBe('provider_auth');
    });

    it('classifies "invalid authentication credentials" as provider_auth', () => {
      const result = classifyRunError('invalid authentication credentials supplied');
      expect(result.errorKind).toBe('provider_auth');
    });

    it('classifies "invalid auth" substring as provider_auth', () => {
      const result = classifyRunError('failed to authenticate with server');
      expect(result.errorKind).toBe('provider_auth');
    });

    it('classifies "401" as provider_auth', () => {
      const result = classifyRunError('HTTP 401 Unauthorized');
      expect(result.errorKind).toBe('provider_auth');
    });

    it('is case-insensitive', () => {
      const result = classifyRunError('AUTHENTICATION_ERROR');
      expect(result.errorKind).toBe('provider_auth');
    });

    it('populates hint and action for known provider', () => {
      const result = classifyRunError('authentication_error', { provider: 'claude', model: 'opus' });
      expect(result.errorHint).toContain('claude (opus)');
      expect(result.errorAction).toContain('Sign in to Claude');
    });

    it('populates generic action for non-claude provider', () => {
      const result = classifyRunError('authentication_error', { provider: 'codex' });
      expect(result.errorHint).toContain('codex');
      expect(result.errorAction).toContain('Refresh the provider credentials');
    });

    it('uses "the provider" when no provider specified', () => {
      const result = classifyRunError('authentication_error');
      expect(result.errorHint).toContain('the provider');
    });
  });

  describe('provider_startup errors', () => {
    it('classifies "query closed before response received" as provider_startup', () => {
      const result = classifyRunError('query closed before response received');
      expect(result.errorKind).toBe('provider_startup');
    });

    it('populates hint and action for provider_startup', () => {
      const result = classifyRunError('query closed before response received');
      expect(result.errorHint).toBeTruthy();
      expect(result.errorAction).toBeTruthy();
      expect(result.errorHint).toContain('transient');
      expect(result.errorAction).toContain('Retry');
    });
  });

  describe('generic errors', () => {
    it('returns kind "generic" for unknown error messages', () => {
      const result = classifyRunError('something totally unexpected happened');
      expect(result.errorKind).toBe('generic');
    });

    it('has null hint and action for generic errors', () => {
      const result = classifyRunError('unknown failure');
      expect(result.errorHint).toBeNull();
      expect(result.errorAction).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns nulls for empty string', () => {
      const result = classifyRunError('');
      expect(result.errorKind).toBeNull();
      expect(result.errorHint).toBeNull();
      expect(result.errorAction).toBeNull();
    });

    it('returns nulls for null input', () => {
      const result = classifyRunError(null);
      expect(result.errorKind).toBeNull();
      expect(result.errorHint).toBeNull();
      expect(result.errorAction).toBeNull();
    });

    it('returns nulls for undefined input', () => {
      const result = classifyRunError(undefined);
      expect(result.errorKind).toBeNull();
      expect(result.errorHint).toBeNull();
      expect(result.errorAction).toBeNull();
    });

    it('returns nulls for whitespace-only input', () => {
      const result = classifyRunError('   ');
      expect(result.errorKind).toBeNull();
      expect(result.errorHint).toBeNull();
      expect(result.errorAction).toBeNull();
    });
  });
});
