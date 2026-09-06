import type { Usage } from './types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Usage from an OpenAI response - Chat Completions (`prompt_tokens`,
 * `completion_tokens`) or the Responses API (`input_tokens`, `output_tokens`).
 * For streams, enable `stream_options: { include_usage: true }` and pass
 * the final chunk (the one carrying `usage`).
 */
export function fromOpenAI(response: unknown): Usage | null {
  if (!isRec(response) || !isRec(response['usage'])) return null;
  const u = response['usage'];
  const details = isRec(u['prompt_tokens_details']) ? u['prompt_tokens_details'] : isRec(u['input_tokens_details']) ? u['input_tokens_details'] : null;
  const inputTokens = num(u['prompt_tokens'] ?? u['input_tokens']);
  const outputTokens = num(u['completion_tokens'] ?? u['output_tokens']);
  const cached = details ? num(details['cached_tokens']) : 0;
  return {
    model: String(response['model'] ?? 'unknown'),
    inputTokens,
    outputTokens,
    ...(cached ? { cachedInputTokens: cached } : {}),
  };
}

/**
 * Usage from an Anthropic Messages response. Cache-read tokens count as
 * cached input; cache-creation tokens are billed as regular input here.
 */
export function fromAnthropic(response: unknown): Usage | null {
  if (!isRec(response) || !isRec(response['usage'])) return null;
  const u = response['usage'];
  const cacheRead = num(u['cache_read_input_tokens']);
  const cacheCreate = num(u['cache_creation_input_tokens']);
  const inputTokens = num(u['input_tokens']) + cacheRead + cacheCreate;
  return {
    model: String(response['model'] ?? 'unknown'),
    inputTokens,
    outputTokens: num(u['output_tokens']),
    ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
  };
}

/** Tries the known response shapes; also accepts a plain Usage object. */
export function detectUsage(result: unknown): Usage | null {
  if (isRec(result) && typeof result['inputTokens'] === 'number' && typeof result['outputTokens'] === 'number') {
    return result as unknown as Usage;
  }
  if (!isRec(result) || !isRec(result['usage'])) return null;
  const u = result['usage'];
  if ('prompt_tokens' in u || 'completion_tokens' in u || 'input_tokens_details' in u) return fromOpenAI(result);
  if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) return fromAnthropic(result);
  if ('input_tokens' in u || 'output_tokens' in u) {
    // both providers use these names; without cache fields the math is identical
    return fromAnthropic(result);
  }
  return null;
}
