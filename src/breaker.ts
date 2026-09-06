import type { Clock } from './types';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit (default 5). */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call (default 30 s). */
  cooldownMs?: number;
  /** Errors for which `shouldTrip` returns false are rethrown without counting (default: count all). */
  shouldTrip?: (error: unknown) => boolean;
  clock?: Clock;
}

export class CircuitOpenError extends Error {
  constructor(readonly retryAt: number) {
    super(`circuit open; retry after ${new Date(retryAt).toISOString()}`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Stops hammering a failing provider: after `failureThreshold` consecutive
 * failures the circuit opens and calls fail fast until `cooldownMs` passes,
 * then one trial call decides whether to close it again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly cooldown: number;
  private readonly shouldTrip: (error: unknown) => boolean;
  private readonly clock: Clock;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? 5;
    this.cooldown = options.cooldownMs ?? 30_000;
    this.shouldTrip = options.shouldTrip ?? (() => true);
    this.clock = options.clock ?? Date.now;
  }

  get state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    return this.clock() - this.openedAt >= this.cooldown ? 'half-open' : 'open';
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open' || (state === 'half-open' && this.trialInFlight)) {
      throw new CircuitOpenError((this.openedAt ?? this.clock()) + this.cooldown);
    }
    if (state === 'half-open') this.trialInFlight = true;
    try {
      const result = await fn();
      this.failures = 0;
      this.openedAt = null;
      return result;
    } catch (error) {
      if (this.shouldTrip(error)) {
        this.failures++;
        if (state === 'half-open' || this.failures >= this.threshold) this.openedAt = this.clock();
      }
      throw error;
    } finally {
      this.trialInFlight = false;
    }
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }
}
