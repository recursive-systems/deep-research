# Deep Research

Iterative deep research engine that spawns AI agents in a loop, progressively building a research report. Each iteration reads the current state, researches further, and improves the report — with an evaluation judge scoring quality after every pass.

Supports multiple providers (Claude, Codex, Z.AI). Includes a CLI, REST API, and web dashboard with live updates.

## Install

```bash
git clone https://github.com/recursive-systems/deep-research.git
cd deep-research
npm install
```

**Requirements:** Node.js 18+

## Quick Start

### Option A: Dashboard (recommended)

```bash
npm run serve
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310), click **New Research**, enter a brief, pick a provider, and set iterations. The dashboard handles everything — creating topics, launching runs, live log streaming, evaluation scores, and reading results. No CLI needed.

### Option B: CLI

```bash
# One-shot: create topic + start run
node src/cli.js start --brief "Research the latest advances in autonomous agent architectures" \
  --provider claude --iterations 3 --detach

# Check progress
node src/cli.js list
node src/cli.js logs <run-id> --follow

# Read the report
cat ~/.deep-research/runs/<run-id>/report.md
```

## Providers

Each provider uses the [Agent Client Protocol (ACP)](https://github.com/anthropics/agent-client-protocol) over stdio. Claude and Codex adapters are included as npm dependencies. Z.AI requires a separate install.

| Provider | Flag | Adapter | Default Model | Setup |
|---|---|---|---|---|
| Claude | `--provider claude` | `claude-agent-acp` | `sonnet` | Included via npm |
| Codex | `--provider codex` | `codex-acp` | `gpt-5.4` | Included via npm |
| Z.AI | `--provider zai` | `opencode` | `zai/glm-5` | Install `opencode` separately, set `ZAI_API_KEY` |

### Z.AI setup

```bash
# Install opencode (must be on PATH)
# See https://opencode.ai for installation

# Set your API key
export ZAI_API_KEY=your-key-here

# Run
node src/cli.js start --brief "..." --provider zai --iterations 3 --detach
```

The Z.AI provider generates a temporary OpenCode config pinned to `https://api.z.ai/api/coding/paas/v4`. Override the model with `DEEP_RESEARCH_MODEL`.

## CLI Reference

```bash
node src/cli.js <command> [options]
```

### Commands

| Command | Description |
|---|---|
| `start --brief "..."` | Create a topic and start a run in one step |
| `topic create --brief "..."` | Create a topic without starting a run |
| `topic list` | List all topics |
| `run <topic-slug>` | Start a new run for an existing topic |
| `resume <run-id>` | Continue from where a previous run left off |
| `list` | List all runs |
| `status <run-id\|topic-slug>` | Show run or topic details |
| `logs <run-id>` | Print run log (`--follow` to tail) |
| `stop <run-id>` | Stop a running research session |
| `delete <run-id>` | Remove a run |
| `serve` | Start the web dashboard |

### Flags

| Flag | Applies to | Description | Default |
|---|---|---|---|
| `--provider` | `start`, `run`, `resume` | `claude`, `codex`, or `zai` | `claude` |
| `--model` | `start`, `run`, `resume` | Override the provider's default model | Provider default |
| `--iterations` | `start`, `run`, `resume` | Number of iterations to run | Open-ended (capped at 5) |
| `--max-minutes` | `start`, `run`, `resume` | Hard time ceiling | `30` |
| `--detach` | `start`, `run`, `resume` | Run in the background | Attached |
| `--brief` | `start`, `topic create` | Research brief as a string | — |
| `--brief-file` | `start`, `topic create` | Load brief from a file path | — |
| `--slug` | `start`, `topic create` | Override auto-derived topic slug | Derived from brief |
| `--title` | `start`, `topic create` | Override auto-derived topic title | Derived from brief |
| `--json` | All commands | Machine-readable JSON output | Human-readable |
| `--follow` | `logs` | Tail logs continuously | One-shot |

## Dashboard

```bash
npm run serve
# Open http://127.0.0.1:4310
```

The dashboard provides full feature parity with the CLI:

