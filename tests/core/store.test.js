import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTopic,
  readTopic,
  listTopics,
  deleteTopic,
  createRun,
  readRun,
  listRuns,
  updateRun,
  deleteRun,
} from '../../src/core/store.js';

let tmpDir;
let env;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'store-test-'));
  env = { DEEP_RESEARCH_HOME: tmpDir };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Topic CRUD', () => {
  it('createTopic with brief text creates topic.json and brief.md', async () => {
    const topic = await createTopic({ brief: 'Investigate quantum computing' }, env);

    expect(topic.id).toBe(topic.slug);
    expect(topic.title).toBe('Investigate quantum computing');
    expect(topic.createdAt).toBeTruthy();
    expect(topic.updatedAt).toBe(topic.createdAt);
    expect(topic.latestRunId).toBeNull();

    const topicDir = path.join(tmpDir, 'topics', topic.slug);
    const topicJson = JSON.parse(await fs.readFile(path.join(topicDir, 'topic.json'), 'utf8'));
    expect(topicJson.id).toBe(topic.slug);

    const brief = await fs.readFile(path.join(topicDir, 'brief.md'), 'utf8');
    expect(brief).toBe('Investigate quantum computing\n');
  });

  it('createTopic auto-generates slug from title', async () => {
    const topic = await createTopic({ brief: 'Hello World Test!' }, env);
    expect(topic.slug).toBe('hello-world-test');
  });

  it('createTopic uses explicit slug when provided', async () => {
    const topic = await createTopic({ slug: 'my-slug', brief: 'Some brief' }, env);
    expect(topic.slug).toBe('my-slug');
  });

  it('createTopic throws on duplicate slug', async () => {
    await createTopic({ slug: 'dup', brief: 'First' }, env);
    await expect(createTopic({ slug: 'dup', brief: 'Second' }, env)).rejects.toThrow(
      'Topic already exists: dup'
    );
  });

  it('readTopic returns correct fields', async () => {
    const created = await createTopic({ brief: 'Read me back' }, env);
    const topic = await readTopic(created.slug, env);

    expect(topic).not.toBeNull();
    expect(topic.id).toBe(created.slug);
    expect(topic.slug).toBe(created.slug);
    expect(topic.title).toBe('Read me back');
    expect(topic.createdAt).toBeTruthy();
    expect(topic.updatedAt).toBeTruthy();
    expect(topic.latestRunId).toBeNull();
  });

  it('readTopic returns null for non-existent topic', async () => {
    const topic = await readTopic('does-not-exist', env);
    expect(topic).toBeNull();
  });

  it('listTopics returns all topics sorted by updatedAt descending', async () => {
    await createTopic({ slug: 'alpha', brief: 'Alpha topic' }, env);
    // Small delay so updatedAt differs
    await new Promise((r) => setTimeout(r, 10));
    await createTopic({ slug: 'beta', brief: 'Beta topic' }, env);

    const topics = await listTopics(env);
    expect(topics).toHaveLength(2);
    // Most recently created should be first
    expect(topics[0].slug).toBe('beta');
    expect(topics[1].slug).toBe('alpha');
  });

  it('deleteTopic removes the topic directory', async () => {
    const topic = await createTopic({ brief: 'To be deleted' }, env);
    const result = await deleteTopic(topic.slug, env);
    expect(result.slug).toBe(topic.slug);

    const after = await readTopic(topic.slug, env);
    expect(after).toBeNull();
  });

  it('deleteTopic throws if topic has a running run', async () => {
    const topic = await createTopic({ brief: 'Has running run' }, env);
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);

    // Manually set the run status to running
    await updateRun(run.id, () => ({ status: 'running' }), env);

    await expect(deleteTopic(topic.slug, env)).rejects.toThrow(
      'Cannot delete topic with running runs'
    );
  });

  it('deleteTopic also removes associated runs', async () => {
    const topic = await createTopic({ brief: 'Topic with runs' }, env);
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);

    const result = await deleteTopic(topic.slug, env);
    expect(result.deletedRuns).toBe(1);

    const deletedRun = await readRun(run.id, env);
    expect(deletedRun).toBeNull();
  });
});

