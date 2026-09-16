export const OPENAI_PRICING_SNAPSHOT = "2026-09-16";

interface PricingRate {
  input: number;
  cachedInput: number;
  output: number;
  cacheWriteMultiplier: number;
}

const RATES_PER_MILLION: Record<string, PricingRate> = {
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2, cacheWriteMultiplier: 1.25 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12, cacheWriteMultiplier: 1.25 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20, cacheWriteMultiplier: 1.25 },
  "gpt-5.6": { input: 4, cachedInput: 0.4, output: 20, cacheWriteMultiplier: 1.25 }
};

export interface OpenAITokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function estimateOpenAICostUsd(model: string, usage: OpenAITokenUsage): number | null {
  const rate = RATES_PER_MILLION[model];
  if (!rate) return null;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens);
  const cost = (
    uncached * rate.input +
    usage.cachedInputTokens * rate.cachedInput +
    usage.cacheWriteTokens * rate.input * rate.cacheWriteMultiplier +
    usage.outputTokens * rate.output
  ) / 1_000_000;
  return Number(cost.toFixed(8));
}
