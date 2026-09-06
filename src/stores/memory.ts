import type { BudgetStore, Clock } from '../types';

/**
 * In-process store for development, tests, and single-instance apps.
 * Keys expire lazily on access using the provided clock.
 */
export class MemoryStore implements BudgetStore {
  private readonly data = new Map<string, { value: number; expiresAt: number | null }>();

  constructor(private readonly clock: Clock = Date.now) {}

  async get(key: string): Promise<number> {
    const entry = this.data.get(key);
    if (!entry) return 0;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock()) {
      this.data.delete(key);
      return 0;
    }
    return entry.value;
  }

  async increment(key: string, by: number, ttlMs?: number): Promise<number> {
    const current = await this.get(key);
    const value = current + by;
    const expiresAt = ttlMs !== undefined ? this.clock() + ttlMs : (this.data.get(key)?.expiresAt ?? null);
    this.data.set(key, { value, expiresAt });
    return value;
  }

  /** Number of live keys (for tests and diagnostics). */
  get size(): number {
    return this.data.size;
  }
}
