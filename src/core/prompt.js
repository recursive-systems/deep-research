import fs from 'node:fs/promises';
import path from 'node:path';
import { PROMPTS_DIR } from './config.js';

const AGENTS_FILE = path.join(PROMPTS_DIR, 'AGENTS.md');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'PROMPT_research.md');

export async function loadPromptTemplates() {
  const [agents, prompt] = await Promise.all([
    fs.readFile(AGENTS_FILE, 'utf8'),
    fs.readFile(PROMPT_FILE, 'utf8'),
  ]);

  return {
    agents: agents.trim(),
    prompt: prompt.trim(),
  };
}

export function materializeIterationPrompt(template, { iteration, totalIterations, topicIteration, outputDir }) {
  const padded = String(iteration).padStart(3, '0');
  const isFinalIteration = totalIterations != null && iteration === totalIterations;
  let prompt = template
    .replaceAll('{{ITERATION}}', String(iteration))
    .replaceAll('{{ITERATION_PADDED}}', padded)
    .replaceAll('{{TOTAL_ITERATIONS}}', totalIterations == null ? 'open-ended' : String(totalIterations))
    .replaceAll('{{TOPIC_ITERATION}}', String(topicIteration))
    .replaceAll('{{OUTPUT_DIR}}', outputDir);

  if (isFinalIteration) {
    prompt = prompt
      .replaceAll('{{#if FINAL_ITERATION}}', '')
      .replaceAll('{{/if}}', '');
  } else {
    prompt = prompt.replace(/\{\{#if FINAL_ITERATION\}\}[\s\S]*?\{\{\/if\}\}/g, '');
  }

  return prompt.trim();
}

export function combineSystemAndTaskPrompt(agentsPrompt, taskPrompt) {
  return [
    'Follow these operating instructions exactly. Treat them as higher priority than the task details.',
    '',
    agentsPrompt.trim(),
    '',
    'Task for this iteration:',
    '',
    taskPrompt.trim(),
  ].join('\n');
}
