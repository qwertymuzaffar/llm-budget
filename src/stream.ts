import { fromOpenAI } from './usage';
import type { Usage } from './types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Accumulates usage across streamed events from either provider:
 * - OpenAI: the final chunk carries `usage` (enable `stream_options.include_usage`)
 * - Anthropic: `message_start` carries the model and input tokens, `message_delta` the output tokens
 */
export class StreamUsageTracker {
  private usage: Usage | null = null;

  observe(event: unknown): void {
    if (!isRec(event)) return;
    const type = event['type'];
    if (type === 'message_start' && isRec(event['message'])) {
      const message = event['message'];
      const u = isRec(message['usage']) ? message['usage'] : {};
      const cacheRead = num(u['cache_read_input_tokens']);
      this.usage = {
        model: String(message['model'] ?? 'unknown'),
        inputTokens: num(u['input_tokens']) + cacheRead + num(u['cache_creation_input_tokens']),
        outputTokens: num(u['output_tokens']),
        ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
      };
      return;
    }
    if (type === 'message_delta' && isRec(event['usage'])) {
      const out = num(event['usage']['output_tokens']);
      if (this.usage) this.usage = { ...this.usage, outputTokens: out };
      else this.usage = { model: 'unknown', inputTokens: num(event['usage']['input_tokens']), outputTokens: out };
      return;
    }
    const openai = fromOpenAI(event);
    if (openai) this.usage = openai;
  }

  /** Usage seen so far; null until a usage-bearing event arrived. */
  result(): Usage | null {
    return this.usage;
  }
}

/**
 * Passes a provider stream through unchanged and calls `onUsage` once it
 * completes, with the accumulated usage (or null if the stream carried none).
 */
export async function* meterStream<T>(
  source: AsyncIterable<T>,
  onUsage: (usage: Usage | null) => void | Promise<void>,
): AsyncGenerator<T> {
  const tracker = new StreamUsageTracker();
  let completed = false;
  try {
    for await (const event of source) {
      tracker.observe(event);
      yield event;
    }
    completed = true;
  } finally {
    // Only meter streams that ran to completion; an aborted stream may have
    // no usage, and a provider error should not be charged.
    if (completed) await onUsage(tracker.result());
  }
}
