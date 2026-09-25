import type Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionTool, ChatCompletionToolMessageParam } from "openai/resources/chat/completions";
import type { FunctionTool } from "openai/resources/responses/responses";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { openTypeTools as anthropicTools } from "../src/tools/anthropic.js";
import { getTool, runTool, summarizeAnswer, summarizeRoute, tools } from "../src/tools/index.js";
import { routeResponse, taskTypes } from "./fixtures/route.js";
import { openTypeTools as openaiTools } from "../src/tools/openai.js";
import { openTypeTools as vercelTools, zodInputSchema } from "../src/tools/vercel.js";
import { BASE, client, run, server, useServer } from "./helpers.js";

useServer();

const NAMES = [
  "opentype_decide",
  "opentype_verdict",
  "opentype_route_model",
  "opentype_list_models",
  "opentype_get_run",
  "opentype_usage",
];

const catalog = {
  as_of: "2026-09-01",
  models: [
    { id: "a", name: "A", provider: "p1", open_weights: true, domains: ["coding"], price_input_per_mtok: 1, price_output_per_mtok: 2, context_tokens: 1000 },
    { id: "b", name: "B", provider: "p2", open_weights: false, domains: ["math"], price_input_per_mtok: 3, price_output_per_mtok: 4, context_tokens: 2000 },
  ],
};

