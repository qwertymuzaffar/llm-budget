import type { BudgetStore } from '../types';

/** Minimal query executor - matches `pg`'s Pool.query and most SQL clients. */
export type SqlQuery = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface SqlStoreOptions {
  /** Table name (default llm_budget_counters). */
  table?: string;
}

/** DDL for the counters table (PostgreSQL). Run it once as a migration. */
export function sqlStoreSchema(table = 'llm_budget_counters'): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  key TEXT PRIMARY KEY,
  value DOUBLE PRECISION NOT NULL DEFAULT 0,
  expires_at BIGINT
);`;
}

/**
 * PostgreSQL-backed store using an atomic upsert per increment, so many app
 * instances can share one budget. Bring your own client: pass its query
 * function. Expired rows are ignored on read; sweep them on a schedule with
 * `DELETE FROM llm_budget_counters WHERE expires_at < :now`.
 */
export class SqlStore implements BudgetStore {
  private readonly table: string;

  constructor(
    private readonly query: SqlQuery,
    options: SqlStoreOptions = {},
  ) {
    this.table = options.table ?? 'llm_budget_counters';
  }

  async get(key: string): Promise<number> {
    const { rows } = await this.query(
      `SELECT value FROM ${this.table} WHERE key = $1 AND (expires_at IS NULL OR expires_at > $2)`,
      [key, Date.now()],
    );
    return rows.length ? Number(rows[0]['value']) : 0;
  }

  async increment(key: string, by: number, ttlMs?: number): Promise<number> {
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : null;
    const { rows } = await this.query(
      `INSERT INTO ${this.table} (key, value, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         value = CASE WHEN ${this.table}.expires_at IS NOT NULL AND ${this.table}.expires_at <= $4
                      THEN EXCLUDED.value ELSE ${this.table}.value + EXCLUDED.value END,
         expires_at = COALESCE(EXCLUDED.expires_at, ${this.table}.expires_at)
       RETURNING value`,
      [key, by, expiresAt, Date.now()],
    );
    return Number(rows[0]['value']);
  }
}
