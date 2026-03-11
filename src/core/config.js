import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PACKAGE_ROOT = path.resolve(__dirname, '../..');
export const PROMPTS_DIR = path.join(PACKAGE_ROOT, 'prompts');
export const PUBLIC_DIR = path.join(PACKAGE_ROOT, 'public');

export function getRuntimeHome(env = process.env) {
  const configured = env.DEEP_RESEARCH_HOME;
  return path.resolve(configured || path.join(os.homedir(), '.deep-research'));
}

export function getStorePaths(env = process.env) {
  const home = getRuntimeHome(env);
  return {
    home,
    topicsRoot: path.join(home, 'topics'),
    runsRoot: path.join(home, 'runs'),
    tmpRoot: path.join(home, 'tmp'),
  };
}

export const PROVIDER_DEFAULT_MODELS = {
  claude: 'sonnet',
  codex: 'gpt-5.4',
  zai: 'zai/glm-5',
};

export const MAX_OPEN_ENDED_ITERATIONS = 5;
export const MAX_OPEN_ENDED_MINUTES = 30;

export const PROVIDER_BINARIES = {
  claude: {
    adapter: 'claude-agent-acp',
    backend: 'claude',
  },
  codex: {
    adapter: 'codex-acp',
    backend: 'codex',
  },
  zai: {
    adapter: 'opencode',
    backend: 'opencode',
  },
};