describe("shared tool list", () => {
  it("has the six tools with snake_case args", () => {
    expect(tools.map((t) => t.name)).toEqual(NAMES);
    for (const t of tools) {
      const props = Object.keys((t.inputSchema.properties ?? {}) as object);
      for (const p of props) expect(p).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description).toMatch(/Use it (WHEN|BEFORE)/);
    }
  });

  it("marks read-only tools", () => {
    const ro = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(ro).toEqual(["opentype_list_models", "opentype_get_run", "opentype_usage"]);
  });

  it("summarizes each answer type", () => {
    expect(summarizeAnswer("u", { type: "noul", probability: 0.25 })).toBe("u: P(yes) = 25.0%");
    expect(summarizeAnswer("t", { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 })).toBe("t: b (b 90.0%, a 10.0%)");
    expect(
      summarizeAnswer("s", { type: "score", score: 1, legend: { "0": "lo", "1": "hi" }, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.7 }),
    ).toBe("s: hi (score 1; lo 30.0%, hi 70.0%)");
  });

  it("list_models filters client-side", async () => {
    server.use(http.get(`${BASE}/v1/router/models`, () => HttpResponse.json(catalog)));
    const r = await getTool("opentype_list_models")!.execute(client(), { open_weights: true });
    expect((r.data as typeof catalog).models.map((m) => m.id)).toEqual(["a"]);
    expect(r.text).toMatch(/^1 models/);
  });

  it("list_models lists task types on request", async () => {
    server.use(http.get(`${BASE}/v1/router/task-types`, () => HttpResponse.json(taskTypes)));
    const r = await getTool("opentype_list_models")!.execute(client(), { task_types: true });
    expect(r.text).toMatch(/^1 task types/);
    expect(r.text).toContain("code_generation (coding): Write new code from a spec. [SWE-bench Verified 40.0%]");
  });

  it("route_model sends the knobs and summarizes v2", async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/v1/router/select`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(routeResponse);
      }),
    );
    const r = await runTool(() => client(), "opentype_route_model", {
      prompt: "p",
      task_type: "code_generation",
      latency: "batch",
      max_latency_ms: 30000,
      weights: { quality: 1 },
    });
    expect(r.isError).toBe(false);
    expect(body).toMatchObject({ task_type: "code_generation", latency: "batch", max_latency_ms: 30000, weights: { quality: 1 } });
  });

  it("summarizes a route", () => {
    expect(summarizeRoute(routeResponse)).toBe(
      [
        "Use m1 (Model One, p1). Best balance of quality, cost and latency for code generation.",
        "Task type: code_generation (coding, 72.0%; also code_review 15.0%). Difficulty: standard. Policy: balanced.",
        "Pick: quality 0.82, est. $0.0042, ~6.3 s.",
        "Strengths: SWE-bench Verified, LiveCodeBench.",
        "Weaknesses: Aider Polyglot.",
        "Top: m1 (q 0.82, $0.0042, 6.3 s)",
      ].join("\n"),
    );
  });

  it("route_model needs exactly one of prompt/messages", async () => {
    const r = await runTool(() => client(), "opentype_route_model", {});
    expect(r.isError).toBe(true);
  });

  it("usage defaults to a 30-day window and adds quota", async () => {
    let q: URLSearchParams | undefined;
    server.use(
      http.get(`${BASE}/v1/usage`, ({ request }) => {
        q = new URL(request.url).searchParams;
        return HttpResponse.json({ runs: { total: 1 }, tokens: {}, spend: {} });
      }),
      http.get(`${BASE}/v1/quota`, () => HttpResponse.json({ limits: {} })),
    );
    const r = await runTool(() => client(), "opentype_usage", { include_quota: true });
    expect(r.isError).toBe(false);
    const days = (Date.parse(q!.get("end_at")!) - Date.parse(q!.get("start_at")!)) / 86_400_000;
    expect(days).toBe(30);
    expect(r.data).toHaveProperty("quota");
  });

  it("API errors become text with the code and request id", async () => {
    server.use(http.get(`${BASE}/v1/runs/run_x`, () => HttpResponse.json({ error: { code: "scope_denied", message: "no", request_id: "req_9" } }, { status: 403 })));
    const r = await runTool(() => client(), "opentype_get_run", { run_id: "run_x" });
    expect(r).toMatchObject({ isError: true, text: "scope_denied: no (request req_9)" });
  });
});

describe("openai adapter", () => {
  it("renders Chat Completions and Responses definitions", () => {
    const t = openaiTools(client());
    const chat: ChatCompletionTool[] = t.definitions;
    const resp: FunctionTool[] = t.responsesDefinitions;
    expect(chat.map((d) => (d as { function: { name: string } }).function.name)).toEqual(NAMES);
    expect(resp.map((d) => d.name)).toEqual(NAMES);
  });

  it("handles a tool call", async () => {
    server.use(http.get(`${BASE}/v1/runs/run_1`, () => HttpResponse.json(run({ decision: { answers: { u: { type: "noul", probability: 0.5 } }, draws: 1, read: "slot_constrained" } }))));
    const msg: ChatCompletionToolMessageParam = await openaiTools(client()).handle({
      id: "call_1",
      type: "function",
      function: { name: "opentype_get_run", arguments: '{"run_id":"run_1"}' },
    });
    expect(msg).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(msg.content).toContain("u: P(yes) = 50.0%");
    const out = await openaiTools(client()).handleResponse({ type: "function_call", call_id: "c2", name: "opentype_get_run", arguments: '{"run_id":"run_1"}' });
    expect(out).toMatchObject({ type: "function_call_output", call_id: "c2" });
  });

  it("does not need a key to list definitions", () => {
    vi.stubEnv("OPENTYPE_API_KEY", "");
    expect(openaiTools().definitions).toHaveLength(6);
    vi.unstubAllEnvs();
  });
});

describe("anthropic adapter", () => {
  it("renders Tool definitions and handles tool_use", async () => {
    const t = anthropicTools(client());
    const defs: Anthropic.Tool[] = t.definitions;
    expect(defs.map((d) => d.name)).toEqual(NAMES);
    expect(defs[0]!.input_schema.type).toBe("object");
    server.use(http.post(`${BASE}/v1/runs`, () => HttpResponse.json(run({ decision: { answers: { u: { type: "noul", probability: 0.8 } }, draws: 1, read: "slot_constrained" } }))));
    const res: Anthropic.ToolResultBlockParam = await t.handle({
      type: "tool_use",
      id: "tu_1",
      name: "opentype_decide",
      input: { state: "x", questions: { u: { type: "noul", instructions: "?" } } },
    });
    expect(res).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(res.content).toContain("P(yes) = 80.0%");
  });

  it("flags errors", async () => {
    const res = await anthropicTools(client()).handle({ type: "tool_use", id: "tu", name: "nope", input: {} });
    expect(res.is_error).toBe(true);
  });
});

describe("vercel adapter", () => {
  it("builds ai tools with zod schemas that validate", async () => {
    const t = vercelTools(client());
    expect(Object.keys(t)).toEqual(NAMES);
    const z = zodInputSchema("opentype_get_run");
    expect(z.safeParse({ run_id: "run_1" }).success).toBe(true);
    expect(z.safeParse({}).success).toBe(false);
    expect(zodInputSchema("opentype_decide").safeParse({ state: "s", questions: { a: { type: "noul", instructions: "?" } } }).success).toBe(true);
  });

  it("executes", async () => {
    server.use(http.get(`${BASE}/v1/runs/run_1`, () => HttpResponse.json(run({ kind: "verdict", verdict: { ok: 1 } }))));
    const t = vercelTools(client());
    const out = await t.opentype_get_run.execute!({ run_id: "run_1" }, { toolCallId: "c", messages: [] } as never);
    expect(out).toMatchObject({ result: { run_id: "run_1" } });
  });
});
