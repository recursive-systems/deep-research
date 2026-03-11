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

function formatPriorEval(priorEval) {
  if (!priorEval) return '';
  const lines = [];
  if (priorEval.overall != null) {
    lines.push(`**Score:** ${priorEval.overall}/5`);
  }
  if (Array.isArray(priorEval.weaknesses) && priorEval.weaknesses.length > 0) {
    lines.push('');
    lines.push('**Weaknesses to address:**');
    for (const w of priorEval.weaknesses.slice(0, 3)) {
      lines.push(`- ${w}`);
    }
  }
  if (priorEval.summary) {
    lines.push('');
    lines.push(`**Judge summary:** ${priorEval.summary}`);
  }
  const result = lines.join('\n');
  // Escape any template-like syntax in eval output to prevent double-replacement
  return result.replace(/\{\{/g, '{ {');
}

export function materializeIterationPrompt(
  template,
  { iteration, totalIterations, topicIteration, outputDir, priorEval = null }
) {
  const padded = String(iteration).padStart(3, '0');
  const isFinalIteration = totalIterations != null && iteration === totalIterations;
  let prompt = template
    .replaceAll('{{ITERATION}}', String(iteration))
    .replaceAll('{{ITERATION_PADDED}}', padded)
    .replaceAll(
      '{{TOTAL_ITERATIONS}}',
      totalIterations == null ? 'open-ended' : String(totalIterations)
    )
    .replaceAll('{{TOPIC_ITERATION}}', String(topicIteration))
    .replaceAll('{{OUTPUT_DIR}}', outputDir);

  if (isFinalIteration) {
    prompt = prompt.replaceAll('{{#if FINAL_ITERATION}}', '').replaceAll('{{/if}}', '');
  } else {
    prompt = prompt.replace(/\{\{#if FINAL_ITERATION\}\}[\s\S]*?\{\{\/if\}\}/g, '');
  }

  if (priorEval) {
    const evalBlock = formatPriorEval(priorEval);
    prompt = prompt
      .replace(/\{\{#if PRIOR_EVAL\}\}/g, '')
      .replace(/\{\{\/if PRIOR_EVAL\}\}/g, '')
      .replaceAll('{{PRIOR_EVAL}}', evalBlock);
  } else {
    prompt = prompt.replace(/\{\{#if PRIOR_EVAL\}\}[\s\S]*?\{\{\/if PRIOR_EVAL\}\}/g, '');
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
