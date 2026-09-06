import { costOf, DEFAULT_PRICES } from './pricing';
import { detectUsage } from './usage';
import { windowBounds, windowKey } from './windows';
import type {
  BudgetOptions,
  BudgetReason,
  BudgetStore,
  Clock,
  Decision,
  GuardOptions,
  Limits,
  MetricState,
  PriceTable,
  RecordResult,
  Usage,
} from './types';

export class BudgetExceededError extends Error {
  constructor(
    readonly principal: string,
    readonly reason: BudgetReason,
    readonly decision: Decision,
  ) {
    super(`budget exceeded for "${principal}": ${reason} (resets ${new Date(decision[reason].resetsAt).toISOString()})`);
    this.name = 'BudgetExceededError';
  }
}

export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`no price for model "${model}"; add it to prices or set unknownModel: 'zero'`);
    this.name = 'UnknownModelError';
  }
}

const RATE_BUCKET_TTL_FACTOR = 2;

/**
 * Per-principal budgets and rate limits for model calls, backed by a
 * shared store so every instance of your app enforces the same numbers.
 */
export class Budget {
  private readonly store: BudgetStore;
  private readonly resolveLimits: (principal: string) => Limits | Promise<Limits>;
  private readonly prices: PriceTable;
  private readonly warnAt: number;
  private readonly unknownModel: 'zero' | 'throw';
  private readonly clock: Clock;
  private readonly prefix: string;

  constructor(options: BudgetOptions) {
    this.store = options.store;
    this.resolveLimits = typeof options.limits === 'function' ? options.limits : () => options.limits as Limits;
    this.prices = { ...DEFAULT_PRICES, ...options.prices };
    this.warnAt = options.warnAt ?? 0.8;
    this.unknownModel = options.unknownModel ?? 'zero';
    this.clock = options.clock ?? Date.now;
    this.prefix = options.prefix ?? 'llmb';
  }

  private key(principal: string, metric: string, window: string): string {
    return `${this.prefix}:${principal}:${metric}:${window}`;
  }

  /** Sliding-window request count: current bucket + weighted previous bucket. */
  private async rateUsed(principal: string, perMs: number): Promise<{ used: number; resetsAt: number }> {
    const now = this.clock();
    const current = Math.floor(now / perMs) * perMs;
    const previous = current - perMs;
    const [cur, prev] = await Promise.all([
      this.store.get(this.key(principal, 'rate', String(current))),
      this.store.get(this.key(principal, 'rate', String(previous))),
    ]);
    const elapsedFraction = (now - current) / perMs;
    return { used: cur + prev * (1 - elapsedFraction), resetsAt: current + perMs };
  }

  /** Evaluates the principal's limits. `estimateTokens` is counted against the token budget. */
  async check(principal: string, estimateTokens = 0): Promise<Decision> {
    const limits = await this.resolveLimits(principal);
    const window = limits.window ?? 'month';
    const now = this.clock();
    const { end } = windowBounds(window, now);
    const wk = windowKey(window, now);

    const [tokens, usd, requests] = await Promise.all([
      this.store.get(this.key(principal, 'tokens', wk)),
      this.store.get(this.key(principal, 'usd', wk)),
      this.store.get(this.key(principal, 'requests', wk)),
    ]);
    const rate = limits.rate ? await this.rateUsed(principal, limits.rate.perMs ?? 60_000) : { used: 0, resetsAt: now };

    const state = (used: number, limit: number | undefined, resetsAt: number): MetricState => ({
      used,
      limit: limit ?? null,
      remaining: limit === undefined ? null : Math.max(0, limit - used),
      resetsAt,
    });

    const decision: Decision = {
      allowed: true,
      tokens: state(tokens, limits.tokens, end),
      usd: state(usd, limits.usd, end),
      requests: state(requests, limits.requests, end),
      rate: state(rate.used, limits.rate?.requests, rate.resetsAt),
      warnings: [],
    };

    // A metric blocks once its limit is reached; tokens also block when the
    // estimated call would push usage past the limit.
    const atLimit = (m: MetricState) => m.limit !== null && m.used >= m.limit;
    const checks: Array<[BudgetReason, boolean]> = [
      ['rate', atLimit(decision.rate)],
      ['requests', atLimit(decision.requests)],
      ['usd', atLimit(decision.usd)],
      ['tokens', atLimit(decision.tokens) || (decision.tokens.limit !== null && tokens + estimateTokens > decision.tokens.limit)],
    ];
    for (const [reason, exceeded] of checks) {
      if (exceeded) {
        decision.allowed = false;
        decision.reason = reason;
        break;
      }
    }
    for (const reason of ['tokens', 'usd', 'requests', 'rate'] as const) {
      const m = decision[reason];
      if (m.limit !== null && m.limit > 0 && m.used / m.limit >= this.warnAt) decision.warnings.push(reason);
    }
    return decision;
  }

  /** Records a completed call's usage and cost against the principal. */
  async record(principal: string, usage: Usage): Promise<RecordResult> {
    const limits = await this.resolveLimits(principal);
    const window = limits.window ?? 'month';
    const now = this.clock();
    const { end } = windowBounds(window, now);
    const wk = windowKey(window, now);
    const ttl = Math.max(1, end - now);

    let cost = costOf(usage, this.prices);
    let unpriced = false;
    if (cost === null) {
      if (this.unknownModel === 'throw') throw new UnknownModelError(usage.model);
      cost = 0;
      unpriced = true;
    }

    const writes: Promise<number>[] = [
      this.store.increment(this.key(principal, 'tokens', wk), usage.inputTokens + usage.outputTokens, ttl),
      this.store.increment(this.key(principal, 'usd', wk), cost, ttl),
      this.store.increment(this.key(principal, 'requests', wk), 1, ttl),
    ];
    if (limits.rate) {
      const perMs = limits.rate.perMs ?? 60_000;
      const bucket = Math.floor(now / perMs) * perMs;
      writes.push(this.store.increment(this.key(principal, 'rate', String(bucket)), 1, perMs * RATE_BUCKET_TTL_FACTOR));
    }
    await Promise.all(writes);
    return { usage, cost, unpriced };
  }

  /**
   * The one-liner: checks the budget, runs the call, records its usage.
   * Throws BudgetExceededError before running when over budget. A call
   * that throws is not recorded.
   */
  async guard<T>(principal: string, fn: () => Promise<T>, options: GuardOptions = {}): Promise<T> {
    const decision = await this.check(principal, options.estimateTokens ?? 0);
    if (!decision.allowed) throw new BudgetExceededError(principal, decision.reason!, decision);
    const result = await fn();
    const usage = (options.usage ?? detectUsage)(result);
    if (usage) await this.record(principal, usage);
    return result;
  }

  /** Current usage against limits without counting anything. */
  summary(principal: string): Promise<Decision> {
    return this.check(principal, 0);
  }
}
