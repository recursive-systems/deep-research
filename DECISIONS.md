# Architecture Decision Records

## ADR-1: ACP-based provider abstraction

**Status:** Accepted

**Context:** Deep research needs to run iterative prompts against multiple AI providers (Claude, Codex, Z.AI) without coupling the core loop to any provider's SDK or API format. Each provider has a different binary (claude-agent-acp, codex-acp, opencode), different authentication, and different model selection mechanisms. The system must be able to add providers without modifying the iteration logic in worker.js.

**Decision:** Use the Agent Client Protocol (ACP) as the sole interface between deep-research and provider agents. `acp-runner.js` spawns the provider binary as a child process, communicates over JSON-RPC on stdio using `@agentclientprotocol/sdk`, and exposes a uniform `runAcpIteration()` function. The ACP connection handles session creation, model selection (via `session/set_model` or config options), permission grants, filesystem sandboxing, and streaming updates through a single `ResearchClient` callback object. Provider-specific concerns (e.g., generating an opencode config file for Z.AI) are isolated in resolution functions.

**Consequences:**
- Adding a new provider requires only a binary entry in `PROVIDER_BINARIES` and optionally a resolver function -- no changes to the worker or evaluator.
- The system depends on each provider shipping an ACP-compatible adapter binary. If a provider breaks ACP compatibility, that provider is unusable until the adapter is fixed.
- Filesystem access is sandboxed via `ensureUnderRoot()`, so each agent can only read/write within its designated output directory.
- Permission requests are auto-resolved (allow_once first), which means the system cannot run agents that require interactive human approval.
- Transient startup failures (connection resets, closed queries) are retried automatically for Claude but not other providers, reflecting observed reliability differences.

---

## ADR-2: Filesystem-as-database

**Status:** Accepted

**Context:** Deep research manages topics, runs, iterations, evaluations, logs, and event traces. The data is inherently document-oriented (markdown reports, JSON metadata, NDJSON event streams). The tool runs locally on developer machines and needs to be inspectable without special tooling. Runs produce large text artifacts (reports, source lists, iteration logs) that do not fit naturally into relational tables.

**Decision:** Store all state as files under `~/.deep-research/` (configurable via `DEEP_RESEARCH_HOME`). The layout is `topics/{slug}/topic.json`, `runs/{run-id}/run.json`, with sibling files for `brief.md`, `report.md`, `sources.md`, `stdout.log`, `events.ndjson`, and subdirectories for `iterations/`, `library/`, and `evaluations/`. Metadata writes use atomic temp-file-plus-rename (`writeJson` writes to `{path}.tmp-{pid}-{timestamp}` then `fs.rename`). Event streams use append-only NDJSON.

**Consequences:**
- Any file manager, text editor, or `cat` command can inspect state. No database client or migration tooling is required.
- Atomic rename prevents partial JSON writes from corrupting metadata on crash.
- NDJSON append is safe for concurrent reads but not for concurrent writes to the same file; this is acceptable because each run is driven by a single worker process.
- Listing all runs requires scanning the `runs/` directory and reading each `run.json`, which is O(n) in run count. This is fine for the expected scale (tens to low hundreds of runs) but would not scale to thousands without an index.
- Deleting a topic cascades to its runs by iterating and removing run directories, which is straightforward but not transactional -- a crash mid-delete could leave orphaned run directories.
- The file layout doubles as the ACP agent's working directory, so the agent can directly read `brief.md` and write `report.md` without any abstraction layer.

---

## ADR-3: Preact + ESM CDN dashboard (no build step)

**Status:** Accepted

**Context:** The dashboard is a secondary interface for monitoring research runs. It needs to render topic lists, run details, evaluation charts, and file contents. The development team is small and iteration speed matters more than bundle optimization. The tool is served locally by a bare `node:http` server on localhost.

**Decision:** Serve the dashboard as static HTML with native ES module imports. `index.html` uses an import map to load Preact and htm from esm.sh CDN. Components (`components/App.js`, `components/DetailView.js`, `components/EvalSection.js`, `components/FileExplorer.js`, `components/Modals.js`, `components/ResearchList.js`, `components/Topbar.js`) use `htm` tagged templates instead of JSX, eliminating the need for a transpiler. Utility modules (`lib/api.js`, `lib/format.js`, `lib/html.js`, `lib/sse.js`) are plain ES modules.

