# @opentype/sdk

TypeScript client for the [OpenType](https://opentype.dev) API: calibrated decisions, schema-validated verdicts and model routing, served by Neon 1.1.

- ESM and CommonJS, full types generated from the OpenAPI contract
- Zero runtime dependencies; Node 18+, Deno, Bun, edge workers and other `fetch` runtimes
- Automatic idempotency keys, safe retries, typed errors
- Agent tool adapters for the AI SDK, OpenAI and Anthropic

## Install

Not on npm yet. Until the first release, build and pack it from
[OpentypeAI/opentype-js](https://github.com/OpentypeAI/opentype-js#install) and install the tarball.
After the release:

```sh
npm install @opentype/sdk
```

## Quickstart

Create a key at https://console.opentype.dev/keys and export it:

```sh
export OPENTYPE_API_KEY=otsk_...
```

```ts
import { OpenType } from "@opentype/sdk";

const ot = new OpenType(); // reads OPENTYPE_API_KEY (and OPENTYPE_BASE_URL)

const d = await ot.decide({
  prompt: "Refund me today or I dispute the charge.",
  question: "Is the customer threatening to escalate?",
});
if (d.answer?.type === "noul" && d.answer.probability > 0.8) escalate();
```

### Options

```ts
new OpenType({
  apiKey,          // default: process.env.OPENTYPE_API_KEY
  baseURL,         // default: process.env.OPENTYPE_BASE_URL ?? "https://api.opentype.dev"
  timeout,         // per attempt, ms; default 170_000 (above the 150 s max decision deadline)
  maxRetries,      // default 2
  fetch,           // custom fetch
  defaultHeaders,
  retryStatuses,   // opt in to retrying a 4xx, e.g. [429]
});
```

## decide

A decision returns a probability for every alternative of every question, in one model call.

```ts
// Shorthand: one question, id "answer"
const pick = await ot.decide({
  prompt: ticketText,
  question: "Which team owns this ticket?",
  choices: ["billing", "shipping", "technical"],
});
// pick.answer => { type: "choice", choice: "billing", probabilities: { billing: 0.81, ... }, confidence: 0.81 }

// Full form: several questions, conditional stages, several draws
const d = await ot.decide({
  state: { ticket: ticketText, plan: "pro" },
  questions: {
    urgent: { type: "noul", instructions: "Must we reply within the hour?" },
    mood: { type: "score", instructions: "How upset is the customer?", criteria: ["calm", "annoyed", "furious"] },
    page: { type: "noul", instructions: "Page the on-call?", depends_on: ["urgent"], ask_if: { urgent: ["yes"] } },
  },
  draws: 3,
  model: "neon-1.1",
  idempotencyKey: `triage:${ticketId}`,
});
for (const [id, a] of Object.entries(d.answers)) console.log(id, a);
```

`noul` answers carry `probability` = P(yes); `choice` answers are keyed by option name; `score` answers are 0-indexed with a `legend`; a question whose condition failed is `{ type: "skipped" }`.

## verdict

One JSON document, validated against your schema before it is returned.

```ts
const v = await ot.verdict<{ order: number; city: string }>({
  prompt: "Order #4822: two lamps, shipped to Lyon.",
  schema: {
    type: "object",
    properties: { order: { type: "integer" }, city: { type: "string" } },
    required: ["order", "city"],
  },
  maxOutputTokens: 128,
});
v.verdict.city; // "Lyon"
```

## runs, stream and pagination

```ts
const run = await ot.runs.create({ kind: "decision", state, questions, max_output_tokens: 16 });
const again = await ot.runs.get(run.run_id);

for await (const event of ot.runs.stream(run.run_id)) {
  if (event.event === "state") console.log(event.data.state);
  if (event.event === "terminal") console.log(event.data.decision ?? event.data.verdict);
}

const firstPage = await ot.runs.list({ limit: 50 });   // one page
for await (const r of ot.runs.list({ limit: 50 })) {   // every run, page by page
  console.log(r.run_id, r.state);
}
```

## route

Which model should handle a task. The router classifies the task into a task type (top 5 with probabilities) and facets (difficulty, expected output length, tools, vision, language), then ranks catalog models on that task type's benchmark mix, with an estimated cost and latency for this very request. Selection only: OpenType does not proxy the call.

```ts
const r = await ot.route({
  prompt: "Refactor this 2,000-line Rust module into smaller crates.",
  policy: "balanced",          // balanced | cost_efficient | capability_heavy | domain_skills
  latency: "interactive",      // interactive | standard (default) | batch: how much latency weighs in balanced
  maxLatencyMs: 30_000,        // drop models slower than this, or with unmeasured speed
  weights: { quality: 0.6, cost: 0.3, speed: 0.1 }, // balanced only; otherwise 400 weights_require_balanced
  // taskType: "code_generation", // skip classification (ids from router.taskTypes()); wins over v1 `domain`
  models: { open_weights: true, min_context_tokens: 128_000 },
});

const pick = r.ranking[0];
console.log(r.model.id, r.classification.task_type.label, r.reason);
console.log(pick.expected_quality, pick.estimated_cost_usd, pick.estimated_latency_ms);
console.log(pick.strengths.map((b) => b.name), pick.weaknesses.map((b) => b.name));
```

Reading the response:

- `expected_quality` is the weighted, normalized benchmark score for this task type (0-1); `uncertainty` is how much of it rests on imputed values (listed in `imputed`).
- `estimated_cost_usd` covers input, expected output, reasoning tokens and expected turns; `estimated_latency_ms` is time to the full answer (`latency_estimated` when a catalog median stood in).
- `strengths` are the three benchmarks contributing most; `weaknesses` the (up to two) where it trails the best candidate, with `gap_to_best`.
- `threshold` (`balanced`, `cost_efficient`) is the quality bar: `tau = r × q_star`. `filters_applied` counts what each filter removed. `low_confidence` flags a `domain_skills` pick whose top task type is under 40%.

```ts
const types = await ot.router.taskTypes(); // task types, families, and each one's benchmark weights
const catalog = await ot.router.models();
```

### Long context

Decisions accept up to 262,144 input tokens and request bodies up to 4 MiB. A decision's deadline defaults to 30 s plus 120 s per 256k input tokens, capped at 150 s, so the default `timeout` is 170 s. `POST /v1/runs` responses carry a `Server-Timing` header (`admit`, `upstream`, `gateway`, `total`, in ms).

## Other resources

```ts
await ot.usage.summary({ startAt: "2026-09-01T00:00:00Z", endAt: "2026-10-01T00:00:00Z" });
await ot.usage.daily({ startAt, endAt });
await ot.usage.ledger({ startAt, endAt, limit: 100 });
await ot.usage.run(runId);
await ot.usage.quota();

await ot.billing.get();
await ot.billing.setAutoRecharge({ enabled: true, threshold_micros: 5_000_000, amount_micros: 20_000_000 });
await ot.billing.checkout({ amount_micros: 10_000_000 }); // { url }
await ot.billing.portal();                                 // { url }

await ot.keys.list();
await ot.keys.get(keyId);
await ot.keys.rotate(keyId); // returns the new secret, once
await ot.keys.revoke(keyId);
```

Every response has a non-enumerable `_requestId` (the `x-request-id` header).

## Retries and idempotency

- Every paid call (`runs.create`, and so `decide` and `verdict`, plus `router.select` and `route`) sends an `Idempotency-Key`: yours if you pass `idempotencyKey`, else a random UUID made once per call.
- No response (network error or timeout): retried with the **same** key, so the retry replays the stored run instead of paying for a second one.
- A `5xx` on a paid call is **not** retried: the call behind it may already have been charged. The error carries the `requestId`; send the request again with a new key if you want a new attempt. Reads (`GET`) are retried on `5xx`.
- `runs.waitFor` throws `TimeoutError` with code `wait_timeout` when the run is not finished within `timeout`; each poll is bounded by the time left.
- Exponential backoff (1 s, 2 s, 4 s, ...) with full jitter; a `Retry-After` header wins.
- `4xx`, including `402` and `429`, is never retried unless you list it in `retryStatuses`.
- A `202` replay (a run under that key is still `pending`) throws `RunPendingError` with the run in `error.run`: retry with a new key, or read it later with `runs.get`.

## Errors

```ts
import { InsufficientCreditsError, OpenTypeError, RateLimitError } from "@opentype/sdk";

try {
  await ot.decide({ ... });
} catch (e) {
  if (e instanceof InsufficientCreditsError) topUp();
  else if (e instanceof OpenTypeError) console.error(e.status, e.code, e.requestId, e.violations);
  else throw e;
}
```

| Class | Status |
| --- | --- |
| `InvalidRequestError` | 400, 413, 422 |
| `AuthenticationError` | 401 |
| `InsufficientCreditsError` | 402 |
| `PermissionDeniedError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `RateLimitError` (`retryAfter`) | 429 (quota) |
| `ServerError` | 5xx |
| `APIConnectionError`, `TimeoutError` | no response |
| `RunPendingError` | 202 pending replay |

Each carries `status`, `code`, `message`, `requestId` and `violations`. Branch on `code` (e.g. `insufficient_credits`, `idempotency_conflict`, `verdict_schema_violation`), never on `message`. A plain-text body maps to `http_<status>`.

## Agent tools

The same six tools as the [`@opentype/mcp`](../mcp) server: `opentype_decide`, `opentype_verdict`, `opentype_route_model`, `opentype_list_models`, `opentype_get_run`, `opentype_usage`. Install only the framework you use; they are optional peer dependencies.

```ts
// AI SDK (ai + zod >= 4.2)
import { generateText } from "ai";
import { openTypeTools } from "@opentype/sdk/tools/vercel";
await generateText({ model, prompt, tools: openTypeTools() });

// OpenAI
import { openTypeTools } from "@opentype/sdk/tools/openai";
const ot = openTypeTools();
const res = await openai.chat.completions.create({ model, messages, tools: ot.definitions });
for (const call of res.choices[0].message.tool_calls ?? []) messages.push(await ot.handle(call));
// Responses API: ot.responsesDefinitions + ot.handleResponse(item)

// Anthropic
import { openTypeTools } from "@opentype/sdk/tools/anthropic";
const at = openTypeTools();
const msg = await anthropic.messages.create({ model, max_tokens: 1024, messages, tools: at.definitions });
const results = await Promise.all(msg.content.filter((b) => b.type === "tool_use").map(at.handle));
```

Each factory takes an optional `OpenType` instance or client options.

## Development

```sh
pnpm --filter @opentype/sdk generate   # types from ../../openapi.json
pnpm --filter @opentype/sdk build
pnpm --filter @opentype/sdk test
OPENTYPE_E2E=1 OPENTYPE_API_KEY=otsk_... pnpm --filter @opentype/sdk test test/e2e.test.ts
```
