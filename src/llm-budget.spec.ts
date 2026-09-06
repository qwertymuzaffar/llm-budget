import {
  Budget,
  BudgetExceededError,
  CircuitBreaker,
  CircuitOpenError,
  MemoryStore,
  SqlStore,
  UnknownModelError,
  budgetMiddleware,
  costOf,
  detectUsage,
  fromAnthropic,
  fromOpenAI,
  resolvePrice,
  sqlStoreSchema,
  windowBounds,
  windowKey,
  DEFAULT_PRICES,
} from './index';
import type { Decision, SqlQuery } from './index';

/** Controllable clock starting at a fixed UTC instant. */
function fakeClock(startIso = '2026-09-06T12:00:00Z') {
  let now = Date.parse(startIso);
  const clock = () => now;
  return { clock, advance: (ms: number) => (now += ms), set: (iso: string) => (now = Date.parse(iso)) };
}

const openaiResponse = (input: number, output: number, cached = 0) => ({
  model: 'gpt-4o-mini',
  usage: { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: cached } },
});

describe('pricing', () => {
  it('resolves exact, prefixed, dated, and prefix-matched model ids', () => {
    expect(resolvePrice('gpt-4o', DEFAULT_PRICES)).toEqual(DEFAULT_PRICES['gpt-4o']);
    expect(resolvePrice('openai/gpt-4o', DEFAULT_PRICES)).toEqual(DEFAULT_PRICES['gpt-4o']);
    expect(resolvePrice('gpt-4o-2024-11-20', DEFAULT_PRICES)).toEqual(DEFAULT_PRICES['gpt-4o']);
    expect(resolvePrice('claude-sonnet-4-6-latest', DEFAULT_PRICES)).toEqual(DEFAULT_PRICES['claude-sonnet-4-6']);
    expect(resolvePrice('totally-unknown', DEFAULT_PRICES)).toBeNull();
  });

  it('computes cost with cached input at the cached rate', () => {
    // gpt-4o-mini: $0.15 in, $0.6 out, $0.075 cached per 1M
    const cost = costOf({ model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 500_000 }, DEFAULT_PRICES);
    expect(cost).toBeCloseTo(0.075 + 0.0375 + 0.6, 6);
    expect(costOf({ model: 'nope', inputTokens: 1, outputTokens: 1 }, DEFAULT_PRICES)).toBeNull();
  });
});

describe('windows', () => {
  it('computes hour/day/custom/month bounds in UTC', () => {
    const now = Date.parse('2026-09-06T12:34:56Z');
    expect(windowBounds('hour', now)).toEqual({ start: Date.parse('2026-09-06T12:00:00Z'), end: Date.parse('2026-09-06T13:00:00Z') });
    expect(windowBounds('day', now)).toEqual({ start: Date.parse('2026-09-06T00:00:00Z'), end: Date.parse('2026-09-07T00:00:00Z') });
    expect(windowBounds('month', now)).toEqual({ start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-10-01T00:00:00Z') });
    expect(windowBounds(1000, 12_345).end - windowBounds(1000, 12_345).start).toBe(1000);
    expect(windowKey('month', now)).toBe('2026-09');
    expect(() => windowBounds(-5, now)).toThrow(RangeError);
  });

  it('month rollover crosses a year boundary', () => {
    const dec = Date.parse('2026-12-31T23:59:59Z');
    expect(windowBounds('month', dec).end).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });
});

describe('usage extractors', () => {
  it('reads OpenAI chat and responses shapes', () => {
    expect(fromOpenAI(openaiResponse(100, 50, 20))).toEqual({ model: 'gpt-4o-mini', inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 });
    expect(fromOpenAI({ model: 'gpt-4.1', usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } })).toEqual({ model: 'gpt-4.1', inputTokens: 10, outputTokens: 5 });
    expect(fromOpenAI({ no: 'usage' })).toBeNull();
  });

  it('reads Anthropic usage including cache tokens', () => {
    const r = { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 } };
    expect(fromAnthropic(r)).toEqual({ model: 'claude-sonnet-4-6', inputTokens: 450, outputTokens: 40, cachedInputTokens: 300 });
  });

  it('auto-detects providers and plain usage objects', () => {
    expect(detectUsage(openaiResponse(1, 2))?.inputTokens).toBe(1);
    expect(detectUsage({ model: 'claude-haiku-4-5', usage: { input_tokens: 3, output_tokens: 4 } })?.outputTokens).toBe(4);
    expect(detectUsage({ model: 'x', inputTokens: 5, outputTokens: 6 })).toEqual({ model: 'x', inputTokens: 5, outputTokens: 6 });
    expect(detectUsage('nothing')).toBeNull();
    expect(detectUsage({ usage: { weird: 1 } })).toBeNull();
  });
});

