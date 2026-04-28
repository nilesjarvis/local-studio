import type { AppContext } from "../../types/context";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PricingTier {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CostBreakdown extends Record<string, number> {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const WELL_KNOWN_PRICING: Record<string, PricingTier> = {
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "claude-3-opus": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 7.5 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

export function getModelPricing(context: AppContext, modelId: string): PricingTier | null {
  const stored = context.stores.chatStore.getModelPricing(modelId);
  if (stored) {
    return stored.pricing_json as unknown as PricingTier;
  }

  const lower = modelId.toLowerCase();
  for (const [key, pricing] of Object.entries(WELL_KNOWN_PRICING)) {
    if (lower === key || lower.startsWith(key)) {
      return pricing;
    }
  }

  return null;
}

export function calculateCost(usage: TokenUsage, pricing: PricingTier): CostBreakdown {
  const inputCost = (usage.input / 1_000_000) * pricing.input;
  const outputCost = (usage.output / 1_000_000) * pricing.output;
  const cacheReadCost =
    usage.cacheRead && pricing.cacheRead
      ? (usage.cacheRead / 1_000_000) * pricing.cacheRead
      : 0;
  const cacheWriteCost =
    usage.cacheWrite && pricing.cacheWrite
      ? (usage.cacheWrite / 1_000_000) * pricing.cacheWrite
      : 0;

  return {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}
