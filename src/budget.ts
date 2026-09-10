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
const DEFAULT_RATE_WINDOW_MS = 60_000;
const total = (u: Usage) => u.inputTokens + u.outputTokens;

/** The counters that live in the budget window; the rate limit has its own buckets. */
const WINDOW_METRICS = ['tokens', 'usd', 'requests'] as const;
type WindowMetric = (typeof WINDOW_METRICS)[number];
type WindowTotals = Record<WindowMetric, number>;

/** Metrics in the order a check reports the first one that blocks. */
const BLOCK_ORDER: readonly BudgetReason[] = ['rate', 'requests', 'usd', 'tokens'];
/** Metrics in the order warnings are listed. */
const WARN_ORDER: readonly BudgetReason[] = ['tokens', 'usd', 'requests', 'rate'];

/** The sliding-window rate bucket of a frame, present when the limits carry a rate limit. */
interface RateFrame {
  perMs: number;
  /** Start of the bucket that contains `now`. */
  bucketStart: number;
  currentKey: string;
  previousKey: string;
  ttlMs: number;
}

/**
 * A principal's limits and the store keys of its current window, computed
 * once per operation so every path reads and writes the same keys.
 */
interface WindowFrame {
  limits: Limits;
  now: number;
  windowKey: string;
  /** Epoch ms when the window resets. */
  resetsAt: number;
  /** Time to live for the window's counter keys. */
  ttlMs: number;
  keys: Record<WindowMetric, string>;
  rate?: RateFrame;
}

/** Counter values read from the store for one frame. */
interface WindowCounters extends WindowTotals {
  rate: { used: number; resetsAt: number };
}

/** One write to a window's counters, optionally touching a rate bucket. */
interface CounterUpdate {
  windowKey: string;
  ttlMs: number;
  deltas: WindowTotals;
  rate?: { key: string; delta: number; ttlMs: number };
}

function metricState(used: number, limit: number | undefined, resetsAt: number): MetricState {
  return {
    used,
    limit: limit ?? null,
    remaining: limit === undefined ? null : Math.max(0, limit - used),
    resetsAt,
  };
}