**Consequences:**
- Zero build configuration: no webpack, no vite, no babel. Editing a `.js` file and refreshing the browser is the full development loop.
- The dashboard requires an internet connection on first load to fetch Preact and htm from the CDN (browser cache covers subsequent loads).
- htm tagged templates are slightly more verbose than JSX and lack IDE support for component prop validation, but they are standard JavaScript that runs natively in browsers.
- Preact's 3KB footprint keeps the dashboard lightweight. Moving to React later would require introducing a build step or switching the CDN target.
- No minification, tree-shaking, or code splitting. This is acceptable for a localhost tool but would need revisiting if the dashboard were ever served publicly.

---

## ADR-4: Evaluation rubric design

**Status:** Accepted

**Context:** Each research iteration produces a report that needs automated quality assessment to track progress across iterations and surface regressions. The evaluation must be reproducible, multi-dimensional (a single score hides too much), and grounded in verifiable evidence where possible. Early iterations showed that LLM judges tend to hallucinate source quality claims, so an objective source verification signal was needed.

**Decision:** Define 9 model-scored dimensions plus 1 system-computed dimension. The model scores (via `PROMPT_evaluate.md`) are: `brief_coverage` (does the report address the brief), `directness` (does it answer without wandering), `coherence` (organization and clarity), `citation_coverage` (are claims cited), `source_quality` (are sources credible), `specificity` (concrete details and actionable substance), `brevity` (efficient expression), `uncertainty_honesty` (are uncertainties marked), and `support_confidence` (low risk of unsupported leaps). The system adds `source_resolvability` by performing HEAD/GET requests against up to 12 cited URLs, classifying each as resolved, redirected, restricted, not_found, timeout, or network_error, and computing a score from the ratio of resolvable URLs. The overall score is the average of all 10 dimensions. The judge also produces `strengths`, `weaknesses`, and a narrative `judgment.md`.

**Consequences:**
- The 10-dimension breakdown lets the worker and dashboard show exactly where a report is weak (e.g., high coherence but low citation_coverage), guiding the next iteration's prompt.
- Source URL auditing provides an objective, non-LLM signal that catches fabricated or dead links. The 4-second timeout and 12-entry cap keep evaluation fast.
- The judge is instructed not to call sources fabricated solely because they are unfamiliar or post-training-cutoff, reducing false negatives from knowledge gaps.
- The rubric is versioned (`research-v2`) so historical evaluations remain comparable even if scoring criteria change.
- Running the judge itself requires an ACP provider call, doubling the per-iteration cost. This is a deliberate tradeoff: automated evaluation after every iteration enables unattended multi-iteration runs where quality is tracked without human review.
- The 1-5 integer scale with conservative rounding (via `safeScore`) sacrifices granularity for consistency across different judge models.

---

## ADR-5: Template-based prompt system

**Status:** Accepted

**Context:** Research and evaluation prompts need to inject runtime values (iteration number, output directory, topic iteration count) and conditionally include sections (e.g., final-iteration instructions). The prompts are authored as markdown files in `prompts/` so they can be reviewed and edited without touching code. A general-purpose templating library (Handlebars, Mustache, Nunjucks) could handle this but adds a dependency and a conceptual layer.

**Decision:** Use simple string replacement in `prompt.js` (~50 lines). Variables use `{{VAR}}` syntax with `replaceAll`. Conditionals use `{{#if FINAL_ITERATION}}...{{/if}}` with a regex strip for the false branch. The evaluation prompt in `evaluator.js` uses the same `replaceAll` pattern for its own variables (`{{BRIEF_BLOCK}}`, `{{SOURCE_AUDIT_BLOCK}}`, etc.) and wraps content in fenced blocks via a `fencedBlock()` helper. The `combineSystemAndTaskPrompt` function concatenates the AGENTS.md system prompt with the materialized task prompt.

**Consequences:**
- The entire prompt pipeline is ~50 lines of plain JavaScript with no dependencies beyond `node:fs`. It is trivial to audit and debug.
- Adding a new variable requires adding one `replaceAll` call. Adding a new conditional block type would require extending the regex, but the current single-conditional pattern has been sufficient.
- There is no escaping, no partials, no loops, and no inheritance. If prompts grow significantly more complex (e.g., per-source iteration blocks), a real templating library would become worthwhile.
- Prompt files are valid markdown that renders readably even with the `{{VAR}}` placeholders, making them easy to review in any markdown viewer.
- The `fencedBlock()` helper in the evaluator ensures artifacts are wrapped in code fences with consistent formatting, preventing markdown injection from report content into the judge prompt structure.
