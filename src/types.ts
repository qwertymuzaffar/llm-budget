/** Time source; injectable for tests. Returns epoch milliseconds. */
export type Clock = () => number;

/** Fixed budget windows. Numbers are a custom window length in ms. */
export type Window = 'hour' | 'day' | 'month' | number;

/** Token usage of one model call. */
export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cached/read prompt tokens, billed at the model's cached rate when known. */
  cachedInputTokens?: number;
}

/** USD per one million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
}

export type PriceTable = Record<string, ModelPrice>;

export interface RateLimit {
  /** Requests allowed per window. */
  requests: number;
  /** Sliding window length in ms (default 60_000). */
  perMs?: number;
}

/** Limits for one principal (user, team, API key). Omit a field for "unlimited". */
export interface Limits {
  /** Total tokens (input + output) per window. */
  tokens?: number;
  /** Spend in USD per window. */
  usd?: number;
  /** Model calls per window. */
  requests?: number;
  /** Window for tokens/usd/requests (default 'month'). */
  window?: Window;
  /** Short-term request rate limit (sliding window), independent of the budget window. */
  rate?: RateLimit;
}

/** Shared counter storage; keys carry the window in their name so old windows simply age out. */
export interface BudgetStore {
  get(key: string): Promise<number>;
  /** Atomically adds `by` and returns the new value. `ttlMs` hints when the key may be discarded. */
  increment(key: string, by: number, ttlMs?: number): Promise<number>;
}

export type BudgetReason = 'tokens' | 'usd' | 'requests' | 'rate';

export interface MetricState {
  used: number;
  limit: number | null;
  remaining: number | null;
  /** Epoch ms when the window resets. */
  resetsAt: number;
}

export interface Decision {
  allowed: boolean;
  /** First exceeded metric when not allowed. */
  reason?: BudgetReason;
  tokens: MetricState;
  usd: MetricState;
  requests: MetricState;
  rate: MetricState;
  /** Metrics at or past the warn threshold (default 80%). */
  warnings: BudgetReason[];
}

export interface RecordResult {
  usage: Usage;
  /** USD cost of this call per the price table (0 when the model is unknown). */
  cost: number;
  /** True when the model had no price and `unknownModel` is 'zero'. */
  unpriced: boolean;
}

/** One metered call, emitted to `onRecord` for your own ledger/billing table. */
export interface LedgerEntry {
  principal: string;
  usage: Usage;
  cost: number;
  unpriced: boolean;
  /** Epoch ms when the usage was recorded. */
  at: number;
}

/** A held estimate; settle it with real usage or release it if the call failed. */
export interface Reservation {
  principal: string;
  estimate: Usage;
  /** Estimated cost that was charged at reservation time. */
  cost: number;
  /** Window key the reservation was charged to, so settlement lands in the same window. */
  windowKey: string;
  ttlMs: number;
  rateBucket?: string;
}

export interface BudgetOptions {
  store: BudgetStore;
  /** Called after every record/settle with the metered usage - feed your billing ledger from here. */
  onRecord?: (entry: LedgerEntry) => void | Promise<void>;
  /** Limits per principal: a constant or a resolver (sync or async). */
  limits: Limits | ((principal: string) => Limits | Promise<Limits>);
  /** Model prices; merged over the built-in table. */
  prices?: PriceTable;
  /** Fraction of a limit at which a warning is raised (default 0.8). */
  warnAt?: number;
  /** 'zero' records unknown models at $0 (default); 'throw' rejects them. */
  unknownModel?: 'zero' | 'throw';
  clock?: Clock;
  /** Key prefix in the store (default 'llmb'). */
  prefix?: string;
}

export interface GuardOptions {
  /**
   * Expected tokens for the upcoming call, checked against the remaining
   * token budget before running. Optional but recommended for long prompts.
   */
  estimateTokens?: number;
  /**
   * Reserve this estimated usage before the call (charging tokens, cost,
   * and a request up front), then settle to the real usage afterwards or
   * release it if the call throws. Closes the overshoot gap for concurrent
   * calls. Needs a model for the cost estimate.
   */
  reserve?: Usage;
  /** Extracts usage from the call's return value (default: OpenAI/Anthropic auto-detect). */
  usage?: (result: unknown) => Usage | null;
}
