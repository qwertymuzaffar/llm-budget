import { costOf, DEFAULT_PRICES } from './pricing';
import { meterStream } from './stream';
import { detectUsage } from './usage';
import { windowBounds, windowKey } from './windows';
import type {
  BudgetOptions,
  BudgetReason,
  BudgetStore,
  Clock,
  Decision,
  GuardOptions,
  LedgerEntry,
  Limits,
  MetricState,
  PriceTable,
  RecordResult,
  Reservation,
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
const total = (u: Usage) => u.inputTokens + u.outputTokens;

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
  private readonly onRecord?: (entry: LedgerEntry) => void | Promise<void>;

  constructor(options: BudgetOptions) {
    this.store = options.store;
    this.resolveLimits = typeof options.limits === 'function' ? options.limits : () => options.limits as Limits;
    this.prices = { ...DEFAULT_PRICES, ...options.prices };
    this.warnAt = options.warnAt ?? 0.8;
    this.unknownModel = options.unknownModel ?? 'zero';
    this.clock = options.clock ?? Date.now;
    this.prefix = options.prefix ?? 'llmb';
    this.onRecord = options.onRecord;
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

  private priceOf(usage: Usage): { cost: number; unpriced: boolean } {
    const cost = costOf(usage, this.prices);
    if (cost !== null) return { cost, unpriced: false };
    if (this.unknownModel === 'throw') throw new UnknownModelError(usage.model);
    return { cost: 0, unpriced: true };
  }

  /** Applies deltas to a window's counters (and optionally a rate bucket). */
  private async apply(
    principal: string,
    wk: string,
    ttl: number,
    deltas: { tokens: number; usd: number; requests: number },
    rateBucket?: { key: string; delta: number; ttl: number },
  ): Promise<void> {
    const writes: Promise<number>[] = [];
    if (deltas.tokens !== 0) writes.push(this.store.increment(this.key(principal, 'tokens', wk), deltas.tokens, ttl));
    if (deltas.usd !== 0) writes.push(this.store.increment(this.key(principal, 'usd', wk), deltas.usd, ttl));
    if (deltas.requests !== 0) writes.push(this.store.increment(this.key(principal, 'requests', wk), deltas.requests, ttl));
    if (rateBucket && rateBucket.delta !== 0) writes.push(this.store.increment(rateBucket.key, rateBucket.delta, rateBucket.ttl));
    await Promise.all(writes);
  }

  private async windowFor(principal: string): Promise<{ wk: string; ttl: number; rateBucket?: { key: string; ttl: number } }> {
    const limits = await this.resolveLimits(principal);
    const window = limits.window ?? 'month';
    const now = this.clock();
    const { end } = windowBounds(window, now);
    const out: { wk: string; ttl: number; rateBucket?: { key: string; ttl: number } } = {
      wk: windowKey(window, now),
      ttl: Math.max(1, end - now),
    };
    if (limits.rate) {
      const perMs = limits.rate.perMs ?? 60_000;
      const bucket = Math.floor(now / perMs) * perMs;
      out.rateBucket = { key: this.key(principal, 'rate', String(bucket)), ttl: perMs * RATE_BUCKET_TTL_FACTOR };
    }
    return out;
  }

  private async ledger(principal: string, usage: Usage, cost: number, unpriced: boolean): Promise<void> {
    if (this.onRecord) await this.onRecord({ principal, usage, cost, unpriced, at: this.clock() });
  }

  /** Records a completed call's usage and cost against the principal. */
  async record(principal: string, usage: Usage): Promise<RecordResult> {
    const { cost, unpriced } = this.priceOf(usage);
    const { wk, ttl, rateBucket } = await this.windowFor(principal);
    await this.apply(
      principal,
      wk,
      ttl,
      { tokens: total(usage), usd: cost, requests: 1 },
      rateBucket ? { ...rateBucket, delta: 1 } : undefined,
    );
    await this.ledger(principal, usage, cost, unpriced);
    return { usage, cost, unpriced };
  }

  /**
   * Charges an estimate up front so concurrent calls cannot collectively
   * overshoot a limit. The increments happen first (atomic in the store)
   * and are rolled back if the returned totals exceed a limit, so two
   * instances reserving at the same instant cannot both squeeze through.
   * Throws BudgetExceededError if the estimate does not fit. Pair with
   * settle() (real usage) or release() (call failed).
   */
  async reserve(principal: string, estimate: Usage): Promise<Reservation> {
    const limits = await this.resolveLimits(principal);
    const { cost } = this.priceOf(estimate);
    const { wk, ttl, rateBucket } = await this.windowFor(principal);
    const reservation: Reservation = {
      principal,
      estimate,
      cost,
      windowKey: wk,
      ttlMs: ttl,
      ...(rateBucket ? { rateBucket: rateBucket.key } : {}),
    };

    const [tokens, usd, requests, rateCurrent] = await Promise.all([
      this.store.increment(this.key(principal, 'tokens', wk), total(estimate), ttl),
      this.store.increment(this.key(principal, 'usd', wk), cost, ttl),
      this.store.increment(this.key(principal, 'requests', wk), 1, ttl),
      rateBucket ? this.store.increment(rateBucket.key, 1, rateBucket.ttl) : Promise.resolve(0),
    ]);

    let reason: BudgetReason | null = null;
    if (limits.rate && rateBucket) {
      const perMs = limits.rate.perMs ?? 60_000;
      const now = this.clock();
      const current = Math.floor(now / perMs) * perMs;
      const prev = await this.store.get(this.key(principal, 'rate', String(current - perMs)));
      const used = rateCurrent + prev * (1 - (now - current) / perMs);
      if (used > limits.rate.requests) reason = 'rate';
    }
    if (!reason && limits.requests !== undefined && requests > limits.requests) reason = 'requests';
    if (!reason && limits.usd !== undefined && usd > limits.usd) reason = 'usd';
    if (!reason && limits.tokens !== undefined && tokens > limits.tokens) reason = 'tokens';

    if (reason) {
      await this.release(reservation);
      throw new BudgetExceededError(principal, reason, await this.check(principal, total(estimate)));
    }
    return reservation;
  }

  /** Replaces a reservation's estimate with the real usage (deltas may be negative). */
  async settle(reservation: Reservation, actual: Usage): Promise<RecordResult> {
    const { cost, unpriced } = this.priceOf(actual);
    await this.apply(reservation.principal, reservation.windowKey, reservation.ttlMs, {
      tokens: total(actual) - total(reservation.estimate),
      usd: cost - reservation.cost,
      requests: 0,
    });
    await this.ledger(reservation.principal, actual, cost, unpriced);
    return { usage: actual, cost, unpriced };
  }

  /** Gives a reservation back in full - the call never happened. */
  async release(reservation: Reservation): Promise<void> {
    await this.apply(
      reservation.principal,
      reservation.windowKey,
      reservation.ttlMs,
      { tokens: -total(reservation.estimate), usd: -reservation.cost, requests: -1 },
      reservation.rateBucket ? { key: reservation.rateBucket, delta: -1, ttl: reservation.ttlMs } : undefined,
    );
  }

  /**
   * The one-liner: checks the budget, runs the call, records its usage.
   * Throws BudgetExceededError before running when over budget. A call
   * that throws is not recorded. With `reserve`, the estimate is charged
   * first and settled to the real usage afterwards.
   */
  async guard<T>(principal: string, fn: () => Promise<T>, options: GuardOptions = {}): Promise<T> {
    const extract = options.usage ?? detectUsage;

    if (options.reserve) {
      const reservation = await this.reserve(principal, options.reserve);
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        await this.release(reservation);
        throw error;
      }
      await this.settle(reservation, extract(result) ?? options.reserve);
      return result;
    }

    const decision = await this.check(principal, options.estimateTokens ?? 0);
    if (!decision.allowed) throw new BudgetExceededError(principal, decision.reason!, decision);
    const result = await fn();
    const usage = extract(result);
    if (usage) await this.record(principal, usage);
    return result;
  }

  /**
   * Wraps a provider stream: passes events through and records the usage
   * the stream reports once it completes. Check the budget before starting
   * the stream (`check()` or `reserve()`).
   */
  meter<T>(principal: string, source: AsyncIterable<T>): AsyncGenerator<T> {
    return meterStream(source, async (usage) => {
      if (usage) await this.record(principal, usage);
    });
  }

  /** Current usage against limits without counting anything. */
  summary(principal: string): Promise<Decision> {
    return this.check(principal, 0);
  }
}
