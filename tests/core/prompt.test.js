import { describe, it, expect } from 'vitest';
import {
  materializeIterationPrompt,
  combineSystemAndTaskPrompt,
  loadPromptTemplates,
} from '../../src/core/prompt.js';

describe('materializeIterationPrompt', () => {
  const baseVars = {
    iteration: 2,
    totalIterations: 5,
    topicIteration: 7,
    outputDir: '/tmp/research/run-001',
  };

  it('replaces {{ITERATION}} with the iteration number', () => {
    const result = materializeIterationPrompt('Step {{ITERATION}} here', baseVars);
    expect(result).toBe('Step 2 here');
  });

  it('replaces {{ITERATION_PADDED}} with zero-padded iteration', () => {
    const result = materializeIterationPrompt('File: {{ITERATION_PADDED}}.md', baseVars);
    expect(result).toBe('File: 002.md');
  });

  it('replaces {{TOTAL_ITERATIONS}} with the total', () => {
    const result = materializeIterationPrompt('of {{TOTAL_ITERATIONS}} total', baseVars);
    expect(result).toBe('of 5 total');
  });

  it('replaces {{TOTAL_ITERATIONS}} with "open-ended" when totalIterations is null', () => {
    const result = materializeIterationPrompt('of {{TOTAL_ITERATIONS}} total', {
      ...baseVars,
      totalIterations: null,
    });
    expect(result).toBe('of open-ended total');
  });

  it('replaces {{TOTAL_ITERATIONS}} with "open-ended" when totalIterations is undefined', () => {
    const result = materializeIterationPrompt('of {{TOTAL_ITERATIONS}} total', {
      ...baseVars,
      totalIterations: undefined,
    });
    expect(result).toBe('of open-ended total');
  });

  it('replaces {{TOPIC_ITERATION}} with the topic iteration number', () => {
    const result = materializeIterationPrompt('topic iter {{TOPIC_ITERATION}}', baseVars);
    expect(result).toBe('topic iter 7');
  });

  it('replaces {{OUTPUT_DIR}} with the output directory', () => {
    const result = materializeIterationPrompt('dir: {{OUTPUT_DIR}}', baseVars);
    expect(result).toBe('dir: /tmp/research/run-001');
  });

  it('replaces all occurrences of the same variable', () => {
    const template = '{{ITERATION}} and again {{ITERATION}}';
    const result = materializeIterationPrompt(template, baseVars);
    expect(result).toBe('2 and again 2');
  });

  it('replaces multiple different variables in one template', () => {
    const template = 'Iter {{ITERATION}} of {{TOTAL_ITERATIONS}}, topic {{TOPIC_ITERATION}}, dir {{OUTPUT_DIR}}';
    const result = materializeIterationPrompt(template, baseVars);
    expect(result).toBe('Iter 2 of 5, topic 7, dir /tmp/research/run-001');
  });
});

