---
'llm-budget': patch
---

Resolve prices by the full model id before dropping the provider prefix. A price table keyed by a prefixed id such as `openai/gpt-oss-120b` was never matched, so calls to that model were silently recorded at $0 (or rejected under `unknownModel: 'throw'`). A provider-specific key now also wins over a bare one for the same model.
