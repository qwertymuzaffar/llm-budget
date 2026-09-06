import type { ModelPrice, PriceTable, Usage } from './types';

/**
 * Built-in list prices in USD per 1M tokens, as published by the providers
 * on 2026-09-06. Prices change: pass `prices` to override or extend, and
 * treat this table as a convenience, not a source of truth for invoices.
 */
export const DEFAULT_PRICES: PriceTable = {
  // Anthropic
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI
  'gpt-4.1': { input: 2, output: 8, cachedInput: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cachedInput: 0.025 },
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
  'o3': { input: 2, output: 8, cachedInput: 0.5 },
  'o4-mini': { input: 1.1, output: 4.4, cachedInput: 0.275 },
};

/**
 * Finds a price for a model id, tolerating provider prefixes and dated
 * snapshots: "openai/gpt-4o-2024-11-20" resolves to "gpt-4o".
 */
export function resolvePrice(model: string, table: PriceTable): ModelPrice | null {
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  if (table[bare]) return table[bare];
  const stripped = bare.replace(/[-@]\d{4}-\d{2}-\d{2}$|[-@]\d{8}$|-latest$/, '');
  if (table[stripped]) return table[stripped];
  // longest table key that prefixes the model id (e.g. "gpt-4o" for "gpt-4o-2024-08-06")
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (bare.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

/** USD cost of a usage record under a price table; null when the model is unknown. */
export function costOf(usage: Usage, table: PriceTable): number | null {
  const price = resolvePrice(usage.model, table);
  if (!price) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached);
  const cachedRate = price.cachedInput ?? price.input;
  return (uncached * price.input + cached * cachedRate + usage.outputTokens * price.output) / 1_000_000;
}
