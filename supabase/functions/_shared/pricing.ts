// Roost: per-model token pricing for Edge Functions (Deno).
// Mirror of /shared/pricing.ts. Keep both in sync.

export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion?: number;
  cacheReadPerMillion?: number;
}

const RATES: Record<string, ModelRate> = {
  'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.5 },
  'claude-opus-4-6': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
};

const FALLBACK: ModelRate = { inputPerMillion: 15, outputPerMillion: 75 };

export interface UsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export function costUsd(model: string, usage: UsageInput): number {
  const rate = RATES[model] ?? FALLBACK;
  const fresh = (usage.inputTokens * rate.inputPerMillion) / 1_000_000;
  const out = (usage.outputTokens * rate.outputPerMillion) / 1_000_000;
  const cw = ((usage.cacheCreationInputTokens ?? 0) * (rate.cacheWritePerMillion ?? rate.inputPerMillion)) / 1_000_000;
  const cr = ((usage.cacheReadInputTokens ?? 0) * (rate.cacheReadPerMillion ?? rate.inputPerMillion)) / 1_000_000;
  return Number((fresh + out + cw + cr).toFixed(6));
}
