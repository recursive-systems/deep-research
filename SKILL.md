---
name: deep-research
description: Run iterative deep research on a topic using ACP-based AI agents. Use when the user wants to research a subject in depth, manage research topics, or check on running research.
argument-hint: [brief-or-command]
---

# Deep Research — Iterative AI Research Tool

Launch and manage iterative research runs that progressively build a report on any topic. Each iteration spawns an ACP-based AI agent that reads the current state, researches further, and improves the report on the filesystem.

## Prerequisites

```bash
cd ${CLAUDE_SKILL_DIR} && npm install
```

Provider credentials must be available in the environment:
- **Claude**: Anthropic API key (via claude-agent-acp)
- **Codex**: OpenAI credentials (via codex-acp)
- **Z.AI**: `ZAI_API_KEY` environment variable

## Quick Reference

All commands run from `${CLAUDE_SKILL_DIR}`.

### Start a new research topic

```bash
# One-shot: create topic + start run
node ${CLAUDE_SKILL_DIR}/src/cli.js start --brief "Research the latest advances in autonomous agent architectures" --provider claude --iterations 3 --detach

# Or with a brief file
node ${CLAUDE_SKILL_DIR}/src/cli.js start --brief-file ~/briefs/my-topic.md --provider codex --iterations 5 --detach
```

### Manage topics

```bash
# Create a topic without starting a run
node ${CLAUDE_SKILL_DIR}/src/cli.js topic create --brief "Your research question here"

# List all topics
node ${CLAUDE_SKILL_DIR}/src/cli.js topic list
```

### Run iterations on an existing topic

```bash
# Start a new run for an existing topic
node ${CLAUDE_SKILL_DIR}/src/cli.js run <topic-slug> --provider claude --iterations 3 --detach

# Resume from where a previous run left off
node ${CLAUDE_SKILL_DIR}/src/cli.js resume <run-id> --iterations 2 --detach
```

### Monitor and control

```bash
# List all runs
node ${CLAUDE_SKILL_DIR}/src/cli.js list

# Check run status
node ${CLAUDE_SKILL_DIR}/src/cli.js status <run-id>

# Follow logs in real time
node ${CLAUDE_SKILL_DIR}/src/cli.js logs <run-id> --follow

# Stop a running research session
node ${CLAUDE_SKILL_DIR}/src/cli.js stop <run-id>

# Delete a run
node ${CLAUDE_SKILL_DIR}/src/cli.js delete <run-id>
```

### Web dashboard

```bash
node ${CLAUDE_SKILL_DIR}/src/cli.js serve
# Open http://127.0.0.1:4310
```

The dashboard shows topics, runs, iteration progress, evaluation scores, and live log streaming via SSE.

## Key Concepts

### Topics and Runs

- A **topic** holds a durable research brief (the question) and groups related runs.
- A **run** is an isolated filesystem workspace where an agent iterates on a report. Multiple runs can target the same topic.
- **Resuming** creates a new run that copies artifacts (report, sources, library) from a prior run, continuing iteration numbering where it left off.

### Iteration Loop

Each iteration:
1. Materializes a prompt with the current report state, sources, and prior evaluation feedback
2. Spawns an ACP agent that reads/writes files in the run directory
3. The agent improves `report.md`, updates `sources.md`, writes `iterations/NNN.md`
4. An evaluation judge scores the iteration on 9 dimensions (depth, accuracy, source quality, etc.)
5. Weaknesses from the evaluation are injected into the next iteration's prompt

### Providers

| Provider | Flag | Adapter | Default Model |
|---|---|---|---|
| Claude | `--provider claude` | claude-agent-acp | sonnet |
| Codex | `--provider codex` | codex-acp | gpt-5.4 |
| Z.AI | `--provider zai` | opencode | zai/glm-5 |

### Runtime Data

All state lives under `~/.deep-research/` (override with `DEEP_RESEARCH_HOME`):
- `topics/<slug>/` — topic.json + brief.md
- `runs/<run-id>/` — run.json, report.md, sources.md, iterations/, library/, evaluations/

### Output Artifacts

After a run completes, the key artifacts are:
- **`report.md`** — The final research report
- **`sources.md`** — Numbered reference list with URLs
- **`iterations/NNN.md`** — Per-iteration log of what the agent did
- **`evaluations/`** — Per-iteration evaluation scores and judge memos

## Common Agent Workflows

### "Research X for me"

```bash
cd ${CLAUDE_SKILL_DIR}
node src/cli.js start --brief "$ARGUMENTS" --provider claude --iterations 3 --detach
```

Then monitor with `node ${CLAUDE_SKILL_DIR}/src/cli.js logs <run-id> --follow` or open the dashboard.

### "How's my research going?"

```bash
node ${CLAUDE_SKILL_DIR}/src/cli.js list
node ${CLAUDE_SKILL_DIR}/src/cli.js status <run-id>
```

### "Keep researching — do more iterations"

```bash
cd ${CLAUDE_SKILL_DIR}
node src/cli.js resume <run-id> --iterations 3 --detach
```

### "Read the results"

The report is a plain markdown file:
```bash
cat ~/.deep-research/runs/<run-id>/report.md
```

Or read it via the REST API: `GET http://127.0.0.1:4310/api/runs/<run-id>/file?path=report.md`

## Flags Reference

| Flag | Applies to | Description | Default |
|---|---|---|---|
| `--provider` | `start`, `run`, `resume` | `claude`, `codex`, or `zai` | `claude` |
| `--model` | `start`, `run`, `resume` | Override the provider's default model | Provider default |
| `--iterations` | `start`, `run`, `resume` | Number of iterations to run | Open-ended (capped at 5) |
| `--max-minutes` | `start`, `run`, `resume` | Hard time ceiling | 30 minutes |
| `--detach` | `start`, `run`, `resume` | Run in the background | Attached |
| `--brief` | `start`, `topic create` | Research brief as a string | — |
| `--brief-file` | `start`, `topic create` | Load brief from a file path | — |
| `--slug` | `start`, `topic create` | Override auto-derived topic slug | Derived from brief |
| `--title` | `start`, `topic create` | Override auto-derived topic title | Derived from brief |
| `--json` | All commands | Machine-readable JSON output | Human-readable |
| `--follow` | `logs` | Tail logs continuously | One-shot |

## Guidelines

- **Always use `--detach` for long research runs.** Attached mode blocks the terminal and the run dies if the terminal closes.
- **Prefer explicit `--iterations`** over open-ended. Open-ended runs are capped at 5 iterations / 30 minutes.
- **Check status before resuming.** A run must be `completed`, `stopped`, or `failed` before it can be resumed.
- **The report improves with each iteration.** 3 iterations typically produces a solid report; 5+ for complex topics.
- **Use the dashboard for visual monitoring.** It shows evaluation scores, iteration diffs, and live logs.
