# Deep Research Architecture

Iterative research tool that spawns ACP-based AI agents in a loop, progressively building a research report on the filesystem. Supports multiple providers (Claude, Codex, Z.AI) and includes a web dashboard with SSE live updates.

## Module Map

```
src/
├── cli.js              CLI entry point. Parses argv, dispatches to store/launcher.
│                       Imports: store, config, launcher
│
├── core/
│   ├── config.js       Constants: PACKAGE_ROOT, PROMPTS_DIR, PUBLIC_DIR,
│   │                   getRuntimeHome(), getStorePaths(), PROVIDER_BINARIES,
│   │                   PROVIDER_DEFAULT_MODELS. No deps.
│   │
│   ├── store.js        All filesystem CRUD for topics, runs, events, logs.
│   │                   Exports: ensureStore, createTopic, ensureTopic, readTopic,
│   │                   listTopics, deleteTopic, updateTopic, readTopicBrief,
│   │                   createRun, readRun, updateRun, appendRunEvent, listRuns,
│   │                   listRunsByStatus, listRunsForTopic, readRunLog, deleteRun, listRunFiles,
│   │                   readRunFile, readRunEvaluations (re-exported via evaluator)
│   │                   Imports: config
│   │
│   ├── launcher.js     Spawns worker.js as a child process.
│   │                   Exports: launchRunDetached, launchRunAttached, stopRun
│   │                   Imports: store
│   │
│   ├── worker.js       Standalone Node script (not imported, spawned by launcher).
│   │                   Owns the iteration loop for one run. Handles SIGTERM/SIGINT.
│   │                   Imports: store, acp-runner, evaluator, prompt, error-classifier
│   │
│   ├── acp-runner.js   Spawns an ACP provider binary, drives the ACP protocol
│   │                   over stdio (ndjson). Implements ResearchClient (fs sandbox).
│   │                   Exports: runAcpIteration
│   │                   Imports: config, @agentclientprotocol/sdk
│   │
│   ├── evaluator.js    Runs a judge ACP session after each iteration. Audits
│   │                   source URLs via HTTP HEAD, computes rubric scores.
│   │                   Exports: evaluateRunIteration, readRunEvaluations
│   │                   Imports: config, store, acp-runner
│   │
│   ├── prompt.js       Loads and materializes prompt templates with variables.
│   │                   Exports: loadPromptTemplates, materializeIterationPrompt,
│   │                   combineSystemAndTaskPrompt
│   │                   Imports: config
│   │
│   └── error-classifier.js  Classifies error messages into errorKind/errorHint/errorAction.
│                        Exports: classifyRunError. No deps.
│
├── server/
│   └── server.js       HTTP server (port 4310). Serves REST API + static files
│                        from public/. Watches runsRoot via fs.watch for SSE.
│                        Imports: store, launcher, evaluator, config
│
prompts/
├── AGENTS.md           System prompt: agent identity and core rules
├── PROMPT_research.md  Per-iteration task prompt template ({{ITERATION}}, etc.)
└── PROMPT_evaluate.md  Evaluation/judge prompt template ({{BRIEF_BLOCK}}, etc.)
```

### Dependency graph (core only)

```
config  <──  store  <──  launcher  ──>  worker (spawned as child process)
  │            │                           │
  │            └─────────────────────────── ├──  acp-runner  <──  @agentclientprotocol/sdk
  │                                        ├──  evaluator   ──>  acp-runner
  └──  prompt                              ├──  prompt
                                           └──  error-classifier
```

## Data Model

All runtime state lives under `DEEP_RESEARCH_HOME` (default `~/.deep-research/`, override via env var).

