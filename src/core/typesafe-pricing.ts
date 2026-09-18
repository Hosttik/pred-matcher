export const TYPESAFE_PRICING_SNAPSHOT = "2026-09-15";

const JEV_INPUT_USD_PER_MILLION = 0.042;

function supportedJevModel(model: string): boolean {
  return model === "jev-latest" ||
    model === "jev-preview" ||
    /^jev-\d+\.\d+\.\d+$/.test(model);
}

export function estimateTypeSafeCostUsd(model: string, inputTokens: number): number | null {
  if (!supportedJevModel(model)) return null;
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;
  return Number(((inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MILLION).toFixed(8));
}
