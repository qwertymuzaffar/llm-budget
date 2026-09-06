# llm-budget

[![npm version](https://img.shields.io/npm/v/llm-budget)](https://www.npmjs.com/package/llm-budget)
[![CI](https://github.com/qwertymuzaffar/llm-budget/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertymuzaffar/llm-budget/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Per-user **token and dollar budgets**, **rate limits**, and a **circuit breaker** for LLM API calls - the cost-control layer every AI SaaS needs before real users touch it. Usage is metered straight from OpenAI and Anthropic responses, counters live in a shared store so every instance of your app enforces the same numbers, and one middleware turns "over budget" into a 429. Zero dependencies; Node 18+.

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
  store: new MemoryStore(), // SqlStore for production - see below
  limits: (userId) => plans[userId] ?? { usd: 5, requests: 500, window: 'month', rate: { requests: 20, perMs: 60_000 } },
});

// checks the budget, runs the call, meters the response - or throws BudgetExceededError first
const completion = await budget.guard(userId, () =>
  openai.chat.completions.create({ model: 'gpt-4o-mini', messages }),
  { estimateTokens: 1200 },
);
```

Works the same with Anthropic - usage is auto-detected from either provider's response shape:

```ts
const message = await budget.guard(userId, () =>
  anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages }),
);
```

## What it enforces

| Limit | Meaning | Window |
|---|---|---|
| `usd` | Spend, computed from the model's price per token | `'hour'`, `'day'`, `'month'` (default), or ms |
| `tokens` | Input + output tokens; `estimateTokens` is checked *before* the call | same |
| `requests` | Model calls | same |
| `rate` | Short-term burst control: `{ requests, perMs }`, sliding window | independent |

Limits are per **principal** - a user id, team, or API key - and can be a constant or a resolver (sync or async), so plan tiers are one function:

```ts
limits: async (userId) => (await db.plan(userId)) === 'pro' ? { usd: 50 } : { usd: 2 }
```

A `Decision` from `check()` / `summary()` reports `used`, `limit`, `remaining`, and `resetsAt` for every metric plus `warnings` at 80% (configurable) - what a usage meter in your UI needs.

## Pricing

A built-in table covers current OpenAI and Anthropic models (list prices per 1M tokens, dated in the source). Prices change, so override or extend it:

```ts
new Budget({ store, limits, prices: { 'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 }, 'my-finetune': { input: 3, output: 12 } } });
```

Dated snapshots and provider prefixes resolve automatically (`openai/gpt-4o-2024-11-20` → `gpt-4o`). Cached prompt tokens are billed at the cached rate. Unknown models record at $0 by default; set `unknownModel: 'throw'` to refuse them.

## Shared storage

Budgets only work if every instance sees the same counters. Bring your own database client:

```ts
import { Pool } from 'pg';
import { Budget, SqlStore, sqlStoreSchema } from 'llm-budget';

const pool = new Pool();
await pool.query(sqlStoreSchema()); // one table, run once as a migration
const budget = new Budget({ store: new SqlStore((sql, params) => pool.query(sql, params)), limits });
```

`SqlStore` uses one atomic upsert per increment (PostgreSQL syntax). Any store is a two-method interface - `get(key)` and `increment(key, by, ttlMs)` - so Redis or DynamoDB adapters are a few lines.

## Middleware

```ts
import { budgetMiddleware } from 'llm-budget';

app.post('/api/generate', budgetMiddleware(budget, { principal: (req) => req.user?.id }), async (req, res) => {
  const result = await openai.chat.completions.create(...);
  await budget.record(req.user.id, fromOpenAI(result)!);
  res.json(result);
});
```

Over budget → `429` with `{ error, reason, resetsAt }` and a `Retry-After` header; near a limit → `X-Budget-Warning`. The decision is available as `req.budget`.

## Circuit breaker

```ts
import { CircuitBreaker } from 'llm-budget';

const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, shouldTrip: (e) => e.status >= 500 });
const result = await budget.guard(userId, () => breaker.run(() => openai.chat.completions.create(...)));
```

After the threshold of consecutive provider failures the circuit opens and calls fail fast with `CircuitOpenError` until the cooldown passes; one trial call then decides whether it closes.

## Performance

`npm run bench` - 10,000 principals, 200,000 check+record cycles on `MemoryStore` (Apple silicon, Node 20): **~208,000 cycles/s (4.8 µs each)**, 410,000 summary reads/s. With `SqlStore` the cost is one round trip per counter; run checks in parallel where latency matters.

## API

| Export | Description |
|---|---|
| `new Budget(options)` | `check(principal, estimateTokens?)`, `record(principal, usage)`, `guard(principal, fn, options?)`, `summary(principal)` |
| `MemoryStore`, `SqlStore`, `sqlStoreSchema()` | Stores; implement `BudgetStore` for others |
| `budgetMiddleware(budget, options)` | Express-compatible 429 guard |
| `CircuitBreaker` | Fail-fast wrapper for provider calls |
| `fromOpenAI(res)`, `fromAnthropic(res)`, `detectUsage(res)` | Usage extractors (`Usage` = `{ model, inputTokens, outputTokens, cachedInputTokens? }`) |
| `costOf(usage, prices)`, `resolvePrice(model, prices)`, `DEFAULT_PRICES` | Pricing helpers |
| `BudgetExceededError`, `UnknownModelError`, `CircuitOpenError` | Typed errors with `reason` / `decision` / `retryAt` |

Streaming: enable `stream_options: { include_usage: true }` (OpenAI) and pass the final chunk, or Anthropic's `message_delta` usage, to `record()`.

## Alternatives

- [llm-meter](https://www.npmjs.com/package/llm-meter) - token tracking, cost management, and caching for a single process. llm-budget focuses on multi-tenant enforcement: per-principal plans, shared stores across instances, middleware, and a circuit breaker; no caching.
- [llm-limiter](https://www.npmjs.com/package/llm-limiter) - protects you from the *provider's* RPM/TPM limits with token-aware reservation. Complementary: llm-limiter keeps you under OpenAI's ceiling, llm-budget keeps each of your users under yours.

## Roadmap

- Redis store adapter
- Usage export for billing (`usageSince(principal, from)`)
- Streaming helpers that meter as chunks arrive

## License

MIT (c) Muzaffar Qosimov
