# llm-budget

[![npm version](https://img.shields.io/npm/v/llm-budget)](https://www.npmjs.com/package/llm-budget)
[![CI](https://github.com/qwertymuzaffar/llm-budget/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertymuzaffar/llm-budget/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Per-user **token and dollar budgets**, **rate limits**, and a **circuit breaker** for LLM API calls - the cost-control layer every AI SaaS needs before real users touch it. Usage is metered straight from OpenAI and Anthropic responses, counters live in a shared store so every instance of your app enforces the same numbers, and one middleware turns "over budget" into a 429. Zero dependencies; Node 18+.

## Why

One user with a script and your API can turn a $50 month into a $5,000 one overnight. Provider dashboards show you the damage after the fact; provider rate limits protect *them*, not you. What you need is a per-user meter with a hard stop, enforced on every request across every instance of your app, with numbers your UI can show. That is the whole scope of this library.

## Install

```bash
npm i llm-budget
```

## Quick start

```ts
import OpenAI from 'openai';
import { Budget, MemoryStore } from 'llm-budget';

const openai = new OpenAI();
const budget = new Budget({
  store: new MemoryStore(), // SqlStore for production - see "Shared storage"
  limits: { usd: 5, requests: 500, window: 'month', rate: { requests: 20, perMs: 60_000 } },
});

// checks the budget, runs the call, meters the response - or throws BudgetExceededError first
const completion = await budget.guard(userId, () =>
  openai.chat.completions.create({ model: 'gpt-4o-mini', messages }),
  { estimateTokens: 1200 },
);
```

Anthropic works the same - usage is auto-detected from either provider's response shape:

```ts
const message = await budget.guard(userId, () =>
  anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages }),
);
```

## Concepts

**Principal** - whoever the budget belongs to: a user id, a team id, an API key. Every counter is scoped to it, so two principals never see each other's usage.

**Limits** - what the principal may consume. Omit a field to leave it unlimited:

| Limit | Meaning | Window |
|---|---|---|
| `usd` | Spend, computed from the model's price per token | `'hour'`, `'day'`, `'month'` (default), or a length in ms |
| `tokens` | Input + output tokens; `estimateTokens` is checked *before* the call | same |
| `requests` | Model calls | same |
| `rate` | Burst control: `{ requests, perMs }`, sliding window | independent of the budget window |

**Decision** - what `check()` and `summary()` return: for each metric, `used`, `limit`, `remaining`, and `resetsAt`, plus `allowed`, the first exceeded `reason`, and `warnings` for metrics at or past 80% (configurable with `warnAt`). It is designed to be sent straight to a usage meter in your UI.

**Windows** are fixed and UTC: `'day'` resets at 00:00 UTC, `'month'` on the first of the month. Counters are keyed by principal, metric, and window, so a new window starts from zero automatically and old counters expire on their own.

### How the sliding rate limit works

A fixed one-minute window lets a user fire 20 requests at 0:59 and 20 more at 1:01. `rate` avoids that with the standard two-bucket approximation: the current bucket's count plus the previous bucket's count weighted by how much of the previous window still overlaps. It costs two counter reads, has no per-request log to store, and is accurate enough for abuse control (it slightly over-counts at bucket boundaries, never under-counts).

## Examples

### Plan tiers

`limits` can be a resolver - sync or async - so tiers are one function and live wherever your plans live:

```ts
const budget = new Budget({
  store,
  limits: async (userId) => {
    const plan = await db.planFor(userId);
    return plan === 'pro'
      ? { usd: 50, window: 'month', rate: { requests: 60, perMs: 60_000 } }
      : { usd: 2, requests: 100, window: 'month', rate: { requests: 10, perMs: 60_000 } };
  },
});
```

### Showing users where they stand

```ts
const d = await budget.summary(userId);

render({
  spentPercent: d.usd.limit ? Math.round((100 * d.usd.used) / d.usd.limit) : null,
  resetsAt: new Date(d.usd.resetsAt),
  nearLimit: d.warnings.includes('usd'),
});
```

### Team budget plus per-user rate limit

Budgets compose: run a check against the team, then guard against the user, and record to both.

```ts
const team = new Budget({ store, limits: { usd: 500, window: 'month' }, prefix: 'team' });
const user = new Budget({ store, limits: { rate: { requests: 30, perMs: 60_000 } }, prefix: 'user' });

const teamDecision = await team.check(teamId, estimate);
if (!teamDecision.allowed) throw new BudgetExceededError(teamId, teamDecision.reason!, teamDecision);

const result = await user.guard(userId, () => openai.chat.completions.create(...), { estimateTokens: estimate });
await team.record(teamId, fromOpenAI(result)!);
```

### Estimating tokens before the call

`estimateTokens` is what lets the token budget stop a huge prompt *before* it costs anything. A cheap estimate is enough - the exact count is metered from the response afterwards:

```ts
const estimate = Math.ceil(promptText.length / 4) + maxOutputTokens;
await budget.guard(userId, call, { estimateTokens: estimate });
```

For exact counts use a tokenizer such as `js-tiktoken`; for chunked documents, [chunklet](https://www.npmjs.com/package/chunklet) reports `tokens` per chunk.

### Streaming

Streams deliver usage at the end. `budget.meter()` passes the stream through and records once it completes - OpenAI's final chunk (enable `stream_options.include_usage`) or Anthropic's `message_start` + `message_delta` events are both understood:

```ts
const decision = await budget.check(userId, estimate);
if (!decision.allowed) return res.status(429).json({ reason: decision.reason });

const stream = await openai.chat.completions.create({ model, messages, stream: true, stream_options: { include_usage: true } });
for await (const chunk of budget.meter(userId, stream)) {
  res.write(chunk.choices[0]?.delta?.content ?? '');
}
```

A stream that throws is not charged. `meterStream(stream, onUsage)` and `StreamUsageTracker` are exported for custom pipelines.

### Reservations: no overshoot under concurrency

`guard()` normally checks first and records after, so one in-flight call can overshoot a limit by its own size - and ten concurrent calls can overshoot by ten sizes. Reservations close that gap: the estimate is charged *before* the call with atomic increments, rolled back if the totals exceed a limit, then settled to the real usage afterwards.

```ts
const result = await budget.guard(userId, () => openai.chat.completions.create({ model: 'gpt-4o-mini', messages, max_tokens: 500 }), {
  reserve: { model: 'gpt-4o-mini', inputTokens: Math.ceil(promptText.length / 4), outputTokens: 500 },
});
// on success: settled to the response's real usage; on error: released in full
```

The primitives are public for manual control:

```ts
const reservation = await budget.reserve(userId, estimate); // throws BudgetExceededError if it does not fit
try {
  const result = await call();
  await budget.settle(reservation, fromOpenAI(result)!);
} catch (e) {
  await budget.release(reservation);
  throw e;
}
```

Settlement is charged to the window the reservation was made in, even if the window rolled over mid-call.

### A ledger for billing

Counters only hold window totals. For invoices, audits, or usage exports, subscribe to every metered call and write it wherever you keep money:

```ts
const budget = new Budget({
  store,
  limits,
  onRecord: async ({ principal, usage, cost, unpriced, at }) => {
    await db.insert('llm_usage', { userId: principal, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: cost, unpriced, at: new Date(at) });
  },
});
```

`onRecord` fires after `record()` and after `settle()` (with the real usage, not the estimate).

### Handling the error in an API route

```ts
try {
  const result = await budget.guard(req.user.id, () => openai.chat.completions.create(...));
  res.json(result);
} catch (e) {
  if (e instanceof BudgetExceededError) {
    res.setHeader('Retry-After', Math.ceil((e.decision[e.reason].resetsAt - Date.now()) / 1000));
    return res.status(429).json({ error: 'budget exceeded', reason: e.reason, resetsAt: e.decision[e.reason].resetsAt });
  }
  throw e;
}
```

Or let the middleware do it (see below).

### Testing your own code

Inject a clock; every window and rate computation uses it, so tests never sleep:

```ts
let now = Date.parse('2026-01-01T00:00:00Z');
const budget = new Budget({ store: new MemoryStore(() => now), limits: { requests: 1, window: 'day' }, clock: () => now });

await budget.record('u', { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 });
expect((await budget.check('u')).allowed).toBe(false);
now += 86_400_000; // next day
expect((await budget.check('u')).allowed).toBe(true);
```

## Pricing

A built-in table covers current OpenAI and Anthropic models (list prices per 1M tokens, dated in the source). Prices change, so override or extend it:

```ts
new Budget({
  store,
  limits,
  prices: {
    'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
    'my-finetune': { input: 3, output: 12 },
  },
});
```

Model ids resolve leniently: the id is tried as given first, so a table keyed by `openai/gpt-oss-120b` matches that model, then provider prefixes and dated snapshots (`openai/gpt-4o-2024-11-20`) map to the base price. Cached prompt tokens are billed at the cached rate when the table has one. Unknown models record at $0 (`unpriced: true` in the `record()` result) by default; set `unknownModel: 'throw'` to refuse them.

## Shared storage

Budgets only work if every instance sees the same counters. `MemoryStore` is for development, tests, and single-process apps. For production, bring your own database client:

```ts
import { Pool } from 'pg';
import { Budget, SqlStore, sqlStoreSchema } from 'llm-budget';

const pool = new Pool();
await pool.query(sqlStoreSchema()); // one table - run it once as a migration

const budget = new Budget({ store: new SqlStore((sql, params) => pool.query(sql, params)), limits });
```

`SqlStore` does one atomic `INSERT ... ON CONFLICT` per increment (PostgreSQL syntax), so concurrent instances never lose updates. Expired rows are ignored on read; sweep them on a schedule (`DELETE FROM llm_budget_counters WHERE expires_at < :now`).

Redis works with either popular client, no adapter code needed:

```ts
import { createClient } from 'redis'; // or ioredis
import { Budget, RedisStore } from 'llm-budget';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
const budget = new Budget({ store: new RedisStore(client), limits });
```

`RedisStore` uses `INCRBYFLOAT` for atomic increments and `PEXPIRE` for window expiry. Any other store is a two-method interface:

```ts
interface BudgetStore {
  get(key: string): Promise<number>;
  increment(key: string, by: number, ttlMs?: number): Promise<number>; // returns the new value - must be atomic
}
```

DynamoDB is an `ADD` update expression. Keys look like `llmb:<principal>:<metric>:<window>`.

## Middleware

```ts
import { budgetMiddleware, fromOpenAI } from 'llm-budget';

app.post(
  '/api/generate',
  budgetMiddleware(budget, {
    principal: (req) => req.user?.id,
    estimateTokens: (req) => Math.ceil(String(req.body.prompt ?? '').length / 4) + 500,
  }),
  async (req, res) => {
    const result = await openai.chat.completions.create(...);
    await budget.record(req.user.id, fromOpenAI(result)!);
    res.json(result);
  },
);
```

Over budget → `429` with `{ error, reason, resetsAt }` and a `Retry-After` header. Near a limit → an `X-Budget-Warning` header. No principal → `401`. The decision is available as `req.budget`. The middleware only needs `headers`, `status()`, `setHeader()`, and `json()`, so it fits Express, Fastify's compatibility layer, and most Node frameworks.

## Circuit breaker

When a provider is down, retrying from every request makes the outage worse and burns your error budget. The breaker fails fast instead:

```ts
import { CircuitBreaker } from 'llm-budget';

const breaker = new CircuitBreaker({
  failureThreshold: 5,   // consecutive failures that open the circuit
  cooldownMs: 30_000,    // fail fast this long, then allow one trial call
  shouldTrip: (e) => (e as { status?: number }).status === undefined || e.status >= 500, // ignore 4xx
});

const result = await budget.guard(userId, () => breaker.run(() => openai.chat.completions.create(...)));
```

States: `closed` (normal) → `open` after the threshold → `half-open` after the cooldown, where one trial call either closes the circuit or re-opens it. Calls rejected while open throw `CircuitOpenError` with `retryAt`. Failed calls are never recorded against the budget.

## Performance

`npm run bench` - 10,000 principals, 200,000 check+record cycles on `MemoryStore` (Apple silicon, Node 20): **~164,000 cycles/s (6.1 µs each)**, 340,000 summary reads/s. With `SqlStore` or `RedisStore` the cost is one round trip per counter; the reads in `check()` run in parallel.

## Design notes

- **Check-then-record by default; reserve when it matters.** `guard()` meters real usage, so counters are exact, but one in-flight call can overshoot a limit by its own size and concurrent calls compound that. `estimateTokens` narrows the gap; `reserve` removes it at the cost of an estimate up front.
- **Floating-point dollars.** Costs are summed as doubles in the store; at the scale of per-user budgets the error is far below a cent. Bill from your provider invoice, not from these counters.
- **Failed calls cost nothing.** If the provider throws, nothing is recorded - but the rate bucket is also not incremented, so retries are not throttled by the budget. Use the circuit breaker for that.

## API

| Export | Description |
|---|---|
| `new Budget(options)` | `check`, `record`, `guard`, `summary`, `reserve` / `settle` / `release`, `meter(principal, stream)` |
| `MemoryStore`, `SqlStore`, `sqlStoreSchema()`, `RedisStore` | Stores; implement `BudgetStore` for others |
| `meterStream(stream, onUsage)`, `StreamUsageTracker` | Streaming usage helpers |
| `budgetMiddleware(budget, options)` | Express-compatible 429 guard |
| `CircuitBreaker` | Fail-fast wrapper for provider calls |
| `fromOpenAI(res)`, `fromAnthropic(res)`, `detectUsage(res)` | Usage extractors (`Usage` = `{ model, inputTokens, outputTokens, cachedInputTokens? }`) |
| `costOf(usage, prices)`, `resolvePrice(model, prices)`, `DEFAULT_PRICES` | Pricing helpers |
| `windowBounds(window, now)`, `windowKey(window, now)` | Window math, if you need it elsewhere |
| `BudgetExceededError`, `UnknownModelError`, `CircuitOpenError` | Typed errors carrying `reason` / `decision` / `retryAt` |

### Budget options

| Option | Default | Description |
|---|---|---|
| `store` | required | `BudgetStore` implementation |
| `limits` | required | `Limits` or `(principal) => Limits \| Promise<Limits>` |
| `prices` | built-in table | Merged over the defaults |
| `warnAt` | `0.8` | Warning threshold as a fraction of each limit |
| `unknownModel` | `'zero'` | `'zero'` records at $0, `'throw'` rejects |
| `clock` | `Date.now` | Injectable time source |
| `prefix` | `'llmb'` | Store key prefix - use different prefixes for different budgets sharing one store |
| `onRecord` | - | Ledger hook called after every `record()` / `settle()` |

## Alternatives

- [llm-meter](https://www.npmjs.com/package/llm-meter) - token tracking, cost management, and caching for a single process. llm-budget focuses on multi-tenant enforcement: per-principal plans, shared stores across instances, middleware, and a circuit breaker; no caching.
- [llm-limiter](https://www.npmjs.com/package/llm-limiter) - protects you from the *provider's* RPM/TPM limits with token-aware reservation. Complementary: llm-limiter keeps you under OpenAI's ceiling, llm-budget keeps each of your users under yours.

## License

MIT (c) Muzaffar Qosimov