- **Create topics** and start runs with provider/model/iteration selection
- **Live monitoring** — real-time status, log streaming via SSE, iteration progress
- **Evaluation scores** — 9-dimension rubric (depth, accuracy, source quality, etc.) displayed per iteration
- **File explorer** — browse `report.md`, `sources.md`, iterations, and library files
- **Run management** — resume, stop, and delete runs
- **Topic management** — view all topics, delete topics and their runs

### REST API

The dashboard exposes a JSON API for programmatic use:

```bash
# Create topic + start run
curl -X POST http://127.0.0.1:4310/api/start \
  -H "Content-Type: application/json" \
  -d '{"brief": "Research quantum computing advances", "provider": "claude", "iterations": 3}'

# Check status
curl http://127.0.0.1:4310/api/runs/<run-id>

# Read the report
curl http://127.0.0.1:4310/api/runs/<run-id>/file?path=report.md

# List all runs
curl http://127.0.0.1:4310/api/runs

# Stop a run
curl -X POST http://127.0.0.1:4310/api/runs/<run-id>/stop

# SSE event stream (live updates)
curl http://127.0.0.1:4310/api/events
```

## How It Works

### Topics and runs

A **topic** holds a durable research brief and groups related runs. A **run** is an isolated filesystem workspace where an agent iterates on a report. Multiple runs can target the same topic, and **resuming** creates a new run that copies artifacts from a prior run and continues iteration numbering.

### Iteration loop

Each iteration:

1. Materializes a prompt with the current report state, sources, and prior evaluation feedback
2. Spawns an ACP agent that reads/writes files in the run directory
3. The agent improves `report.md`, updates `sources.md`, writes `iterations/NNN.md`
4. An evaluation judge scores the iteration on 9 dimensions
5. Weaknesses from the evaluation feed into the next iteration's prompt

### Output artifacts

| File | Description |
|---|---|
| `report.md` | The final research report |
| `sources.md` | Numbered reference list with URLs |
| `iterations/NNN.md` | Per-iteration log of what the agent did |
| `library/*.md` | Working documents created by the agent |
| `evaluations/` | Per-iteration evaluation scores and judge memos |

### Evaluation rubric

The judge scores each iteration on: brief coverage, directness, coherence, citation coverage, source quality, specificity, brevity, uncertainty honesty, and support confidence. A 10th dimension — source resolvability — is computed by HTTP-probing cited URLs.

## Claude Code Skill

Deep Research works as a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill. Clone the repo, symlink it, and invoke with `/deep-research`:

```bash
git clone https://github.com/recursive-systems/deep-research.git
cd deep-research && npm install
ln -s $(pwd) ~/.claude/skills/deep-research
```

Then in Claude Code:

```
/deep-research Research the latest advances in autonomous agent architectures
```

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `DEEP_RESEARCH_HOME` | Runtime data directory | `~/.deep-research` |
| `ZAI_API_KEY` | API key for Z.AI provider | — |
| `DEEP_RESEARCH_MODEL` | Model override for Z.AI | `zai/glm-5` |
| `HOST` | Server bind address | `127.0.0.1` |
| `PORT` | Server port | `4310` |

## Runtime Data

All state lives under `~/.deep-research/` (override with `DEEP_RESEARCH_HOME`):

```
~/.deep-research/
├── topics/<slug>/
│   ├── topic.json
│   └── brief.md
├── runs/<run-id>/
│   ├── run.json
│   ├── report.md
│   ├── sources.md
│   ├── stdout.log
│   ├── iterations/
│   ├── library/
│   └── evaluations/
└── tmp/
```

## Development

```bash
npm test              # Unit tests (vitest)
npm run lint          # ESLint
npm run check         # Syntax check all JS files
npm run format:check  # Prettier check
```

### Smoke tests

Run end-to-end tests against live providers:

```bash
npm run smoke:claude    # Test Claude
npm run smoke:codex     # Test Codex
npm run smoke:zai       # Test Z.AI (requires ZAI_API_KEY)
npm run smoke:all       # Test all providers
```

Each test creates a topic, runs one iteration, and validates the output artifacts.

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Contact

contact@recursivesystems.dev