describe('Run CRUD', () => {
  let topic;

  beforeEach(async () => {
    topic = await createTopic({ slug: 'test-topic', brief: 'Test brief content' }, env);
  });

  it('createRun with valid topicSlug creates run.json and brief.md', async () => {
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);

    expect(run.id).toMatch(/^run-/);
    expect(run.topicSlug).toBe('test-topic');
    expect(run.status).toBe('created');
    expect(run.provider).toBe('claude');
    expect(run.baseRunId).toBeNull();
    expect(run.runDir).toBeTruthy();

    const runJson = JSON.parse(await fs.readFile(path.join(run.runDir, 'run.json'), 'utf8'));
    expect(runJson.id).toBe(run.id);

    const brief = await fs.readFile(path.join(run.runDir, 'brief.md'), 'utf8');
    expect(brief).toBe('Test brief content\n');
  });

  it('createRun throws for unknown topic', async () => {
    await expect(
      createRun({ topicSlug: 'nonexistent', provider: 'claude' }, env)
    ).rejects.toThrow('Unknown topic: nonexistent');
  });

  it('createRun with baseRunId copies state from base run', async () => {
    const baseRun = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);

    // Write some state into the base run
    await fs.writeFile(path.join(baseRun.runDir, 'report.md'), '# Base Report\n', 'utf8');
    await fs.writeFile(path.join(baseRun.runDir, 'sources.md'), '- Source A\n', 'utf8');
    await fs.mkdir(path.join(baseRun.runDir, 'library'), { recursive: true });
    await fs.writeFile(
      path.join(baseRun.runDir, 'library', 'doc1.md'),
      'Library doc content',
      'utf8'
    );

    // Mark base run as completed so it's a valid base
    await updateRun(baseRun.id, () => ({ status: 'completed', completedIterations: 3 }), env);

    const newRun = await createRun(
      { topicSlug: topic.slug, provider: 'claude', baseRunId: baseRun.id },
      env
    );

    expect(newRun.baseRunId).toBe(baseRun.id);

    const report = await fs.readFile(path.join(newRun.runDir, 'report.md'), 'utf8');
    expect(report).toBe('# Base Report\n');

    const sources = await fs.readFile(path.join(newRun.runDir, 'sources.md'), 'utf8');
    expect(sources).toBe('- Source A\n');

    const libraryDoc = await fs.readFile(
      path.join(newRun.runDir, 'library', 'doc1.md'),
      'utf8'
    );
    expect(libraryDoc).toBe('Library doc content');
  });

  it('readRun returns correct fields including status', async () => {
    const created = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);
    const run = await readRun(created.id, env);

    expect(run).not.toBeNull();
    expect(run.id).toBe(created.id);
    expect(run.topicSlug).toBe('test-topic');
    expect(run.status).toBe('created');
    expect(run.provider).toBe('claude');
    expect(run.completedIterations).toBe(0);
    expect(run.createdAt).toBeTruthy();
    expect(run.updatedAt).toBeTruthy();
    expect(run.startedAt).toBeNull();
    expect(run.endedAt).toBeNull();
    expect(run.pid).toBeNull();
    expect(run.exitCode).toBeNull();
    expect(run.error).toBeNull();
  });

  it('readRun returns null for non-existent run', async () => {
    const run = await readRun('run-does-not-exist', env);
    expect(run).toBeNull();
  });

  it('listRuns returns all runs sorted by createdAt descending', async () => {
    const run1 = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);
    const run2 = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);

    const runs = await listRuns(env);
    expect(runs).toHaveLength(2);
    // Most recent first
    expect(runs[0].id).toBe(run2.id);
    expect(runs[1].id).toBe(run1.id);
  });

  it('updateRun merges fields into run.json', async () => {
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);

    const updated = await updateRun(
      run.id,
      () => ({ status: 'running', pid: 12345 }),
      env
    );

    expect(updated.status).toBe('running');
    expect(updated.pid).toBe(12345);
    expect(updated.id).toBe(run.id);
    // updatedAt should have changed
    expect(updated.updatedAt).not.toBe(run.updatedAt);

    // Verify persisted
    const reread = await readRun(run.id, env);
    expect(reread.status).toBe('running');
    expect(reread.pid).toBe(12345);
  });

  it('updateRun throws for non-existent run', async () => {
    await expect(
      updateRun('run-nope', () => ({ status: 'done' }), env)
    ).rejects.toThrow('Unknown run: run-nope');
  });

  it('deleteRun removes run directory', async () => {
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);
    const deleted = await deleteRun(run.id, env);
    expect(deleted.id).toBe(run.id);

    const after = await readRun(run.id, env);
    expect(after).toBeNull();
  });

  it('deleteRun throws if run is still running', async () => {
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);
    await updateRun(run.id, () => ({ status: 'running' }), env);

    await expect(deleteRun(run.id, env)).rejects.toThrow('Cannot delete running run');
  });

  it('createRun updates topic latestRunId', async () => {
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);
    const updatedTopic = await readTopic(topic.slug, env);
    expect(updatedTopic.latestRunId).toBe(run.id);
  });

  it('createRun with iterations and maxMinutes stores constraints', async () => {
    const run = await createRun(
      { topicSlug: topic.slug, provider: 'claude', iterations: 5, maxMinutes: 30 },
      env
    );
    expect(run.requestedIterations).toBe(5);
    expect(run.maxMinutes).toBe(30);
  });

  it('createRun uses default model for provider', async () => {
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);
    expect(run.model).toBe('sonnet');
  });

  it('concurrent updateRun calls do not clobber each other', async () => {
    const run = await createRun({ topicSlug: topic.slug, provider: 'claude' }, env);

    // Initialize a counter field
    await updateRun(run.id, () => ({ counter: 0 }), env);

    // Fire two concurrent updates that each increment the counter
    await Promise.all([
      updateRun(run.id, (current) => ({ counter: (current.counter || 0) + 1 }), env),
      updateRun(run.id, (current) => ({ counter: (current.counter || 0) + 1 }), env),
    ]);

    // One should have returned 1 and the other 2, depending on order
    const final = await readRun(run.id, env);
    expect(final.counter).toBe(2);
  });
});
