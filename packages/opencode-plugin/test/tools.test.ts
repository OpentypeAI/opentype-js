import { test } from "node:test"
import assert from "node:assert/strict"
import { OpenTypePlugin, createTools } from "../src/index.ts"

const NAMES = ["opentype_decide", "opentype_verdict", "opentype_route_model", "opentype_list_models", "opentype_get_run", "opentype_usage"]

test("plugin registers the six tools without a key", async () => {
  delete process.env.OPENTYPE_API_KEY
  const hooks = await OpenTypePlugin({} as any)
  assert.deepEqual(Object.keys(hooks.tool!).sort(), [...NAMES].sort())
  for (const t of Object.values(hooks.tool!)) {
    assert.ok(t.description.length > 20)
    assert.equal(typeof t.execute, "function")
  }
})

test("missing key fails at call time with a clear message", async () => {
  delete process.env.OPENTYPE_API_KEY
  const tools = createTools()
  await assert.rejects(tools.opentype_get_run.execute({ run_id: "run_1" }, {} as any), /OPENTYPE_API_KEY is not set/)
})

test("decide posts a decision run with auth and idempotency headers", async () => {
  let seen: any
  const fake = (async (url: string, init: any) => {
    seen = { url, init }
    return new Response(JSON.stringify({ id: "run_1", status: "succeeded" }), { status: 200 })
  }) as any
  const tools = createTools({ apiKey: "otsk_test", baseUrl: "https://x/" }, fake)
  const r: any = await tools.opentype_decide.execute(
    { state: "s", questions: { q: { type: "noul", instructions: "yes?" } }, idempotency_key: "k1" },
    {} as any,
  )
  assert.equal(seen.url, "https://x/v1/runs")
  assert.equal(seen.init.headers.Authorization, "Bearer otsk_test")
  assert.equal(seen.init.headers["Idempotency-Key"], "k1")
  assert.equal(JSON.parse(seen.init.body).kind, "decision")
  assert.match(r.output, /run_1/)
})

test("API errors surface code and request id", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ error: { code: "scope_denied", message: "no usage_read", request_id: "req_9" } }), { status: 403 })) as any
  const tools = createTools({ apiKey: "otsk_test" }, fake)
  await assert.rejects(tools.opentype_usage.execute({}, {} as any), /403 scope_denied: no usage_read \(request req_9\)/)
})

test("route requires exactly one of prompt or messages", async () => {
  const tools = createTools({ apiKey: "otsk_test" }, (async () => new Response("{}")) as any)
  await assert.rejects(tools.opentype_route_model.execute({}, {} as any), /exactly one/)
})

test("route forwards v2 knobs and summarizes task type, pick, estimates and strengths", async () => {
  let body: any
  const resp = {
    policy: "balanced",
    model: { id: "m1", name: "Model One", provider: "acme", open_weights: true },
    classification: { task_type: { label: "code_generation", family: "coding", top: [{ task_type: "code_generation", family: "coding", probability: 0.82 }], fixed: false } },
    ranking: [{ id: "m1", estimated_cost_usd: 0.0123, estimated_latency_ms: 4200.4, latency_estimated: false, expected_quality: 0.91, strengths: [{ benchmark: "swe", name: "SWE-bench Verified" }, { benchmark: "lcb", name: "LiveCodeBench" }] }],
    low_confidence: false,
  }
  const fake = (async (_u: string, init: any) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify(resp))
  }) as any
  const tools = createTools({ apiKey: "otsk_test" }, fake)
  const args = { prompt: "write a parser", task_type: "code_generation", latency: "interactive", max_latency_ms: 8000, weights: { quality: 0.7, cost: 0.2, speed: 0.1 } }
  const r: any = await tools.opentype_route_model.execute(args as any, {} as any)
  assert.deepEqual(body, args)
  assert.equal(r.title, "route: m1")
  assert.match(r.output, /task_type: code_generation \(coding\), 82%/)
  assert.match(r.output, /pick: Model One \(acme, open weights\), policy balanced/)
  assert.match(r.output, /estimate: \$0\.0123, 4200 ms, quality 0\.91/)
  assert.match(r.output, /strengths: SWE-bench Verified, LiveCodeBench/)
})

test("route rejects weights with a non-balanced policy", async () => {
  const tools = createTools({ apiKey: "otsk_test" }, (async () => new Response("{}")) as any)
  await assert.rejects(
    tools.opentype_route_model.execute({ prompt: "x", policy: "cost_efficient", weights: { quality: 1 } } as any, {} as any),
    /requires policy `balanced`/,
  )
})

test("list_models task_types=true reads the taxonomy", async () => {
  let url = ""
  const fake = (async (u: string) => {
    url = u
    return new Response(JSON.stringify({ families: ["coding"], task_types: [{ id: "code_generation" }] }))
  }) as any
  const r: any = await createTools({ apiKey: "otsk_test", baseUrl: "https://x" }, fake).opentype_list_models.execute({ task_types: true }, {} as any)
  assert.equal(url, "https://x/v1/router/task-types")
  assert.equal(r.title, "1 task types")
})

test("a paid call without a key sends the same derived key on a retry", async () => {
  const keys: string[] = []
  const fake = (async (_u: string, init: any) => {
    keys.push(init.headers["Idempotency-Key"])
    return new Response(JSON.stringify({ id: "run_1" }))
  }) as any
  const tools = createTools({ apiKey: "otsk_test" }, fake)
  const args = { state: "s", questions: { q: { type: "noul", instructions: "yes?" } } }
  await tools.opentype_decide.execute(args as any, {} as any)
  await tools.opentype_decide.execute(args as any, {} as any)
  await tools.opentype_decide.execute({ ...args, state: "other" } as any, {} as any)
  await tools.opentype_route_model.execute({ prompt: "x" } as any, {} as any)
  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[0], keys[2])
  assert.match(keys[3]!, /^oc-/)
})

test("refuses a plain-http base URL except for localhost", () => {
  assert.throws(() => createTools({ apiKey: "otsk_test", baseUrl: "http://api.example.com" }), /must use https/)
  createTools({ apiKey: "otsk_test", baseUrl: "http://localhost:8080" })
})

test("a network failure is an actionable error carrying the replay key", async () => {
  const fake = (async () => {
    throw new TypeError("fetch failed")
  }) as any
  const tools = createTools({ apiKey: "otsk_test" }, fake)
  await assert.rejects(
    tools.opentype_decide.execute({ state: "s", questions: {}, idempotency_key: "k7" } as any, {} as any),
    (e: any) => /unreachable: fetch failed/.test(e.message) && /"k7"/.test(e.message) && e.cause instanceof TypeError,
  )
})

test("a stalled request is cut off at the deadline", async () => {
  const fake = ((_u: string, init: any) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))) as any
  const tools = createTools({ apiKey: "otsk_test", timeoutMs: 30 }, fake)
  await assert.rejects(tools.opentype_get_run.execute({ run_id: "run_1" }, {} as any), /did not answer within 30 ms/)
})
