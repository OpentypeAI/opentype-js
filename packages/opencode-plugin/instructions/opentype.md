# OpenType tools

You have OpenType tools backed by Neon 1.1. Use them instead of guessing.

- Before picking a model for a sub-task, or when the user asks which LLM to use, call `opentype_route_model` with the task and a policy: `balanced` (default), `cost_efficient` (cheapest that can handle it), `capability_heavy` (most capable, cost aside) or `domain_skills` (a specialist). Add `task_type` (skip classification), `latency` (`interactive` when a user waits, `batch` offline), `max_latency_ms`, `weights` {quality, cost, speed} (balanced only) or `models` filters only when asked. Report the pick, the task type, its estimated cost and latency for this request, its top strengths, and the top of the ranking; on `low_confidence`, retry with an explicit `task_type`.
- For any yes/no, pick-one or rating judgment you would otherwise eyeball (triage, classification, which branch to take), call `opentype_decide` and act on the probability: act at 0.8 or above, ask the user between 0.5 and 0.8.
- For a pass/fail gate or a structured extraction that must match a JSON Schema, use `opentype_decide` for now: verdict runs are not served yet (`503 no_route_available`), so do not call `opentype_verdict`. Ask the gate as one `noul` question (pass at 0.8 or above) and split an extraction into `choice`/`score` questions. With no valid judgment, fail closed.
- `opentype_get_run` fetches a pending run; `opentype_usage` shows spend and quota; `opentype_list_models` lists the catalog (with `task_types: true`, the task types).
- decide, verdict and route spend credit. Batch questions about one input into one call, and when a paid call fails, retry with the `idempotency_key` its error names, so the retry replays instead of paying again.
- Never print the value of `OPENTYPE_API_KEY`.
