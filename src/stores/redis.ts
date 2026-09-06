import type { BudgetStore } from '../types';

/**
 * The Redis commands the store needs, in either casing so both node-redis
 * (camelCase) and ioredis (lowercase) clients work without adapters.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  incrByFloat?(key: string, increment: number): Promise<string | number>;
  incrbyfloat?(key: string, increment: number | string): Promise<string | number>;
  pExpire?(key: string, ms: number): Promise<unknown>;
  pexpire?(key: string, ms: number): Promise<unknown>;
}

/**
 * Redis-backed store: INCRBYFLOAT for atomic increments, PEXPIRE for
 * window expiry. Works with node-redis v4+ and ioredis.
 *
 * ```ts
 * import { createClient } from 'redis';
 * const client = createClient(); await client.connect();
 * const budget = new Budget({ store: new RedisStore(client), limits });
 * ```
 */
export class RedisStore implements BudgetStore {
  constructor(private readonly client: RedisLike) {
    if (!client.incrByFloat && !client.incrbyfloat) {
      throw new TypeError('RedisStore: client must implement incrByFloat (node-redis) or incrbyfloat (ioredis)');
    }
  }

  async get(key: string): Promise<number> {
    const value = await this.client.get(key);
    return value === null ? 0 : Number(value);
  }

  async increment(key: string, by: number, ttlMs?: number): Promise<number> {
    const result = this.client.incrByFloat
      ? await this.client.incrByFloat(key, by)
      : await this.client.incrbyfloat!(key, by);
    if (ttlMs !== undefined) {
      if (this.client.pExpire) await this.client.pExpire(key, ttlMs);
      else if (this.client.pexpire) await this.client.pexpire(key, ttlMs);
    }
    return Number(result);
  }
}
