import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthenticationError, type OpenType } from "@opentype/sdk";
import { describe, expect, it, vi } from "vitest";
import { createServer, MISSING_KEY_MESSAGE, type ServerOptions } from "../src/index.js";
import { routeResponse, taskTypes } from "../../sdk/test/fixtures/route.js";

async function connect(opts: ServerOptions) {
  const server = createServer(opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const decision = {
  run_id: "run_1",
  kind: "decision",
  state: "completed",
  input_digest: "x",
  replayed: false,
  decision: { answers: { urgent: { type: "noul", probability: 0.93 } }, draws: 1, read: "slot_constrained", model: "neon-1.1" },
};

function mockSdk() {
  const create = vi.fn(async () => decision);
  const sdk = {
    _core: {},
    runs: { get: vi.fn(async () => decision), create },
    decide: vi.fn(async () => ({ runId: "run_1", answers: decision.decision.answers, run: decision, replayed: false })),
    verdict: vi.fn(async () => ({ runId: "run_2", verdict: { order: 4822 }, run: { run_id: "run_2" }, replayed: false })),
    route: vi.fn(async () => routeResponse),
    router: { models: vi.fn(async () => ({ as_of: "2026-09-01", models: [] })), taskTypes: vi.fn(async () => taskTypes) },
    usage: {
      summary: vi.fn(async () => ({ organization_id: "org", runs: { total: 2 }, tokens: {}, spend: {} })),
      quota: vi.fn(async () => ({ organization_id: "org" })),
    },
  };
  return sdk;
}

describe("opentype MCP server", () => {
  it("lists the six tools (snapshot)", async () => {
    const client = await connect({ env: {} });
    const { tools } = await client.listTools();
    expect(tools.map((t) => ({ name: t.name, annotations: t.annotations, inputSchema: t.inputSchema }))).toMatchSnapshot();
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(80);
  });

  it("reports a missing key clearly at call time", async () => {
    const client = await connect({ env: {} });
    const r = await client.callTool({ name: "opentype_get_run", arguments: { run_id: "run_1" } });
    expect(r.isError).toBe(true);
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("OPENTYPE_API_KEY");
    expect(text).toContain("https://console.opentype.dev/keys");
    expect(text).toContain(MISSING_KEY_MESSAGE);
  });

  it("opentype_decide maps snake_case args and returns structured content", async () => {
    const sdk = mockSdk();
    const client = await connect({ client: sdk as unknown as OpenType });
    const r = await client.callTool({
      name: "opentype_decide",
      arguments: { state: "refund or dispute", questions: { urgent: { type: "noul", instructions: "urgent?" } }, draws: 2, idempotency_key: "k" },
    });
    expect(sdk.decide).toHaveBeenCalledWith(
      expect.objectContaining({ state: "refund or dispute", draws: 2, idempotencyKey: "k", questions: { urgent: { type: "noul", instructions: "urgent?" } } }),
    );
    expect((r.content as Array<{ text: string }>)[0]!.text).toContain("urgent: P(yes) = 93.0%");
    expect(r.structuredContent).toMatchObject({ run_id: "run_1" });
  });

  it("opentype_verdict", async () => {
    const sdk = mockSdk();
    const client = await connect({ client: sdk as unknown as OpenType });
    const r = await client.callTool({
      name: "opentype_verdict",
      arguments: { messages: [{ role: "user", content: "Order 4822" }], schema: { type: "object" }, max_output_tokens: 32 },
    });
    expect(sdk.verdict).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 32, schema: { type: "object" } }));
    expect((r.content as Array<{ text: string }>)[0]!.text).toContain('{"order":4822}');
  });

  it("opentype_route_model", async () => {
    const sdk = mockSdk();
    const client = await connect({ client: sdk as unknown as OpenType });
    const r = await client.callTool({
      name: "opentype_route_model",
      arguments: { prompt: "refactor", policy: "balanced", task_type: "code_generation", latency: "interactive", max_latency_ms: 20000, weights: { quality: 1 } },
    });
    expect(sdk.route).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "refactor", policy: "balanced", taskType: "code_generation", latency: "interactive", maxLatencyMs: 20000, weights: { quality: 1 } }),
    );
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/^Use m1/);
    expect(text).toContain("Task type: code_generation");
    expect(text).toContain("est. $0.0042, ~6.3 s");
    expect(text).toContain("Strengths: SWE-bench Verified");
  });

  it("opentype_list_models, opentype_get_run, opentype_usage", async () => {
    const sdk = mockSdk();
    const client = await connect({ client: sdk as unknown as OpenType });
    await client.callTool({ name: "opentype_list_models", arguments: {} });
    expect(sdk.router.models).toHaveBeenCalled();
    const t = await client.callTool({ name: "opentype_list_models", arguments: { task_types: true } });
    expect(sdk.router.taskTypes).toHaveBeenCalled();
    expect((t.content as Array<{ text: string }>)[0]!.text).toMatch(/^1 task types/);
    const g = await client.callTool({ name: "opentype_get_run", arguments: { run_id: "run_1" } });
    expect(sdk.runs.get).toHaveBeenCalledWith("run_1");
    expect((g.content as Array<{ text: string }>)[0]!.text).toContain("run_1 decision completed");
    const u = await client.callTool({ name: "opentype_usage", arguments: { include_quota: true } });
    expect(sdk.usage.quota).toHaveBeenCalled();
    expect(u.structuredContent).toHaveProperty("quota");
  });

  it("surfaces API errors as tool errors", async () => {
    const sdk = mockSdk();
    sdk.runs.get.mockRejectedValueOnce(new AuthenticationError({ status: 401, code: "invalid_credential", message: "bad key", requestId: "req_1" }));
    const client = await connect({ client: sdk as unknown as OpenType });
    const r = await client.callTool({ name: "opentype_get_run", arguments: { run_id: "run_1" } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]!.text).toBe("invalid_credential: bad key (request req_1)");
  });
});
