import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { PACKAGE_ROOT, PROVIDER_BINARIES } from './config.js';

function normalizeProvider(value) {
  const provider = String(value || 'claude')
    .trim()
    .toLowerCase();
  if (!Object.hasOwn(PROVIDER_BINARIES, provider)) {
    throw new Error(`Unsupported ACP provider: ${provider}`);
  }
  return provider;
}

async function resolveAgentCommand(provider, desiredModel = '') {
  if (provider === 'zai') {
    return resolveZaiCommand(desiredModel);
  }

  const binary =
    process.platform === 'win32'
      ? `${PROVIDER_BINARIES[provider].adapter}.cmd`
      : PROVIDER_BINARIES[provider].adapter;
  const localBinary = path.join(PACKAGE_ROOT, 'node_modules', '.bin', binary);

  try {
    await fs.access(localBinary);
    return { command: localBinary, args: [] };
  } catch {
    return { command: PROVIDER_BINARIES[provider].adapter, args: [] };
  }
}

async function resolveZaiCommand(desiredModel) {
  const binary = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
  const localBinary = path.join(PACKAGE_ROOT, 'node_modules', '.bin', binary);
  const env = await buildZaiOpenCodeEnv(desiredModel);

  try {
    await fs.access(localBinary);
    return { command: localBinary, args: ['acp'], env };
  } catch {
    return { command: 'opencode', args: ['acp'], env };
  }
}

export function zaiConfigFilePath(desiredModel) {
  const tmpRoot = process.env.DEEP_RESEARCH_TMP_ROOT || path.join(PACKAGE_ROOT, '.tmp');
  const suffix = Buffer.from(String(desiredModel || 'default'))
    .toString('base64url')
    .slice(0, 24);
  return path.join(tmpRoot, `zai-opencode-${process.pid}-${suffix}.json`);
}

export async function buildZaiOpenCodeEnv(desiredModel) {
  if (!process.env.ZAI_API_KEY) {
    throw new Error('Missing required ZAI_API_KEY for provider zai');
  }

  const model = desiredModel || process.env.DEEP_RESEARCH_MODEL || 'zai/glm-5';
  const configFile = zaiConfigFilePath(model);
  await fs.mkdir(path.dirname(configFile), { recursive: true });

  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      zai: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Z.AI',
        options: {
          baseURL: 'https://api.z.ai/api/coding/paas/v4',
          apiKey: '{env:ZAI_API_KEY}',
        },
      },
    },
    model,
    small_model: model,
    enabled_providers: ['zai'],
  };

  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return {
    ...process.env,
    OPENCODE_CONFIG: configFile,
  };
}

function ensureUnderRoot(targetPath, allowedRoots) {
  const resolved = path.resolve(targetPath);
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      return resolved;
    }
  }
  throw new Error(`Path is outside allowed roots: ${targetPath}`);
}

function pickPermissionOption(options) {
  return (
    options.find((option) => option.kind === 'allow_once') ||
    options.find((option) => option.kind === 'allow_always') ||
    options.find((option) => option.kind === 'reject_once') ||
    null
  );
}

function flattenConfigOptions(options) {
  return (options || [])
    .filter((option) => option?.type === 'select')
    .flatMap((option) => {
      const entries = option.options || [];
      const values = Array.isArray(entries)
        ? entries.flatMap((entry) => (Array.isArray(entry?.options) ? entry.options : [entry]))
        : [];
      return values.map((value) => ({ option, value }));
    });
}

export function scoreMatch(desired, ...candidates) {
  const normalized = desired.trim().toLowerCase();
  let best = 0;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = String(candidate).trim().toLowerCase();
    if (value === normalized) return 100;
    if (value.includes(normalized) || normalized.includes(value)) {
      best = Math.max(best, 60);
    } else if (value.replaceAll(/[^a-z0-9]+/g, '') === normalized.replaceAll(/[^a-z0-9]+/g, '')) {
      best = Math.max(best, 80);
    }
  }

  return best;
}

async function maybeSelectModel(connection, sessionResult, desiredModel, log) {
  if (!desiredModel) return;

  const models = sessionResult.models?.availableModels || [];
  const modelMatch = models
    .map((model) => ({
      model,
      score: scoreMatch(desiredModel, model.modelId, model.name, model.description),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (modelMatch?.score > 0 && modelMatch.model.modelId !== sessionResult.models?.currentModelId) {
    try {
      await connection.unstable_setSessionModel({
        sessionId: sessionResult.sessionId,
        modelId: modelMatch.model.modelId,
      });
      log(`[acp] using model ${modelMatch.model.name}`);
      return;
    } catch (error) {
      log(`[acp] model switch via session/set_model failed: ${error.message}`);
    }
  }

  const optionMatch = flattenConfigOptions(sessionResult.configOptions)
    .map(({ option, value }) => ({
      option,
      value,
      score:
        option.category === 'model'
          ? scoreMatch(desiredModel, value.value, value.name, value.description)
          : 0,
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (optionMatch?.score > 0) {
    await connection.setSessionConfigOption({
      sessionId: sessionResult.sessionId,
      optionId: optionMatch.option.id,
      value: optionMatch.value.value,
    });
    log(`[acp] using model ${optionMatch.value.name}`);
    return;
  }

  log(`[acp] requested model "${desiredModel}" was not exposed by the ACP agent`);
}

function shouldSelectModelViaAcp(provider) {
  // OpenCode already gets the model through the generated config file for Z.AI,
  // so ACP-side model selection is redundant and produces noisy false warnings.
  return provider !== 'zai';
}

function formatAcpError(error) {
  if (!error) {
    return 'Unknown ACP error';
  }

  const parts = [];
  if (error.message) {
    parts.push(error.message);
  }
  if (error.code != null) {
    parts.push(`code=${error.code}`);
  }
  if (error.data != null) {
    try {
      parts.push(`data=${JSON.stringify(error.data)}`);
    } catch {
      parts.push(`data=${String(error.data)}`);
    }
  }
  return parts.join(' | ') || String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStartupError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('query closed before response received') ||
    text.includes('acp session start failed') ||
    text.includes('acp initialize failed') ||
    text.includes('connection reset by peer')
  );
}

function forwardStderr(stream, log) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        void log(`[acp:stderr] ${trimmed}`);
      }
    }
  });
  stream.on('end', () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      void log(`[acp:stderr] ${trimmed}`);
    }
  });
}