```
~/.deep-research/
├── topics/
│   └── <topic-slug>/
│       ├── topic.json          { id, slug, title, createdAt, updatedAt, latestRunId }
│       └── brief.md            Original research question
│
├── runs/
│   └── <run-id>/               run-id = "run-<ISO timestamp>-<6 hex>"
│       ├── run.json            Canonical run state (see fields below)
│       ├── brief.md            Copy of topic brief (or inherited from base run)
│       ├── report.md           Evolving research report
│       ├── sources.md          Numbered reference list
│       ├── stdout.log          Append-only worker log
│       ├── events.ndjson       Structured event stream (one JSON per line)
│       ├── evaluations.ndjson  Evaluation records (one JSON per line)
│       ├── prompt-NNN.md       Materialized prompt for each iteration
│       ├── iterations/
│       │   ├── 001.md          Iteration log written by the agent
│       │   ├── 002.md
│       │   └── ...
│       ├── library/
│       │   └── *.md            Working documents created by the agent
│       └── evaluations/
│           ├── NNN-<timestamp>.json   Per-iteration evaluation record
│           └── NNN-<timestamp>.md     Judge's markdown memo
│
└── tmp/
    ├── evaluations/            Temporary judge workspaces (cleaned up after use)
    └── zai-opencode-*.json     Temporary OpenCode config files for Z.AI provider
```

### run.json fields

```
id, topicSlug, topicTitle, status, provider, model,
requestedIterations, completedIterations, maxMinutes,
createdAt, updatedAt, startedAt, endedAt,
pid, exitCode, error, errorKind, errorHint, errorAction,
baseRunId, topicIterationOffset, runDir, logFile, eventsFile
```

Status values: `created` -> `queued` -> `running` -> `completed` | `stopped` | `failed`
Note: The `queued` state is only used for detached runs. Attached runs transition directly from `created` to `running`.

## Execution Flow

```
CLI (cli.js)
  │
  ├─ "start" ──> ensureTopic() + createRun() + launchRunDetached/Attached()
  ├─ "run"   ──> createRun() + launch
  └─ "resume"──> readRun(baseRunId) + createRun(baseRunId) + launch
                    │
                    │  createRun copies state from base run (brief, report, sources, library)
                    │  and computes topicIterationOffset = base.offset + base.completedIterations
                    │
                    ▼
launcher.js
  │  spawn(worker.js, --run-id <id>)
  │  detached: stdio='ignore', child.unref()
  │  attached: stdio='inherit', wait for exit
  │
  ▼
worker.js  (runs in its own process)
  │
  │  1. updateRun(status='running', pid=process.pid)
  │  2. loadPromptTemplates()
  │  3. FOR iteration = completedIterations+1 .. requestedIterations:
  │     │
  │     │  a. Check stopRequested, check time limit
  │     │  b. materializeIterationPrompt() + combineSystemAndTaskPrompt()
  │     │  c. Write prompt-NNN.md
  │     │  d. appendRunEvent('iteration.started')
  │     │  e. runAcpIteration(provider, model, runDir, prompt)
  │     │     │
  │     │     │  Spawns provider binary (claude-agent-acp / codex-acp / opencode)
  │     │     │  Communicates via ACP protocol over stdio (ndjson)
  │     │     │  ResearchClient handles:
  │     │     │    - permission requests (auto-approve allow_once)
  │     │     │    - readTextFile / writeTextFile (sandboxed to runDir)
  │     │     │    - session updates (streamed to log)
  │     │     │  Agent reads/writes: brief.md, report.md, sources.md,
  │     │     │    iterations/NNN.md, library/*.md
  │     │     │
  │     │  f. evaluateRunIteration()
  │     │     │
  │     │     │  Creates temp workspace, copies artifacts
  │     │     │  Audits source URLs via HTTP HEAD (up to 12, concurrency 4)
  │     │     │  Materializes judge prompt with artifacts + audit results
  │     │     │  Runs a second ACP session to produce evaluation.json + judgment.md
  │     │     │  Computes composite score (9 model scores + source_resolvability)
  │     │     │  Appends to evaluations.ndjson, saves to evaluations/ dir
  │     │     │  Cleans up temp workspace
  │     │     │
  │     │  g. updateRun(completedIterations=iteration)
  │     │  h. appendRunEvent('iteration.completed')
  │     │
  │  4. updateRun(status='completed'|'stopped'|'failed')
```

## API Surface

### CLI commands (src/cli.js)

