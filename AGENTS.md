# Deep Research — Agent Guide

Guide for agents modifying the deep-research tool's source code. For the research agent's own system prompt, see `prompts/AGENTS.md` (that file is NOT this one).

## Quick start

```bash
cd tools/deep-research
npm install
npm test          # unit tests (vitest)
npm run lint      # eslint
npm run check     # syntax check all JS files
npm run serve     # start web dashboard on http://127.0.0.1:4310
```

## Validating changes

| Command | What it checks | When to run |
|---|---|---|
| `npm run check` | Node `--check` syntax on every .js/.mjs file | After any code change |
| `npm test` | Vitest unit tests | After any logic change |
| `npm run lint` | ESLint style rules | Before committing |
| `npm run format:check` | Prettier formatting | Before committing |
| `npm run smoke` | E2E smoke test (spawns a real ACP run) | After changing worker, acp-runner, or evaluator. Requires provider credentials. |

Always run at minimum `npm run check && npm test && npm run lint` before considering a change complete.

## Key invariants — do not break these

1. **Atomic JSON writes.** `writeJson()` in `src/core/store.js` writes to a temp file then renames. All `run.json` and `topic.json` mutations must go through this path. Never write JSON metadata directly with `fs.writeFile`.

2. **ACP protocol over stdio.** `acp-runner.js` spawns a provider binary and communicates via ndjson on stdin/stdout using `@agentclientprotocol/sdk`. Do not change the spawn/communication pattern (e.g., do not switch to HTTP or WebSocket).

3. **Filesystem layout is the API contract.** The directory structure under `~/.deep-research/` (topics, runs, iterations, library, evaluations) is read by the CLI, server, dashboard, and the ACP agent itself. Changing paths or filenames is a breaking change. See `ARCHITECTURE.md` for the full layout.

4. **Pidfile lifecycle.** The worker writes `process.pid` to `run.json` on start and the launcher reads it for `stopRun()`. The pid field must be set before the iteration loop begins and cleared (via status update) on exit.

5. **ESM throughout.** The project uses `"type": "module"` in package.json. All files use `import`/`export`. Do not introduce `require()` or CommonJS modules.

6. **Filesystem sandbox.** `ensureUnderRoot()` in `acp-runner.js` and the allowlist in `readRunFile()` in `store.js` restrict file access to the run directory. Do not weaken or bypass these guards.

7. **Resume chain math.** `topicIterationOffset = base.offset + base.completedIterations`. Iteration numbering must be continuous across resumed runs. Do not change how `createRun` computes the offset.

## Module responsibilities

See `ARCHITECTURE.md` for the full dependency graph and data model.

| File | Role |
|---|---|
| `src/cli.js` | CLI entry point. Parses argv, dispatches to store and launcher. |
| `src/core/config.js` | Constants: paths, provider binaries, default models. No dependencies. |
| `src/core/store.js` | All filesystem CRUD for topics, runs, events, logs. Atomic writes. |
| `src/core/launcher.js` | Spawns `worker.js` as a detached or attached child process. |
| `src/core/worker.js` | Standalone script (spawned, not imported). Owns the iteration loop for one run. |
| `src/core/acp-runner.js` | Spawns ACP provider binary, drives the protocol, sandboxes filesystem access. |
| `src/core/evaluator.js` | Runs a judge ACP session after each iteration. Audits source URLs. |
| `src/core/prompt.js` | Loads and materializes prompt templates with `{{VAR}}` substitution. |
| `src/core/error-classifier.js` | Classifies error strings into errorKind/errorHint/errorAction. |
| `src/server/server.js` | HTTP server (port 4310). REST API, static file serving, SSE events. |
| `public/` | Dashboard frontend. Preact + htm via ESM CDN imports. No build step. |
| `prompts/AGENTS.md` | System prompt sent to the research agent (not this file). |
| `prompts/PROMPT_research.md` | Per-iteration task prompt template. |
| `prompts/PROMPT_evaluate.md` | Evaluation/judge prompt template. |

## Common tasks

### Add a new REST API endpoint

1. Add the route handler in `src/server/server.js` inside the router dispatch logic.
2. Use existing store functions for data access; add new store functions in `src/core/store.js` if needed.
3. If the endpoint triggers SSE updates, emit the appropriate event type (`run:updated`, `topic:updated`).

### Add a new evaluation metric

1. Add the metric name and scoring instructions to `prompts/PROMPT_evaluate.md` in the rubric section.
2. Update the JSON schema the judge is asked to produce (also in `PROMPT_evaluate.md`).
3. In `src/core/evaluator.js`, add the new field to `safeScore()` extraction and include it in the composite score average.
4. Update the dashboard's `EvalSection.js` if the metric should be displayed.

### Add a new provider

1. Add the provider key, adapter binary name, and backend name to `PROVIDER_BINARIES` in `src/core/config.js`.
2. Add a default model to `PROVIDER_DEFAULT_MODELS` in `src/core/config.js`.
3. If the provider needs special setup (like Z.AI's generated config file), add a resolver function in `src/core/acp-runner.js`.
4. Test with `npm run smoke -- --provider <name>`.

### Modify the iteration prompt

1. Edit `prompts/PROMPT_research.md`. Variables use `{{VAR_NAME}}` syntax.
2. If you add a new variable, add the corresponding `replaceAll` call in `src/core/prompt.js` `materializeIterationPrompt()`.
3. Conditional sections use `{{#if VAR}}...{{/if}}` — see existing usage for the pattern.

### Add a new CLI command

1. Add the command handler in `src/cli.js` following the existing if-chain pattern.
2. Use store functions for data access; add `--json` output support for machine-readable output.

## Error handling — no silent catch blocks

**Never write empty `catch {}` or `.catch(() => {})`**. This was the #1 agent misbehavior observed during development — 17 instances found in a single review pass. Empty catches mask real errors (EACCES, EIO, EMFILE) as silent no-ops.

**Required pattern:**
```js
// Good — log the error
} catch (err) {
  console.error(`[module] Failed to do X: ${err.message}`);
}

// Good — only silence specific expected errors
} catch (err) {
  if (err?.code !== 'ENOENT') throw err;
  // ENOENT is expected when file hasn't been created yet
}

// Good — deliberate no-op with explanation
} catch (_err) {
  // Intentionally ignored: cleanup failure is non-critical
}
```

**Enforced by:** ESLint `no-empty` rule (error level, `allowEmptyCatch: false`). `npm run lint` will fail on empty catch blocks.

## What NOT to do

- **Do not add a build step for the frontend.** The dashboard uses native ES module imports from a CDN. No webpack, vite, or babel. Edit a `.js` file and refresh the browser. See ADR-3 in `DECISIONS.md`.
- **Do not switch to a database.** The filesystem-as-database design is intentional. See ADR-2 in `DECISIONS.md`.
- **Do not add authentication or authorization.** This is a local-only tool running on localhost. Adding auth adds complexity with no security benefit.
- **Do not introduce CommonJS.** The entire project is ESM. No `require()`, no `module.exports`.
- **Do not bypass the ACP abstraction.** Do not call provider APIs directly. All provider interaction goes through `acp-runner.js` and the ACP protocol. See ADR-1 in `DECISIONS.md`.
- **Do not write JSON metadata files directly.** Always use `writeJson()` from store.js for atomic writes.