class ResearchClient {
  constructor(allowedRoots, log) {
    this.allowedRoots = allowedRoots.map((root) => path.resolve(root));
    this.log = log;
  }

  async requestPermission(params) {
    const selection = pickPermissionOption(params.options);
    if (!selection) {
      return { outcome: { outcome: 'cancelled' } };
    }

    this.log(
      `[acp] permission ${selection.kind}: ${params.toolCall.title || params.toolCall.toolCallId}`
    );
    return {
      outcome: {
        outcome: 'selected',
        optionId: selection.optionId,
      },
    };
  }

  async sessionUpdate(params) {
    const { update } = params;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.log(update.content.text, { raw: true });
        } else {
          this.log(`[${update.content.type}]`);
        }
        break;
      case 'tool_call':
        this.log(`[acp] tool ${update.status}: ${update.title}`);
        break;
      case 'tool_call_update':
        this.log(`[acp] tool ${update.status}: ${update.toolCallId}`);
        break;
      case 'plan':
        this.log(
          `[acp] plan: ${update.entries.map((entry) => `${entry.status}:${entry.content}`).join(' | ')}`
        );
        break;
      case 'current_mode_update':
        this.log(`[acp] mode: ${update.modeId}`);
        break;
      default:
        break;
    }
  }

  async readTextFile(params) {
    const resolved = ensureUnderRoot(params.path, this.allowedRoots);
    const content = await fs.readFile(resolved, 'utf8');

    if (!params.line && !params.limit) {
      return { content };
    }

    const lines = content.split(/\r?\n/);
    const start = Math.max((params.line || 1) - 1, 0);
    const end = params.limit ? start + params.limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  async writeTextFile(params) {
    const resolved = ensureUnderRoot(params.path, this.allowedRoots);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, params.content, 'utf8');
    return {};
  }
}

export async function runAcpIteration({
  provider,
  model,
  outputDir,
  promptText,
  log,
  shouldStop = () => false,
  registerAbort = () => {},
}) {
  const normalizedProvider = normalizeProvider(provider);
  const agentCommand = await resolveAgentCommand(normalizedProvider, model);
  const maxAttempts = normalizedProvider === 'claude' ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let abortError = null;
    let abortRun = null;
    const abortPromise = new Promise((_, reject) => {
      abortRun = () => {
        if (abortError) return;
        abortError = new Error('Run stopped during ACP iteration');
        reject(abortError);
      };
    });
    // Strip CLAUDECODE env var so the spawned Claude Code subprocess doesn't
    // refuse to start with "cannot be launched inside another Claude Code session".
    const baseEnv = agentCommand.env || process.env;
    const { CLAUDECODE: _, ...childEnv } = baseEnv;
    const child = spawn(agentCommand.command, agentCommand.args, {
      cwd: PACKAGE_ROOT,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    forwardStderr(child.stderr, log);

    const stopChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
    };
    registerAbort(() => {
      stopChild();
      abortRun();
    });

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const client = new ResearchClient([outputDir], log);
    const connection = new acp.ClientSideConnection(() => client, stream);

    if (shouldStop()) {
      stopChild();
      throw new Error('Run stopped before ACP session started');
    }

    try {
      let init;
      try {
        init = await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: {
            name: '@recursive-systems/deep-research',
            title: 'Deep Research',
            version: '0.1.0',
          },
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
          },
        });
      } catch (error) {
        throw new Error(`ACP initialize failed: ${formatAcpError(error)}`);
      }

      log(`[acp] connected to ${normalizedProvider} (protocol v${init.protocolVersion})`);

      let session;
      try {
        session = await connection.newSession({
          cwd: outputDir,
          mcpServers: [],
        });
      } catch (error) {
        throw new Error(`ACP session start failed: ${formatAcpError(error)}`);
      }

      if (shouldStop()) {
        stopChild();
        throw new Error('Run stopped before prompt execution');
      }

      if (shouldSelectModelViaAcp(normalizedProvider)) {
        try {
          await maybeSelectModel(connection, session, model, log);
        } catch (error) {
          throw new Error(`ACP model selection failed: ${formatAcpError(error)}`);
        }
      }

      let result;
      try {
        result = await Promise.race([
          connection.prompt({
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text: promptText,
              },
            ],
          }),
          abortPromise,
        ]);
      } catch (error) {
        throw new Error(`ACP prompt failed: ${formatAcpError(error)}`);
      }

      log(`[acp] stop reason: ${result.stopReason}`);

      if (result.stopReason !== 'end_turn') {
        throw new Error(`Agent stopped with ${result.stopReason}`);
      }
      return;
    } catch (error) {
      const canRetry = attempt < maxAttempts && isTransientStartupError(error.message);
      if (!canRetry) {
        throw error;
      }
      log(
        `[acp] transient startup failure, retrying (${attempt}/${maxAttempts}): ${error.message}`
      );
      await sleep(750 * attempt);
    } finally {
      registerAbort(null);
      stopChild();
      await connection.closed.catch(() => {});
    }
  }
}
