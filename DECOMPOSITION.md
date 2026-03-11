# Decomposition: Deep Research — Autonomous Agent Readiness

## Thinking Tasks (Human) — RESOLVED

- [x] **Eval-driven loop behavior** — Inject weaknesses into next prompt: YES. Auto-stop on plateau: NO (defer until more evaluation data is collected). The whole point of evaluations is to gather data first.
- [x] **Hard ceilings for open-ended runs** — MAX_OPEN_ENDED_ITERATIONS = 5, MAX_OPEN_ENDED_MINUTES = 30.
- [x] **Test framework** — vitest (ESM-native, zero-config).
- [x] **Lint strictness** — Flat ESLint config + Prettier. No style opinions beyond formatting.

---

## Execution Tasks (Agent) — ALL COMPLETE

### Phase 1: Documentation Foundation

- [x] **1.1 — Create ARCHITECTURE.md** — Module map, data model, execution flow, API surface, key invariants.
- [x] **1.2 — Create DECISIONS.md** — 5 ADRs: ACP abstraction, filesystem-as-DB, Preact+CDN dashboard, eval rubric, prompt templates.
- [x] **1.3 — Create project AGENTS.md** — Agent guide for modifying this codebase (distinct from prompts/AGENTS.md).

### Phase 2: Linting & Formatting

- [x] **2.1 — Add ESLint + Prettier config** — Flat ESLint config + Prettier, `npm run lint/format/format:check` scripts.
- [x] **2.2 — Auto-format entire codebase** — 21 files formatted, zero logic changes.
- [x] **2.3 — Fix all lint violations** — Unused imports removed, scope fixes, browser globals configured.

### Phase 3: Test Foundation (131 tests)

- [x] **3.1 — vitest + error-classifier tests** — 16 tests.
- [x] **3.2 — store.js CRUD tests** — 24 tests (topics + runs + concurrent update).
- [x] **3.3 — store.js security tests** — 9 tests (path traversal, null bytes, backslash, absolute paths).
- [x] **3.4 — prompt.js tests** — 33 tests (variable replacement, conditionals, PRIOR_EVAL, edge cases).
- [x] **3.5 — acp-runner model matching tests** — 17 tests (exact, substring, normalization, ambiguity).
- [x] **3.6 — evaluator parsing tests** — 32 tests (safeScore, normalizePayload, extractInlineArtifact, schema validation warnings).

### Phase 4: Critical Bug Fixes

- [x] **4.1 — File locking for updateRun/updateTopic** — `withFileLock()` helper, exclusive lock files, 2s retry timeout.
- [x] **4.2 — Zombie process detection** — Server startup scans for stale running PIDs, marks as failed.
- [x] **4.3 — PID identity verification** — Pidfile at `{runDir}/worker.pid`, verified before SIGTERM.
- [x] **4.4 — Hard ceiling for open-ended runs** — 5 iterations / 30 minutes, 80% warning, clean completion.
- [x] **4.5 — Server error handling** — ApiError class, 400/404/409/500 distinction, stderr logging for unexpected errors.
- [x] **4.6 — Evaluator schema validation** — Warnings on missing/malformed scores, graceful fallback preserved.

### Phase 5: Eval-Driven Feedback Loop

- [x] **5.1 — Prior eval injection** — `formatPriorEval()` in prompt.js, `lastEval` tracking in worker.js, `{{PRIOR_EVAL}}` in template.
- [ ] ~~**5.2 — Score-plateau detection**~~ — DEFERRED. Need more evaluation data first.
- [x] **5.3 — Eval feedback in PROMPT_research.md** — `{{#if PRIOR_EVAL}}` block with weakness-prioritization instructions.

### Phase 6: Hardening & Polish

- [x] **6.1 — NDJSON append atomicity** — `fs.open(O_APPEND)` + pre-encoded Buffer writes.
- [x] **6.2 — Temp directory cleanup** — Startup + 30-min interval, removes dirs older than 2 hours.
- [x] **6.3 — Iteration count integrity** — Cross-check file count vs run.json, use Math.min, skip empty files.

---

## Final Stats

| Metric | Value |
|--------|-------|
| Tasks completed | 22/23 (1 deferred) |
| Tests | 131 passing |
| Lint errors | 0 |
| Format violations | 0 |
| New files | ARCHITECTURE.md, DECISIONS.md, AGENTS.md, eslint.config.js, .prettierrc, vitest.config.js, 6 test files |
| Modified files | worker.js, store.js, evaluator.js, acp-runner.js, launcher.js, server.js, config.js, prompt.js, PROMPT_research.md, package.json, eslint.config.js, + all formatted files |