| Command | Description |
|---|---|
| `topic create --brief[-file]` | Create a topic |
| `topic list` | List topics |
| `start --brief "<text>" [opts]` | Create topic + run in one step |
| `run <topic-slug> [opts]` | New run for existing topic |
| `resume <run-id> [opts]` | New run that continues from a base run |
| `list` | List all runs |
| `status <run-id\|topic-slug>` | Show run or topic details |
| `logs <run-id> [--follow]` | Print/tail run log |
| `stop <run-id>` | SIGTERM the worker |
| `delete <run-id>` | Remove run directory |
| `serve` | Start the web dashboard |

Common flags: `--provider claude|codex|zai`, `--model NAME`, `--iterations N`, `--max-minutes M`, `--detach`, `--json`

### REST API (src/server/server.js, port 4310)

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/topics` | List topics with latest run |
| POST | `/api/topics` | Create topic |
| DELETE | `/api/topics/:slug` | Delete topic and its runs |
| GET | `/api/topics/:slug/runs` | List runs for topic |
| POST | `/api/start` | Create topic + run + launch (detached) |
| GET | `/api/runs` | List all runs (enriched with log summary) |
| POST | `/api/runs` | Create + launch a run |
| GET | `/api/runs/:id` | Single run detail |
| GET | `/api/runs/:id/logs` | Full log text |
| GET | `/api/runs/:id/files` | List run files |
| GET | `/api/runs/:id/file?path=X` | Read a specific run file (sandboxed) |
| GET | `/api/runs/:id/evaluations` | Evaluation history |
| POST | `/api/runs/:id/stop` | Stop a running run |
| DELETE | `/api/runs/:id` | Delete a run |
| GET | `/api/events` | SSE stream |

### SSE events

| Event | Trigger |
|---|---|
| `run:updated` | run.json or stdout.log changes (debounced 500ms via fs.watch) |
| `run:evaluations` | evaluations.ndjson changes (300ms delay) |
| `topic:updated` | Topic created, deleted, or run started/deleted |

Keepalive ping (`:` comment) every 30 seconds.

## Key Invariants

### Atomic JSON writes
`writeJson()` in store.js writes to a temp file (`<path>.tmp-<pid>-<timestamp>`) then renames. This prevents partial reads if the worker crashes mid-write. All run.json and topic.json mutations go through this path.

### ACP protocol over stdio
The worker spawns a provider binary and communicates via ndjson on stdin/stdout. The `@agentclientprotocol/sdk` handles framing. stderr is forwarded to the log. The child process is killed via SIGTERM on stop/abort.

### Filesystem sandbox in ResearchClient
`readTextFile` and `writeTextFile` in acp-runner.js call `ensureUnderRoot()` which resolves the path and checks it starts with one of the allowed roots (just `outputDir`, i.e., the run directory). This prevents the agent from reading/writing outside its sandbox.

### readRunFile path enforcement
`readRunFile()` in store.js uses an allowlist of top-level filenames and a strict two-level prefix check (`iterations/*.md`, `library/*.md`, `evaluations/*.{md,json}`) plus a `startsWith(runDir + sep)` guard. This is the server-side equivalent of the ACP sandbox.

### Resume chains via baseRunId + topicIterationOffset
When a run is created with a `baseRunId`, `createRun()` copies the base run's artifacts (brief, report, sources, library) into the new run directory. It computes `topicIterationOffset` by walking the chain: `base.offset + base.completedIterations`. The worker uses this so iteration numbering is continuous across runs for the same topic (e.g., run 1 does iterations 1-3, run 2 starts at topic iteration 4). If no explicit `baseRunId` is given, the topic's `latestRunId` is used.

### Graceful stop
SIGTERM/SIGINT set `stopRequested=true`. The worker finishes the current ACP operation (or aborts it), runs evaluation on partial results if judgeable artifacts exist, then writes `status='stopped'`. The hard timeout (via `maxMinutes`) also sets `stopRequested` and calls `abortActiveIteration()`.

### Provider model selection
For Claude and Codex, model selection happens via ACP (`unstable_setSessionModel` or `setSessionConfigOption`). For Z.AI, the model is baked into a generated OpenCode config file written to the tmp directory, bypassing ACP model selection.