const atLimit = (metric: MetricState) => metric.limit !== null && metric.used >= metric.limit;

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

  private windowKeys(principal: string, windowKey: string): Record<WindowMetric, string> {
    return {
      tokens: this.key(principal, 'tokens', windowKey),
      usd: this.key(principal, 'usd', windowKey),
      requests: this.key(principal, 'requests', windowKey),
    };
  }

  /** Resolves the limits and computes the window and rate-bucket keys as of now. */
  private async frame(principal: string): Promise<WindowFrame> {
    const limits = await this.resolveLimits(principal);
    const window = limits.window ?? 'month';
    const now = this.clock();
    const { end } = windowBounds(window, now);
    const key = windowKey(window, now);
    const frame: WindowFrame = { limits, now, windowKey: key, resetsAt: end, ttlMs: Math.max(1, end - now), keys: this.windowKeys(principal, key) };
    if (limits.rate) {
      const perMs = limits.rate.perMs ?? DEFAULT_RATE_WINDOW_MS;
      const bucketStart = Math.floor(now / perMs) * perMs;
      frame.rate = {
        perMs,
        bucketStart,
        currentKey: this.key(principal, 'rate', String(bucketStart)),
        previousKey: this.key(principal, 'rate', String(bucketStart - perMs)),
        ttlMs: perMs * RATE_BUCKET_TTL_FACTOR,
      };
    }
    return frame;
  }

  /** Sliding-window request count: the current bucket plus the previous one, weighted by how much of it still overlaps. */
  private rateUsage(frame: WindowFrame, current: number, previous: number): { used: number; resetsAt: number } {
    if (!frame.rate) return { used: 0, resetsAt: frame.now };
    const elapsedFraction = (frame.now - frame.rate.bucketStart) / frame.rate.perMs;
    return { used: current + previous * (1 - elapsedFraction), resetsAt: frame.rate.bucketStart + frame.rate.perMs };
  }

  /** The frame plus its counters, read from the store in one parallel batch. */
  private async snapshot(principal: string): Promise<{ frame: WindowFrame; counters: WindowCounters }> {
    const frame = await this.frame(principal);
    const rateKeys = frame.rate ? [frame.rate.currentKey, frame.rate.previousKey] : [];
    const values = await Promise.all([...WINDOW_METRICS.map((metric) => frame.keys[metric]), ...rateKeys].map((key) => this.store.get(key)));
    const [tokens, usd, requests, rateCurrent = 0, ratePrevious = 0] = values;
    return { frame, counters: { tokens, usd, requests, rate: this.rateUsage(frame, rateCurrent, ratePrevious) } };
  }

  /** Evaluates the principal's limits. `estimateTokens` is counted against the token budget. */
  async check(principal: string, estimateTokens = 0): Promise<Decision> {
    const { frame, counters } = await this.snapshot(principal);
    const { limits, resetsAt } = frame;
    const decision: Decision = {
      allowed: true,
      tokens: metricState(counters.tokens, limits.tokens, resetsAt),
      usd: metricState(counters.usd, limits.usd, resetsAt),
      requests: metricState(counters.requests, limits.requests, resetsAt),
      rate: metricState(counters.rate.used, limits.rate?.requests, counters.rate.resetsAt),
      warnings: [],
    };
    const reason = this.blockingReason(decision, counters.tokens + estimateTokens);
    if (reason) {
      decision.allowed = false;
      decision.reason = reason;
    }
    decision.warnings = this.warningsFor(decision);
    return decision;
  }

  /**
   * The first metric at its limit, in the order rate, requests, usd, tokens.
   * Tokens also block when the estimated call would push usage past the limit.
   */
  private blockingReason(decision: Decision, projectedTokens: number): BudgetReason | undefined {
    return BLOCK_ORDER.find((reason) => {
      const metric = decision[reason];
      return atLimit(metric) || (reason === 'tokens' && metric.limit !== null && projectedTokens > metric.limit);
    });
  }

  /** Metrics at or past the warn threshold, in reporting order. */
  private warningsFor(decision: Decision): BudgetReason[] {
    return WARN_ORDER.filter((reason) => {
      const metric = decision[reason];
      return metric.limit !== null && metric.limit > 0 && metric.used / metric.limit >= this.warnAt;
    });
  }

  private priceOf(usage: Usage): { cost: number; unpriced: boolean } {
    const cost = costOf(usage, this.prices);
    if (cost !== null) return { cost, unpriced: false };
    if (this.unknownModel === 'throw') throw new UnknownModelError(usage.model);
    return { cost: 0, unpriced: true };
  }

  /** Applies the update's deltas to the window's counters (and its rate bucket when given). */
  private async apply(principal: string, update: CounterUpdate): Promise<void> {
    const keys = this.windowKeys(principal, update.windowKey);
    const writes: Promise<number>[] = [];
    for (const metric of WINDOW_METRICS) {
      if (update.deltas[metric] !== 0) writes.push(this.store.increment(keys[metric], update.deltas[metric], update.ttlMs));
    }
    if (update.rate && update.rate.delta !== 0) writes.push(this.store.increment(update.rate.key, update.rate.delta, update.rate.ttlMs));
    await Promise.all(writes);
  }

  private async ledger(principal: string, usage: Usage, cost: number, unpriced: boolean): Promise<void> {
    if (this.onRecord) await this.onRecord({ principal, usage, cost, unpriced, at: this.clock() });
  }

  /** Records a completed call's usage and cost against the principal. */
  async record(principal: string, usage: Usage): Promise<RecordResult> {
    const { cost, unpriced } = this.priceOf(usage);
    const { windowKey, ttlMs, rate } = await this.frame(principal);
    await this.apply(principal, {
      windowKey,
      ttlMs,
      deltas: { tokens: total(usage), usd: cost, requests: 1 },
      ...(rate ? { rate: { key: rate.currentKey, delta: 1, ttlMs: rate.ttlMs } } : {}),
    });
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
    const frame = await this.frame(principal);
    const { cost } = this.priceOf(estimate);
    const reservation: Reservation = {
      principal,
      estimate,
      cost,
      windowKey: frame.windowKey,
      ttlMs: frame.ttlMs,
      ...(frame.rate ? { rateBucket: frame.rate.currentKey } : {}),
    };

    const [tokens, usd, requests, rateCurrent] = await Promise.all([
      this.store.increment(frame.keys.tokens, total(estimate), frame.ttlMs),
      this.store.increment(frame.keys.usd, cost, frame.ttlMs),
      this.store.increment(frame.keys.requests, 1, frame.ttlMs),
      frame.rate ? this.store.increment(frame.rate.currentKey, 1, frame.rate.ttlMs) : Promise.resolve(0),
    ]);

    const reason = await this.overshoot(frame, { tokens, usd, requests }, rateCurrent);
    if (reason) {
      await this.release(reservation);
      throw new BudgetExceededError(principal, reason, await this.check(principal, total(estimate)));
    }
    return reservation;
  }

  /** The first limit the incremented totals pass, in the order rate, requests, usd, tokens. */
  private async overshoot(frame: WindowFrame, totals: WindowTotals, rateCurrent: number): Promise<BudgetReason | undefined> {
    const { limits } = frame;
    if (frame.rate && limits.rate) {
      const ratePrevious = await this.store.get(frame.rate.previousKey);
      if (this.rateUsage(frame, rateCurrent, ratePrevious).used > limits.rate.requests) return 'rate';
    }
    if (limits.requests !== undefined && totals.requests > limits.requests) return 'requests';
    if (limits.usd !== undefined && totals.usd > limits.usd) return 'usd';
    if (limits.tokens !== undefined && totals.tokens > limits.tokens) return 'tokens';
    return undefined;
  }

  /** Replaces a reservation's estimate with the real usage (deltas may be negative). */
  async settle(reservation: Reservation, actual: Usage): Promise<RecordResult> {
    const { cost, unpriced } = this.priceOf(actual);
    await this.apply(reservation.principal, {
      windowKey: reservation.windowKey,
      ttlMs: reservation.ttlMs,
      deltas: { tokens: total(actual) - total(reservation.estimate), usd: cost - reservation.cost, requests: 0 },
    });
    await this.ledger(reservation.principal, actual, cost, unpriced);
    return { usage: actual, cost, unpriced };
  }

  /** Gives a reservation back in full - the call never happened. */
  async release(reservation: Reservation): Promise<void> {
    await this.apply(reservation.principal, {
      windowKey: reservation.windowKey,
      ttlMs: reservation.ttlMs,
      deltas: { tokens: -total(reservation.estimate), usd: -reservation.cost, requests: -1 },
      ...(reservation.rateBucket ? { rate: { key: reservation.rateBucket, delta: -1, ttlMs: reservation.ttlMs } } : {}),
    });
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
