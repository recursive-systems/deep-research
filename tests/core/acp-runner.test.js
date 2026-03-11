import { describe, it, expect } from 'vitest';
import { scoreMatch } from '../../src/core/acp-runner.js';

describe('scoreMatch', () => {
  describe('exact match', () => {
    it('returns 100 for an identical string', () => {
      expect(scoreMatch('claude-sonnet-4-20250514', 'claude-sonnet-4-20250514')).toBe(100);
    });

    it('returns 100 when match is among multiple candidates', () => {
      expect(
        scoreMatch('claude-sonnet-4-20250514', 'claude-opus-4', 'claude-sonnet-4-20250514')
      ).toBe(100);
    });

    it('ignores leading/trailing whitespace for exact match', () => {
      expect(scoreMatch('  claude-sonnet-4  ', 'claude-sonnet-4')).toBe(100);
    });
  });

  describe('substring match', () => {
    it('scores 60 when desired is a substring of a candidate', () => {
      expect(scoreMatch('sonnet', 'claude-sonnet-4-20250514')).toBe(60);
    });

    it('scores 60 when a candidate is a substring of desired', () => {
      expect(scoreMatch('claude-sonnet-4-20250514', 'sonnet')).toBe(60);
    });
  });

  describe('alphanumeric normalization', () => {
    it('scores 80 when strings differ only by separators', () => {
      expect(scoreMatch('claude-sonnet-4', 'claude_sonnet_4')).toBe(80);
    });

    it('scores 80 when separators differ (dots vs dashes)', () => {
      expect(scoreMatch('claude.sonnet.4', 'claude-sonnet-4')).toBe(80);
    });

    it('prefers exact match (100) over alphanumeric normalization (80)', () => {
      expect(scoreMatch('claude-sonnet-4', 'claude-sonnet-4')).toBe(100);
    });
  });

  describe('ambiguous short queries', () => {
    it('returns a consistent score for a short query matching via substring', () => {
      const score1 = scoreMatch('4', 'claude-sonnet-4-20250514');
      const score2 = scoreMatch('4', 'claude-opus-4-20250514');
      // Both should score 60 (substring match) -- deterministic per candidate
      expect(score1).toBe(60);
      expect(score2).toBe(60);
    });

    it('returns the highest score across multiple candidates', () => {
      // "4" is a substring of both, so best is 60
      const score = scoreMatch('4', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514');
      expect(score).toBe(60);
    });

    it('returns 100 if one candidate is an exact match despite ambiguity', () => {
      const score = scoreMatch('4', '4', 'claude-opus-4-20250514');
      expect(score).toBe(100);
    });
  });

  describe('no match', () => {
    it('returns 0 when nothing matches', () => {
      expect(scoreMatch('nonexistent-model', 'claude-sonnet-4-20250514')).toBe(0);
    });

    it('returns 0 for completely unrelated strings', () => {
      expect(scoreMatch('gpt-4o', 'claude-sonnet-4-20250514')).toBe(0);
    });

    it('returns 0 when all candidates are empty/null', () => {
      expect(scoreMatch('sonnet', null, undefined, '')).toBe(0);
    });
  });

  describe('case handling', () => {
    it('matches case-insensitively for exact match', () => {
      expect(scoreMatch('Claude-Sonnet-4', 'claude-sonnet-4')).toBe(100);
    });

    it('matches case-insensitively for substring match', () => {
      expect(scoreMatch('SONNET', 'claude-sonnet-4-20250514')).toBe(60);
    });

    it('matches case-insensitively for alphanumeric normalization', () => {
      expect(scoreMatch('Claude_Sonnet_4', 'claude-sonnet-4')).toBe(80);
    });
  });
});
