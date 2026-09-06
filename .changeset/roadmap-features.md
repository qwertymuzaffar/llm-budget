---
"llm-budget": minor
---

New: RedisStore (node-redis and ioredis clients), reservations (`reserve` / `settle` / `release`, and `guard({ reserve })`) so concurrent calls cannot collectively overshoot a limit, an `onRecord` ledger hook for billing, and streaming support (`budget.meter(principal, stream)`, `meterStream`, `StreamUsageTracker`) that meters OpenAI and Anthropic streams when they complete.
