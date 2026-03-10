# Deep Research

Standalone deep research engine for iterative topic work, with a file-backed CLI and local dashboard.

## Runtime data

By default, runtime state is stored in `~/.deep-research`.

Override it with:

```bash
export DEEP_RESEARCH_HOME=/path/to/runtime
```

## Install

```bash
cd tools/deep-research
npm install
```

## CLI

```bash
# Create a topic
node src/cli.js topic create --brief "AI UI Research: Research the latest patterns for AI-generated UI systems."

# Run one iteration attached
node src/cli.js run ai-ui --provider codex --iterations 1

# Run in the background
node src/cli.js run ai-ui --provider claude --iterations 3 --detach

# Run with Z.AI via OpenCode ACP
ZAI_API_KEY=... node src/cli.js run ai-ui --provider zai --iterations 1 --detach

# Resume from a previous run snapshot
node src/cli.js resume run-... --iterations 2 --detach

# Inspect state
node src/cli.js list
node src/cli.js status run-...
node src/cli.js logs run-... --follow

# Stop or delete
node src/cli.js stop run-...
node src/cli.js delete run-...

# Provider smoke tests
npm run smoke:codex
npm run smoke:claude
npm run smoke:zai
npm run smoke:all
```

## Dashboard

```bash
cd tools/deep-research
npm run serve
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310)

## Current model

- Topics hold durable briefs and group related runs.
- Topic slug and title are derived automatically from the first non-empty line of the brief.
- Duplicate slugs fail fast with a clear error so callers can retry with a different brief.
- Runs are isolated filesystem workspaces, which makes parallel execution safe.
- Resuming creates a new run from a prior run snapshot instead of mutating history in place.

## Z.AI Provider

`provider=zai` is implemented by launching `opencode acp` with a generated OpenCode config pinned to Z.AI.

Requirements:

- `opencode` installed and available on `PATH`
- `ZAI_API_KEY` set in the environment

The generated OpenCode config:

- enables only the `zai` provider
- uses `https://api.z.ai/api/coding/paas/v4`
- injects the API key from `ZAI_API_KEY`
- defaults to `zai/glm-5` unless `DEEP_RESEARCH_MODEL` is set

## Smoke Tests

`smoke-test.mjs` runs a real end-to-end check through the CLI:

- creates a topic from a brief only
- verifies the derived topic slug
- launches a one-iteration detached run
- polls for completion
- checks `report.md`, `sources.md`, `iterations/001.md`, and a provider-specific `library/*.md`

For `npm run smoke:zai`, `ZAI_API_KEY` must be set.
