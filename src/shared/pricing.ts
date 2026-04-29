// Source: anthropic.com/pricing (April 2026). USD per 1M tokens.
// Caching: cache_write at 1.25x base input, cache_read at 0.10x base input (standard tiering).

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICING: Record<string, ModelPrice> = {
  // Opus tier
  "claude-opus-4-7": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-6": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // Sonnet tier
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Haiku tier
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheWrite: 1.0, cacheRead: 0.08 },
};

const SAFE_DEFAULT: ModelPrice = PRICING["claude-sonnet-4-6"];

/** Resolve a model id (or alias) to a price entry, falling back to Sonnet 4.6. */
export function resolvePrice(model: string | undefined): ModelPrice {
  if (!model) return SAFE_DEFAULT;
  const direct = PRICING[model];
  if (direct) return direct;

  const id = model.toLowerCase();
  if (id.includes("opus")) return PRICING["claude-opus-4-7"];
  if (id.includes("haiku")) return PRICING["claude-haiku-4-5"];
  if (id.includes("sonnet")) return PRICING["claude-sonnet-4-6"];
  return SAFE_DEFAULT;
}

export interface CostInput {
  model?: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** Compute USD cost from token counts. Returns a Number with 6 decimals. */
export function computeCost(args: CostInput): number {
  const p = resolvePrice(args.model);
  const usd =
    (args.input * p.input +
      args.output * p.output +
      args.cacheCreation * p.cacheWrite +
      args.cacheRead * p.cacheRead) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
