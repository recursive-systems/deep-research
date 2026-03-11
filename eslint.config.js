import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/**', '.tmp/**'],
  },
  js.configs.recommended,
  prettierConfig,
  {
    rules: {
      // Prevent silent error swallowing. Every catch block must have a body.
      // Use `catch (_err) { /* intentionally ignored: <reason> */ }` for deliberate no-ops.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        EventSource: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        confirm: 'readonly',
        requestAnimationFrame: 'readonly',
      },
    },
  },
];