describe('Budget', () => {
  function setup(limits: ConstructorParameters<typeof Budget>[0]['limits'], extra: Partial<ConstructorParameters<typeof Budget>[0]> = {}) {
    const time = fakeClock();
    const store = new MemoryStore(time.clock);
    const budget = new Budget({ store, limits, clock: time.clock, ...extra });
    return { budget, store, time };
  }

  it('starts with everything allowed and unlimited metrics as null', async () => {
    const { budget } = setup({ usd: 10 });
    const d = await budget.check('u1');
    expect(d.allowed).toBe(true);
    expect(d.tokens.limit).toBeNull();
    expect(d.usd).toEqual(expect.objectContaining({ used: 0, limit: 10, remaining: 10 }));
    expect(d.usd.resetsAt).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });

  it('records usage, computes cost, and blocks at the dollar limit', async () => {
    const { budget } = setup({ usd: 0.001, window: 'day' });
    // gpt-4o-mini 1000 in + 1000 out = 0.00015 + 0.0006 = 0.00075
    const r = await budget.record('u1', { model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 1000 });
    expect(r.cost).toBeCloseTo(0.00075, 8);
    expect((await budget.check('u1')).allowed).toBe(true);
    await budget.record('u1', { model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 1000 });
    const d = await budget.check('u1');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('usd');
    expect(d.usd.remaining).toBe(0);
  });

  it('token estimate blocks a call that would exceed the token budget', async () => {
    const { budget } = setup({ tokens: 1000 });
    await budget.record('u1', { model: 'gpt-4o', inputTokens: 600, outputTokens: 200 });
    expect((await budget.check('u1', 100)).allowed).toBe(true);
    const d = await budget.check('u1', 300);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('tokens');
  });

  it('counts requests and resets when the window rolls over', async () => {
    const { budget, time } = setup({ requests: 2, window: 'hour' });
    await budget.record('u1', { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
    await budget.record('u1', { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
    expect((await budget.check('u1')).reason).toBe('requests');
    time.advance(60 * 60 * 1000);
    const d = await budget.check('u1');
    expect(d.allowed).toBe(true);
    expect(d.requests.used).toBe(0);
  });

  it('keeps principals isolated', async () => {
    const { budget } = setup({ requests: 1 });
    await budget.record('a', { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
    expect((await budget.check('a')).allowed).toBe(false);
    expect((await budget.check('b')).allowed).toBe(true);
  });

  it('raises warnings at the warn threshold', async () => {
    const { budget } = setup({ tokens: 100 }, { warnAt: 0.5 });
    await budget.record('u1', { model: 'gpt-4o', inputTokens: 30, outputTokens: 30 });
    const d = await budget.check('u1');
    expect(d.allowed).toBe(true);
    expect(d.warnings).toEqual(['tokens']);
  });

  it('sliding-window rate limit blocks bursts and decays', async () => {
    const { budget, time } = setup({ rate: { requests: 3, perMs: 60_000 } });
    for (let i = 0; i < 3; i++) await budget.record('u1', { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
    expect((await budget.check('u1')).reason).toBe('rate');
    time.advance(45_000); // still inside the same bucket
    expect((await budget.check('u1')).allowed).toBe(false);
    time.advance(30_000); // next bucket, previous weighted by remaining fraction
    const d = await budget.check('u1');
    expect(d.rate.used).toBeCloseTo(3 * (1 - 15_000 / 60_000), 5);
    expect(d.allowed).toBe(true);
  });

  it('resolves limits per principal via a resolver (async)', async () => {
    const { budget } = setup(async (p) => (p === 'pro' ? { requests: 100 } : { requests: 1 }));
    await budget.record('free', { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
    await budget.record('pro', { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
    expect((await budget.check('free')).allowed).toBe(false);
    expect((await budget.check('pro')).allowed).toBe(true);
  });

  it('handles unknown models per policy', async () => {
    const zero = setup({ usd: 1 });
    const r = await zero.budget.record('u', { model: 'mystery', inputTokens: 10, outputTokens: 10 });
    expect(r).toEqual(expect.objectContaining({ cost: 0, unpriced: true }));
    const strict = setup({ usd: 1 }, { unknownModel: 'throw' });
    await expect(strict.budget.record('u', { model: 'mystery', inputTokens: 1, outputTokens: 1 })).rejects.toThrow(UnknownModelError);
  });

  it('merges custom prices over the defaults', async () => {
    const { budget } = setup({ usd: 100 }, { prices: { 'my-model': { input: 1_000_000, output: 0 } } });
    const r = await budget.record('u', { model: 'my-model', inputTokens: 3, outputTokens: 0 });
    expect(r.cost).toBe(3);
  });

  it('guard() checks, runs, records, and rethrows without recording on failure', async () => {
    const { budget } = setup({ usd: 1, requests: 5 });
    const out = await budget.guard('u1', async () => openaiResponse(100, 50));
    expect(out.usage.prompt_tokens).toBe(100);
    expect((await budget.summary('u1')).requests.used).toBe(1);

    await expect(budget.guard('u1', async () => { throw new Error('provider down'); })).rejects.toThrow('provider down');
    expect((await budget.summary('u1')).requests.used).toBe(1);
  });

  it('guard() throws BudgetExceededError with the decision attached', async () => {
    const { budget } = setup({ requests: 1 });
    await budget.guard('u1', async () => openaiResponse(1, 1));
    const err = await budget.guard('u1', async () => openaiResponse(1, 1)).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.reason).toBe('requests');
    expect(err.decision.requests.used).toBe(1);
  });

  it('guard() supports a custom usage extractor and skips recording when none', async () => {
    const { budget } = setup({ requests: 10 });
    await budget.guard('u1', async () => ({ tokensUsed: 42 }), { usage: (r) => ({ model: 'gpt-4o', inputTokens: (r as { tokensUsed: number }).tokensUsed, outputTokens: 0 }) });
    expect((await budget.summary('u1')).tokens.used).toBe(42);
    await budget.guard('u1', async () => 'no usage here');
    expect((await budget.summary('u1')).requests.used).toBe(1);
  });
});

describe('MemoryStore', () => {
  it('expires keys by ttl using the clock', async () => {
    const time = fakeClock();
    const store = new MemoryStore(time.clock);
    await store.increment('k', 5, 1000);
    expect(await store.get('k')).toBe(5);
    time.advance(1001);
    expect(await store.get('k')).toBe(0);
    expect(store.size).toBe(0);
  });
});

describe('SqlStore', () => {
  /** Fake executor implementing the upsert semantics over a Map. */
  function fakeSql() {
    const rows = new Map<string, { value: number; expires_at: number | null }>();
    const query: SqlQuery = async (sql, params) => {
      if (sql.startsWith('SELECT')) {
        const [key, now] = params as [string, number];
        const row = rows.get(key);
        return { rows: row && (row.expires_at === null || row.expires_at > now) ? [{ value: row.value }] : [] };
      }
      const [key, by, expiresAt, now] = params as [string, number, number | null, number];
      const existing = rows.get(key);
      const expired = existing && existing.expires_at !== null && existing.expires_at <= now;
      const value = existing && !expired ? existing.value + by : by;
      rows.set(key, { value, expires_at: expiresAt ?? existing?.expires_at ?? null });
      return { rows: [{ value }] };
    };
    return { query, rows };
  }

  it('increments atomically and respects expiry', async () => {
    const { query } = fakeSql();
    const store = new SqlStore(query);
    expect(await store.increment('a', 2, 60_000)).toBe(2);
    expect(await store.increment('a', 3)).toBe(5);
    expect(await store.get('a')).toBe(5);
    expect(await store.get('missing')).toBe(0);
  });

  it('ships a schema and honors a custom table name', async () => {
    expect(sqlStoreSchema()).toContain('CREATE TABLE IF NOT EXISTS llm_budget_counters');
    let seen = '';
    const store = new SqlStore(async (sql) => { seen = sql; return { rows: [{ value: 1 }] }; }, { table: 'quotas' });
    await store.increment('k', 1);
    expect(seen).toContain('INSERT INTO quotas');
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, fails fast, and closes after a successful trial', async () => {
    const time = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, clock: time.clock });
    const boom = async () => { throw new Error('boom'); };
    await expect(breaker.run(boom)).rejects.toThrow('boom');
    await expect(breaker.run(boom)).rejects.toThrow('boom');
    expect(breaker.state).toBe('open');
    await expect(breaker.run(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError);
    time.advance(1000);
    expect(breaker.state).toBe('half-open');
    expect(await breaker.run(async () => 'ok')).toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('a failed trial re-opens; shouldTrip filters errors', async () => {
    const time = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, clock: time.clock, shouldTrip: (e) => (e as Error).message !== 'client' });
    await expect(breaker.run(async () => { throw new Error('client'); })).rejects.toThrow('client');
    expect(breaker.state).toBe('closed');
    await expect(breaker.run(async () => { throw new Error('server'); })).rejects.toThrow('server');
    expect(breaker.state).toBe('open');
    time.advance(500);
    await expect(breaker.run(async () => { throw new Error('server'); })).rejects.toThrow('server');
    expect(breaker.state).toBe('open');
    breaker.reset();
    expect(breaker.state).toBe('closed');
  });
});

describe('budgetMiddleware', () => {
  function fakeRes() {
    const res = { code: 200, headers: {} as Record<string, string>, body: undefined as unknown, status(c: number) { res.code = c; return res; }, setHeader(n: string, v: string) { res.headers[n] = v; }, json(b: unknown) { res.body = b; } };
    return res;
  }

  it('passes through under budget, exposes the decision, and 429s when over', async () => {
    const time = fakeClock();
    const budget = new Budget({ store: new MemoryStore(time.clock), limits: { requests: 1 }, clock: time.clock });
    const mw = budgetMiddleware(budget, { principal: (req) => req.headers['x-user'] as string | undefined });

    const req = { headers: { 'x-user': 'u1' } } as { headers: Record<string, string>; budget?: Decision };
    const res = fakeRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.budget?.allowed).toBe(true);

    await budget.record('u1', { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
    const res2 = fakeRes();
    nextCalled = false;
    await mw({ headers: { 'x-user': 'u1' } }, res2, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res2.code).toBe(429);
    expect(res2.headers['Retry-After']).toBeDefined();
    expect((res2.body as { reason: string }).reason).toBe('requests');
  });

  it('401s without a principal and forwards errors to next', async () => {
    const budget = new Budget({ store: new MemoryStore(), limits: {} });
    const res = fakeRes();
    await budgetMiddleware(budget, { principal: () => undefined })({ headers: {} }, res, () => {});
    expect(res.code).toBe(401);

    let forwarded: unknown;
    await budgetMiddleware(budget, { principal: () => { throw new Error('resolver failed'); } })({ headers: {} }, fakeRes(), (e) => { forwarded = e; });
    expect((forwarded as Error).message).toBe('resolver failed');
  });
});
