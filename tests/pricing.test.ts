import { describe, it, expect } from 'vitest';
import { costUsd, getRate } from '../shared/pricing.js';

describe('pricing', () => {
  it('returns a known rate for opus 4.7', () => {
    const r = getRate('claude-opus-4-7');
    expect(r.inputPerMillion).toBe(15);
    expect(r.outputPerMillion).toBe(75);
  });

  it('returns a known rate for sonnet 4.6 (the new default)', () => {
    const r = getRate('claude-sonnet-4-6');
    expect(r.inputPerMillion).toBe(3);
    expect(r.outputPerMillion).toBe(15);
  });

  it('falls back to opus rates for unknown model', () => {
    const r = getRate('not-a-real-model');
    expect(r.inputPerMillion).toBe(15);
  });

  it('computes cost from input and output tokens', () => {
    // 1k input + 1k output on haiku 4.5: 1*0.001 + 5*0.001 = 0.006 / 1000 each
    const c = costUsd('claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c).toBeCloseTo(1 + 5, 6);
  });

  it('handles zero usage', () => {
    expect(costUsd('claude-haiku-4-5-20251001', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
