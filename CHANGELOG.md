# llm-budget

## 0.2.1

### Patch Changes

- 49cad16: Resolve prices by the full model id before dropping the provider prefix. A price table keyed by a prefixed id such as `openai/gpt-oss-120b` was never matched, so calls to that model were silently recorded at $0 (or rejected under `unknownModel: 'throw'`). A provider-specific key now also wins over a bare one for the same model.

## 0.2.0

### Minor Changes

- 7655f73: New: RedisStore (node-redis and ioredis clients), reservations (`reserve` / `settle` / `release`, and `guard({ reserve })`) so concurrent calls cannot collectively overshoot a limit, an `onRecord` ledger hook for billing, and streaming support (`budget.meter(principal, stream)`, `meterStream`, `StreamUsageTracker`) that meters OpenAI and Anthropic streams when they complete.

### Patch Changes

- 13625bb: Expanded README: why per-user budgets, concepts (principal, limits, decision, windows), how the sliding rate limit works, and worked examples for plan tiers, usage meters, team + user budgets, token estimation, streaming, error handling, and testing with an injected clock. Design notes on record-after semantics, floating-point dollars, and failed calls.
