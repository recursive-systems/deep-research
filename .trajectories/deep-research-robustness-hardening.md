# Deep Research Robustness Hardening

**Date:** 2026-03-11
**Duration:** ~90 minutes
**Outcome:** success

## Goal

Make the deep-research tool robust enough for autonomous agent iteration. Ensure maximum context exists for agents to independently improve the project — documentation, tests, guardrails, and an eval-driven feedback loop.

## Approach

Followed a pipeline that emerged as a repeatable pattern:

1. **Legibility audit** (`/legibility`) — scored the codebase on 7 agent-readiness metrics. Got a B overall with specific gaps: no tests (C), no linting (C), no decision records (C).
2. **Edge-case review** (`/edge-cases`) — adversarial review found 6 critical/high issues (store races, zombie processes, PID recycling, open-ended run ceiling, evaluator schema, server error handling).
3. **Decomposition** (`/decompose`) — broke all work into 23 atomic tasks across 6 phases with a dependency graph and parallel execution groups.
4. **Human decisions** — 4 thinking tasks resolved upfront: eval feedback yes / auto-stop no, 5 iter / 30 min ceiling, vitest, flat ESLint + Prettier.
5. **Parallel execution** — launched tasks in dependency groups:
   - Group A: 8 independent tasks simultaneously (docs, config, first test, bug fixes)
   - Group B: 7 tasks after Group A (format, remaining tests)
   - Group C: 3 tasks after Group B (lint fixes, file locking, eval validation)
   - Group D+E: 5 final tasks (eval feedback loop, hardening)
6. **Triple review** — ran code-reviewer, silent-failure-hunter, and comment-analyzer in parallel on all changes. Found 17 silent failure issues, 3 code quality issues, 13 doc accuracy issues.
7. **Fix round** — 3 fix agents in parallel (one per file group to avoid conflicts), then a cleanup pass for remaining review items.
8. **Second edge-case review** — re-ran `/edge-cases` on the NEW code. Found 2 high-severity issues (stale lock recovery, zombie PID source). Fixed both.

## Key files modified

- `src/core/store.js` — file locking (withFileLock + stale recovery), NDJSON atomicity, exists() safety, listRunsByStatus
- `src/core/worker.js` — pidfile, hard ceiling, eval feedback, iteration count integrity
- `src/server/server.js` — ApiError, zombie cleanup, temp cleanup, SSE error logging, unhandled rejection catch
- `src/core/launcher.js` — PID verification via pidfile
- `src/core/evaluator.js` — schema validation warnings, deduped appendJsonLine
- `src/core/prompt.js` — PRIOR_EVAL support with template injection escape
- `prompts/PROMPT_research.md` — eval feedback conditional block
- New: ARCHITECTURE.md, DECISIONS.md, AGENTS.md, DECOMPOSITION.md
- New: eslint.config.js, .prettierrc, vitest.config.js
- New: 6 test files (131 tests total)

## What worked

- **Parallel agent execution was the biggest win.** Group A ran 8 agents simultaneously, completing in ~3 minutes of wall time instead of ~25 minutes sequential.
- **Grouping tasks by file** prevented merge conflicts between parallel agents. Each agent owned distinct files.
- **Legibility → edge-cases → decompose pipeline** produced a comprehensive, actionable plan with minimal back-and-forth.
- **Triple review in parallel** (code-reviewer + silent-failure-hunter + comment-analyzer) caught issues that any single review would have missed.
- **Two-pass edge-case review** (before implementation + after) caught different classes of issues — the second pass found lock crash recovery and zombie PID source bugs that didn't exist before implementation.
- **Human decisions upfront** eliminated mid-task blockers. All 4 thinking tasks resolved before execution started.

## What didn't work

- **Formatting drift** — agents that modified files after the format pass left Prettier violations. Needed a re-format step. Should auto-format after every fix round.
- **Silent catch blocks** — nearly every agent that added error handling used empty `catch {}` blocks. This was the single most common misbehavior across ~30 agent invocations. Needs a guardrail.
- **Doc accuracy on first write** — agents writing docs made factual errors (wrong paths, "Express" instead of node:http, wrong import claims). Docs need a verification pass, not just a write pass.
- **Duplicate utility functions** — the evaluator agent created its own `appendJsonLine` instead of importing from store.js. Agents don't naturally look for existing utilities.

## Lessons learned

- **Pipeline > ad-hoc.** The sequence legibility → edge-cases → decompose → execute → review → edge-cases → harness is a repeatable recipe for hardening any codebase.
- **Group parallel tasks by file, not by feature.** Two agents editing the same file = conflicts. One agent per file = clean merges.
- **Review is not optional after parallel agent work.** Agents are individually competent but don't coordinate. The review pass caught 33 issues across the combined output.
- **Empty catch blocks are the #1 agent anti-pattern.** Every agent defaults to `catch {}` for error handling. This should be a lint rule.
- **Run edge-cases twice** — once on the plan, once on the implementation. Different bugs surface at each stage.
- **Decomposition should include parallel execution groups** as a first-class concept, not just a dependency graph.

## Related

- Commit: `a5e06667e4` — all changes in one commit
- `tools/deep-research/DECOMPOSITION.md` — full task list with completion status
- `tools/deep-research/DECISIONS.md` — 5 ADRs from this session