describe('materializeIterationPrompt — conditional blocks', () => {
  const finalTemplate = [
    'Before',
    '{{#if FINAL_ITERATION}}',
    'Final content here',
    '{{/if}}',
    'After',
  ].join('\n');

  it('includes conditional block content when iteration equals totalIterations', () => {
    const result = materializeIterationPrompt(finalTemplate, {
      iteration: 3,
      totalIterations: 3,
      topicIteration: 1,
      outputDir: '/out',
    });
    expect(result).toContain('Final content here');
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('{{#if');
    expect(result).not.toContain('{{/if}}');
  });

  it('strips conditional block when iteration is not final', () => {
    const result = materializeIterationPrompt(finalTemplate, {
      iteration: 1,
      totalIterations: 3,
      topicIteration: 1,
      outputDir: '/out',
    });
    expect(result).not.toContain('Final content here');
    expect(result).not.toContain('{{#if');
    expect(result).not.toContain('{{/if}}');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('strips conditional block when totalIterations is null (open-ended)', () => {
    const result = materializeIterationPrompt(finalTemplate, {
      iteration: 5,
      totalIterations: null,
      topicIteration: 1,
      outputDir: '/out',
    });
    expect(result).not.toContain('Final content here');
  });

  it('handles multiple conditional blocks', () => {
    const template = [
      'A',
      '{{#if FINAL_ITERATION}}Block1{{/if}}',
      'B',
      '{{#if FINAL_ITERATION}}Block2{{/if}}',
      'C',
    ].join('\n');

    const finalResult = materializeIterationPrompt(template, {
      iteration: 2,
      totalIterations: 2,
      topicIteration: 1,
      outputDir: '/out',
    });
    expect(finalResult).toContain('Block1');
    expect(finalResult).toContain('Block2');

    const nonFinalResult = materializeIterationPrompt(template, {
      iteration: 1,
      totalIterations: 2,
      topicIteration: 1,
      outputDir: '/out',
    });
    expect(nonFinalResult).not.toContain('Block1');
    expect(nonFinalResult).not.toContain('Block2');
    expect(nonFinalResult).toContain('A');
    expect(nonFinalResult).toContain('B');
    expect(nonFinalResult).toContain('C');
  });
});

describe('materializeIterationPrompt — PRIOR_EVAL conditional block', () => {
  const evalTemplate = [
    'Before',
    '{{#if PRIOR_EVAL}}',
    '## Prior Iteration Feedback',
    '{{PRIOR_EVAL}}',
    'Address weaknesses.',
    '{{/if PRIOR_EVAL}}',
    'After',
  ].join('\n');

  const baseVars = {
    iteration: 2,
    totalIterations: 5,
    topicIteration: 7,
    outputDir: '/tmp/research/run-001',
  };

  it('strips PRIOR_EVAL block when priorEval is null', () => {
    const result = materializeIterationPrompt(evalTemplate, {
      ...baseVars,
      priorEval: null,
    });
    expect(result).not.toContain('Prior Iteration Feedback');
    expect(result).not.toContain('{{#if PRIOR_EVAL}}');
    expect(result).not.toContain('{{/if PRIOR_EVAL}}');
    expect(result).not.toContain('{{PRIOR_EVAL}}');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('strips PRIOR_EVAL block when priorEval is not provided', () => {
    const result = materializeIterationPrompt(evalTemplate, baseVars);
    expect(result).not.toContain('Prior Iteration Feedback');
    expect(result).not.toContain('{{PRIOR_EVAL}}');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('includes PRIOR_EVAL block with score, weaknesses, and summary when priorEval is provided', () => {
    const result = materializeIterationPrompt(evalTemplate, {
      ...baseVars,
      priorEval: {
        overall: 3.2,
        weaknesses: ['Shallow analysis', 'Missing citations', 'Weak conclusion'],
        summary: 'Needs more depth on key topics.',
      },
    });
    expect(result).toContain('Prior Iteration Feedback');
    expect(result).toContain('3.2/5');
    expect(result).toContain('Shallow analysis');
    expect(result).toContain('Missing citations');
    expect(result).toContain('Weak conclusion');
    expect(result).toContain('Needs more depth on key topics.');
    expect(result).not.toContain('{{#if PRIOR_EVAL}}');
    expect(result).not.toContain('{{/if PRIOR_EVAL}}');
    expect(result).not.toContain('{{PRIOR_EVAL}}');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('limits weaknesses to 3 even if more are provided', () => {
    const result = materializeIterationPrompt(evalTemplate, {
      ...baseVars,
      priorEval: {
        overall: 2.0,
        weaknesses: ['W1', 'W2', 'W3', 'W4', 'W5'],
        summary: 'Poor.',
      },
    });
    expect(result).toContain('W1');
    expect(result).toContain('W2');
    expect(result).toContain('W3');
    expect(result).not.toContain('W4');
    expect(result).not.toContain('W5');
  });

  it('handles priorEval with no weaknesses', () => {
    const result = materializeIterationPrompt(evalTemplate, {
      ...baseVars,
      priorEval: {
        overall: 4.5,
        weaknesses: [],
        summary: 'Good work.',
      },
    });
    expect(result).toContain('4.5/5');
    expect(result).toContain('Good work.');
    expect(result).not.toContain('Weaknesses to address');
  });

  it('handles priorEval with no summary', () => {
    const result = materializeIterationPrompt(evalTemplate, {
      ...baseVars,
      priorEval: {
        overall: 3.1,
        weaknesses: ['Needs work'],
        summary: '',
      },
    });
    expect(result).toContain('3.1/5');
    expect(result).toContain('Needs work');
    expect(result).not.toContain('Judge summary');
  });
});

describe('materializeIterationPrompt — missing / unknown variables', () => {
  it('leaves unknown {{VAR}} placeholders intact', () => {
    const result = materializeIterationPrompt('Hello {{UNKNOWN_VAR}}!', {
      iteration: 1,
      totalIterations: 1,
      topicIteration: 1,
      outputDir: '/out',
    });
    expect(result).toContain('{{UNKNOWN_VAR}}');
  });

  it('does not crash on a template with no recognized variables', () => {
    const result = materializeIterationPrompt('No variables here.', {
      iteration: 1,
      totalIterations: 1,
      topicIteration: 1,
      outputDir: '/out',
    });
    expect(result).toBe('No variables here.');
  });
});

describe('materializeIterationPrompt — edge cases', () => {
  const vars = { iteration: 1, totalIterations: 1, topicIteration: 1, outputDir: '/out' };

  it('handles an empty template', () => {
    const result = materializeIterationPrompt('', vars);
    expect(result).toBe('');
  });

  it('trims leading and trailing whitespace from the result', () => {
    const result = materializeIterationPrompt('  hello  ', vars);
    expect(result).toBe('hello');
  });

  it('handles iteration 1 with padded format', () => {
    const result = materializeIterationPrompt('{{ITERATION_PADDED}}', {
      iteration: 1,
      totalIterations: 10,
      topicIteration: 1,
      outputDir: '/out',
    });
    expect(result).toBe('001');
  });
});

describe('combineSystemAndTaskPrompt', () => {
  it('joins agents prompt and task prompt with separator text', () => {
    const result = combineSystemAndTaskPrompt('System instructions', 'Do the task');
    expect(result).toContain('System instructions');
    expect(result).toContain('Do the task');
    expect(result).toContain('Task for this iteration:');
  });

  it('places agents prompt before task prompt', () => {
    const result = combineSystemAndTaskPrompt('AGENTS', 'TASK');
    const agentsIdx = result.indexOf('AGENTS');
    const taskIdx = result.indexOf('TASK');
    expect(agentsIdx).toBeLessThan(taskIdx);
  });

  it('includes operating instructions preamble', () => {
    const result = combineSystemAndTaskPrompt('A', 'B');
    expect(result).toContain('Follow these operating instructions exactly');
    expect(result).toContain('higher priority');
  });

  it('trims whitespace from both prompts', () => {
    const result = combineSystemAndTaskPrompt('  agents  ', '  task  ');
    expect(result).toContain('agents');
    expect(result).toContain('task');
    expect(result).not.toContain('  agents  ');
    expect(result).not.toContain('  task  ');
  });

  it('returns a string separated by newlines', () => {
    const result = combineSystemAndTaskPrompt('A', 'B');
    expect(result).toContain('\n');
  });
});

describe('loadPromptTemplates', () => {
  it('returns an object with agents and prompt keys', async () => {
    const templates = await loadPromptTemplates();
    expect(templates).toHaveProperty('agents');
    expect(templates).toHaveProperty('prompt');
  });

  it('returns non-empty strings for both templates', async () => {
    const templates = await loadPromptTemplates();
    expect(typeof templates.agents).toBe('string');
    expect(typeof templates.prompt).toBe('string');
    expect(templates.agents.length).toBeGreaterThan(0);
    expect(templates.prompt.length).toBeGreaterThan(0);
  });

  it('prompt template contains expected placeholders', async () => {
    const templates = await loadPromptTemplates();
    expect(templates.prompt).toContain('{{ITERATION}}');
    expect(templates.prompt).toContain('{{TOTAL_ITERATIONS}}');
    expect(templates.prompt).toContain('{{TOPIC_ITERATION}}');
    expect(templates.prompt).toContain('{{OUTPUT_DIR}}');
  });

  it('templates are trimmed (no leading/trailing whitespace)', async () => {
    const templates = await loadPromptTemplates();
    expect(templates.agents).toBe(templates.agents.trim());
    expect(templates.prompt).toBe(templates.prompt.trim());
  });
});
