import { describe, it, expect, vi } from 'vitest';
import {
  safeScore,
  normalizeEvaluationPayload,
  extractInlineArtifact,
} from '../../src/core/evaluator.js';

describe('safeScore', () => {
  it('returns a valid number as-is', () => {
    expect(safeScore(3)).toBe(3);
  });

  it('coerces a string number', () => {
    expect(safeScore('4')).toBe(4);
  });

  it('clamps a value below the range to 1', () => {
    expect(safeScore(0)).toBe(1);
  });

  it('clamps a value above the range to 5', () => {
    expect(safeScore(6)).toBe(5);
  });

  it('returns null for a non-numeric string', () => {
    expect(safeScore('good')).toBeNull();
  });

  it('clamps null (coerced to 0) to 1', () => {
    // Number(null) === 0, which is finite, so it gets clamped to 1
    expect(safeScore(null)).toBe(1);
  });

  it('returns null for undefined', () => {
    expect(safeScore(undefined)).toBeNull();
  });

  it('rounds a fractional value', () => {
    expect(safeScore(3.7)).toBe(4);
  });

  it('returns null for NaN', () => {
    expect(safeScore(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(safeScore(Infinity)).toBeNull();
  });
});

describe('normalizeEvaluationPayload', () => {
  const validScores = {
    brief_coverage: 4,
    directness: 3,
    coherence: 5,
    citation_coverage: 4,
    source_quality: 3,
    specificity: 4,
    brevity: 3,
    uncertainty_honesty: 4,
    support_confidence: 5,
  };

  it('normalizes a valid payload with all 9 score keys', () => {
    const raw = {
      overall: 4.0,
      scores: { ...validScores },
      summary: 'Good report.',
      strengths: ['thorough', 'well-cited'],
      weaknesses: ['too long'],
    };

    const result = normalizeEvaluationPayload(raw, null);
    expect(result.modelOverall).toBe(4);
    expect(Object.keys(result.scores)).toHaveLength(9);
    expect(result.scores.brief_coverage).toBe(4);
    expect(result.scores.coherence).toBe(5);
    expect(result.summary).toBe('Good report.');
    expect(result.strengths).toEqual(['thorough', 'well-cited']);
    expect(result.weaknesses).toEqual(['too long']);
  });

  it('handles missing scores object with graceful fallback', () => {
    const raw = { overall: 3.0, summary: 'Okay.' };
    const result = normalizeEvaluationPayload(raw, null);

    // All scores fall back to 1 when missing
    for (const value of Object.values(result.scores)) {
      expect(value).toBe(1);
    }
    expect(result.modelOverall).toBe(3);
  });

  it('handles completely null input', () => {
    const result = normalizeEvaluationPayload(null, 2.5);

    for (const value of Object.values(result.scores)) {
      expect(value).toBe(1);
    }
    expect(result.modelOverall).toBe(2.5);
    expect(result.summary).toBe('');
    expect(result.strengths).toEqual([]);
    expect(result.weaknesses).toEqual([]);
  });

  it('coerces string values in scores', () => {
    const raw = {
      scores: {
        brief_coverage: '4',
        directness: '3',
        coherence: '5',
        citation_coverage: '2',
        source_quality: '3',
        specificity: '4',
        brevity: '3',
        uncertainty_honesty: '4',
        support_confidence: '5',
      },
    };

    const result = normalizeEvaluationPayload(raw, null);
    expect(result.scores.brief_coverage).toBe(4);
    expect(result.scores.directness).toBe(3);
  });

  it('does not accept misspelled keys — missing keys get fallback value 1', () => {
    const raw = {
      scores: {
        brief_coverge: 5, // typo
        directness: 3,
        coherence: 4,
        citation_coverage: 4,
        source_quality: 3,
        specificity: 4,
        brevity: 3,
        uncertainty_honesty: 4,
        support_confidence: 5,
      },
    };

    const result = normalizeEvaluationPayload(raw, null);
    // The misspelled key is ignored; brief_coverage falls back to 1
    expect(result.scores.brief_coverage).toBe(1);
    // The correctly-spelled keys are preserved
    expect(result.scores.directness).toBe(3);
    // The misspelled key does not appear in output
    expect(result.scores).not.toHaveProperty('brief_coverge');
  });

  it('ignores extra unexpected keys in the scores object', () => {
    const raw = {
      scores: {
        ...validScores,
        bonus_score: 5,
        random_key: 3,
      },
    };

    const result = normalizeEvaluationPayload(raw, null);
    expect(Object.keys(result.scores)).toHaveLength(9);
    expect(result.scores).not.toHaveProperty('bonus_score');
    expect(result.scores).not.toHaveProperty('random_key');
  });

  it('clamps modelOverall to [1, 5] range', () => {
    const raw = { overall: 10, scores: { ...validScores } };
    const result = normalizeEvaluationPayload(raw, null);
    expect(result.modelOverall).toBe(5);
  });

  it('truncates summary to 400 characters', () => {
    const raw = { summary: 'x'.repeat(500) };
    const result = normalizeEvaluationPayload(raw, null);
    expect(result.summary).toHaveLength(400);
  });

  it('limits strengths and weaknesses to 3 entries', () => {
    const raw = {
      strengths: ['a', 'b', 'c', 'd', 'e'],
      weaknesses: ['w', 'x', 'y', 'z'],
    };
    const result = normalizeEvaluationPayload(raw, null);
    expect(result.strengths).toHaveLength(3);
    expect(result.weaknesses).toHaveLength(3);
  });

  it('warns when scores object is entirely missing', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = { overall: 3.0, summary: 'Okay.' };
    const result = normalizeEvaluationPayload(raw, null);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("missing 'scores' object entirely")
    );
    // Still returns valid fallback data
    for (const value of Object.values(result.scores)) {
      expect(value).toBe(1);
    }
    expect(result.modelOverall).toBe(3);
    spy.mockRestore();
  });

  it('warns when null input triggers missing scores warning', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = normalizeEvaluationPayload(null, 2.5);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("missing 'scores' object entirely")
    );
    for (const value of Object.values(result.scores)) {
      expect(value).toBe(1);
    }
    expect(result.modelOverall).toBe(2.5);
    spy.mockRestore();
  });

  it('warns when >50% of score keys are missing or invalid', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = {
      scores: {
        brief_coverge: 5, // typo — not a valid key
        directness: 3,
        coherence: 4,
        // 6 keys missing entirely → 6 nulls out of 9
      },
    };
    const result = normalizeEvaluationPayload(raw, null);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('7/9 score keys missing or invalid')
    );
    // Valid keys are still preserved
    expect(result.scores.directness).toBe(3);
    expect(result.scores.coherence).toBe(4);
    // Missing keys fall back to 1
    expect(result.scores.brief_coverage).toBe(1);
    spy.mockRestore();
  });

  it('does not warn when fewer than 5 score keys are missing', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = {
      scores: {
        brief_coverage: 4,
        directness: 3,
        coherence: 5,
        citation_coverage: 4,
        source_quality: 3,
        // 4 keys missing — under the threshold
      },
    };
    const result = normalizeEvaluationPayload(raw, null);

    expect(spy).not.toHaveBeenCalled();
    expect(result.scores.brief_coverage).toBe(4);
    expect(result.scores.specificity).toBe(1); // defaulted
    spy.mockRestore();
  });

  it('does not warn when all score keys are valid', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = {
      overall: 4.0,
      scores: { ...validScores },
      summary: 'Good.',
      strengths: ['a'],
      weaknesses: ['b'],
    };
    normalizeEvaluationPayload(raw, null);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('extractInlineArtifact', () => {
  it('extracts a standard fenced JSON block', () => {
    const text = [
      'Here is the evaluation:',
      '',
      '`evaluation.json`',
      '```json',
      '{"overall": 3.5, "scores": {}}',
      '```',
    ].join('\n');

    const result = extractInlineArtifact(text, 'evaluation.json', 'json');
    expect(result).toBe('{"overall": 3.5, "scores": {}}');
  });

  it('extracts a standard fenced markdown block', () => {
    const text = [
      'Here is the judgment:',
      '',
      '`judgment.md`',
      '```md',
      '# Judgment',
      '',
      'The report is solid.',
      '```',
    ].join('\n');

    const result = extractInlineArtifact(text, 'judgment.md', 'md');
    expect(result).toBe('# Judgment\n\nThe report is solid.');
  });

  it('returns empty string when no matching block exists', () => {
    const text = 'There is no code block here, just text.';
    const result = extractInlineArtifact(text, 'evaluation.json', 'json');
    expect(result).toBe('');
  });

  it('extracts the block even when filename has no backtick wrapping', () => {
    const text = [
      'evaluation.json',
      '```json',
      '{"score": 4}',
      '```',
    ].join('\n');

    const result = extractInlineArtifact(text, 'evaluation.json', 'json');
    expect(result).toBe('{"score": 4}');
  });

  it('strips [judge] prefixes before matching', () => {
    const text = [
      '[judge] Here is the output:',
      '[judge] `evaluation.json`',
      '[judge] ```json',
      '[judge] {"overall": 2}',
      '[judge] ```',
    ].join('\n');

    // After stripping [judge] prefixes, the content should be matchable
    const result = extractInlineArtifact(text, 'evaluation.json', 'json');
    expect(result).toBe('{"overall": 2}');
  });

  it('handles multiple blocks and extracts the one matching the filename', () => {
    const text = [
      '`evaluation.json`',
      '```json',
      '{"overall": 3}',
      '```',
      '',
      '`judgment.md`',
      '```md',
      '# Good work',
      '```',
    ].join('\n');

    const jsonResult = extractInlineArtifact(text, 'evaluation.json', 'json');
    expect(jsonResult).toBe('{"overall": 3}');

    const mdResult = extractInlineArtifact(text, 'judgment.md', 'md');
    expect(mdResult).toBe('# Good work');
  });

  it('returns empty string for null input', () => {
    expect(extractInlineArtifact(null, 'evaluation.json', 'json')).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(extractInlineArtifact('', 'evaluation.json', 'json')).toBe('');
  });
});
