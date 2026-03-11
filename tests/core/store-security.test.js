import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureStore, createTopic, createRun, readRunFile } from '../../src/core/store.js';

describe('readRunFile path traversal protection', () => {
  let tmpHome;
  let env;
  let run;

  beforeAll(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dr-security-test-'));
    env = { DEEP_RESEARCH_HOME: tmpHome };
    await ensureStore(env);

    const topic = await createTopic(
      { slug: 'security-test', title: 'Security Test', brief: 'Security test brief' },
      env
    );

    run = await createRun(
      { topicSlug: topic.slug, provider: 'claude', iterations: 1 },
      env
    );

    // Create test files for valid-path tests
    await fs.writeFile(path.join(run.runDir, 'iterations', '001.md'), '# Iteration 1\n', 'utf8');
    await fs.writeFile(path.join(run.runDir, 'library', 'topic.md'), '# Topic\n', 'utf8');
    await fs.writeFile(path.join(run.runDir, 'report.md'), '# Report\n', 'utf8');
  });

  afterAll(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  // --- Traversal attacks ---

  it('rejects ../../../etc/passwd', async () => {
    await expect(readRunFile(run.id, '../../../etc/passwd', env)).rejects.toThrow(
      /Invalid file path/
    );
  });

  it('rejects ../../etc/passwd', async () => {
    await expect(readRunFile(run.id, '../../etc/passwd', env)).rejects.toThrow(
      /Invalid file path/
    );
  });

  it('rejects iterations/../../../etc/passwd', async () => {
    await expect(
      readRunFile(run.id, 'iterations/../../../etc/passwd', env)
    ).rejects.toThrow(/Invalid file path/);
  });

  // --- Null bytes ---

  it('rejects paths with null bytes', async () => {
    await expect(readRunFile(run.id, 'report.md\0.txt', env)).rejects.toThrow();
  });

  // --- Windows-style backslash separators ---

  it('rejects backslash traversal: iterations\\..\\..\\etc\\passwd', async () => {
    await expect(
      readRunFile(run.id, 'iterations\\..\\..\\etc\\passwd', env)
    ).rejects.toThrow(/Invalid file path/);
  });

  // --- Absolute paths ---

  it('rejects absolute path /etc/passwd', async () => {
    await expect(readRunFile(run.id, '/etc/passwd', env)).rejects.toThrow(/Invalid file path/);
  });

  // --- Valid paths ---

  it('reads valid iteration file: iterations/001.md', async () => {
    const content = await readRunFile(run.id, 'iterations/001.md', env);
    expect(content).toBe('# Iteration 1\n');
  });

  it('reads valid library file: library/topic.md', async () => {
    const content = await readRunFile(run.id, 'library/topic.md', env);
    expect(content).toBe('# Topic\n');
  });

  // --- Traversal that resolves within run dir ---

  it('allows iterations/../report.md because it normalizes to allowed report.md', async () => {
    const content = await readRunFile(run.id, 'iterations/../report.md', env);
    expect(content).toBe('# Report\n');
  });
});
