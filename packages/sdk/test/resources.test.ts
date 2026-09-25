import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { parseSSE, type RunEvent } from "../src/index.js";
import { BASE, client, run, server, useServer } from "./helpers.js";

useServer();

type Seen = { method: string; path: string; query: Record<string, string>; body: unknown };

function capture(method: "get" | "post" | "put" | "delete", path: string, reply: unknown = { ok: true }) {
  const seen: Seen[] = [];
  server.use(
    http[method](`${BASE}${path}`, async ({ request }) => {
      const u = new URL(request.url);
      const text = await request.text();
      seen.push({ method: request.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: text ? JSON.parse(text) : undefined });
      return HttpResponse.json(reply as never);
    }),
  );
  return seen;
}

describe("resources hit the right endpoints", () => {
  const ot = client();
  const cases: Array<[string, "get" | "post" | "put" | "delete", string, () => Promise<unknown>, Partial<Seen>?]> = [
    ["runs.get", "get", "/v1/runs/run_9", () => ot.runs.get("run_9")],
    ["usage.summary", "get", "/v1/usage", () => ot.usage.summary({ startAt: "a", endAt: "b" }), { query: { start_at: "a", end_at: "b" } }],
    ["usage.daily", "get", "/v1/usage/daily", () => ot.usage.daily({ startAt: "a" }), { query: { start_at: "a" } }],
    ["usage.ledger", "get", "/v1/usage/ledger", () => ot.usage.ledger({ limit: 5 }), { query: { limit: "5" } }],
    ["usage.run", "get", "/v1/usage/runs/run_9", () => ot.usage.run("run_9")],
    ["usage.quota", "get", "/v1/quota", () => ot.usage.quota()],
    ["billing.get", "get", "/v1/billing", () => ot.billing.get()],
    [
      "billing.setAutoRecharge",
      "put",
      "/v1/billing/auto-recharge",
      () => ot.billing.setAutoRecharge({ enabled: true, threshold_micros: 1, amount_micros: 5_000_000 }),
      { body: { enabled: true, threshold_micros: 1, amount_micros: 5_000_000 } },
    ],
    ["billing.checkout", "post", "/v1/billing/checkout", () => ot.billing.checkout({ amount_micros: 5_000_000 }), { body: { amount_micros: 5_000_000 } }],
    ["billing.portal", "post", "/v1/billing/portal", () => ot.billing.portal()],
    ["keys.list", "get", "/v1/keys", () => ot.keys.list()],
    ["keys.get", "get", "/v1/keys/key_1", () => ot.keys.get("key_1")],
    ["keys.revoke", "delete", "/v1/keys/key_1", () => ot.keys.revoke("key_1")],
    ["keys.rotate", "post", "/v1/keys/key_1/rotate", () => ot.keys.rotate("key_1")],
    ["keys.create", "post", "/v1/keys", () => ot.keys.create({ name: "n", scopes: ["runs_read"] } as never), { body: { name: "n", scopes: ["runs_read"] } }],
    ["router.models", "get", "/v1/router/models", () => ot.router.models()],
    ["router.taskTypes", "get", "/v1/router/task-types", () => ot.router.taskTypes()],
    ["router.select", "post", "/v1/router/select", () => ot.router.select({ prompt: "p", policy: "cost_efficient" }), { body: { prompt: "p", policy: "cost_efficient" } }],
  ];
  for (const [name, method, path, call, expected] of cases) {
    it(name, async () => {
      const seen = capture(method, path);
      await call();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: method.toUpperCase(), path, ...expected });
    });
  }
});

describe("pagination", () => {
  it("awaits the first page", async () => {
    capture("get", "/v1/runs", { runs: [run()], limit: 20, offset: 0 });
    const page = await client().runs.list({ limit: 20 });
    expect(page.runs).toHaveLength(1);
  });

  it("iterates every page", async () => {
    const offsets: string[] = [];
    server.use(
      http.get(`${BASE}/v1/runs`, ({ request }) => {
        const u = new URL(request.url);
        const offset = Number(u.searchParams.get("offset") ?? 0);
        offsets.push(String(offset));
        const total = 5;
        const runs = Array.from({ length: Math.max(0, Math.min(2, total - offset)) }, (_, i) => run({ run_id: `run_${offset + i}` }));
        return HttpResponse.json({ runs, limit: 2, offset });
      }),
    );
    const ids: string[] = [];
    for await (const r of client().runs.list({ limit: 2 })) ids.push(r.run_id);
    expect(ids).toEqual(["run_0", "run_1", "run_2", "run_3", "run_4"]);
    expect(offsets).toEqual(["0", "2", "4"]);
  });

  it("stops on an empty first page", async () => {
    capture("get", "/v1/runs", { runs: [], limit: 50, offset: 0 });
    const ids: string[] = [];
    for await (const r of client().runs.list()) ids.push(r.run_id);
    expect(ids).toEqual([]);
  });
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("SSE", () => {
  const body =
    'event: state\ndata: {"run_id":"run_1","state":"completed"}\n\n' +
    'event: terminal\ndata: {"run_id":"run_1","state":"completed","input_digest":"a","output_digest":"b","kind":"decision","decision":{"answers":{"u":{"type":"noul","probability":0.9}},"draws":1,"read":"slot_constrained"}}\n\n';

  it("runs.stream yields typed state and terminal events", async () => {
    server.use(
      http.get(`${BASE}/v1/runs/run_1/stream`, ({ request }) => {
        expect(request.headers.get("accept")).toBe("text/event-stream");
        return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    const events: RunEvent[] = [];
    for await (const e of client().runs.stream("run_1")) events.push(e);
    expect(events.map((e) => e.event)).toEqual(["state", "terminal"]);
    const t = events[1] as Extract<RunEvent, { event: "terminal" }>;
    expect(t.data.decision?.answers).toEqual({ u: { type: "noul", probability: 0.9 } });
  });

  it("handles frames split across chunks and CRLF", async () => {
    const msgs = [];
    for await (const m of parseSSE(streamOf(["event: st", "ate\r\ndata: {\"a\"", ":1}\r\n", "\r\n: comment\n\nevent: terminal\ndata: x\n\n"]))) msgs.push(m);
    expect(msgs).toEqual([
      { event: "state", data: '{"a":1}' },
      { event: "terminal", data: "x" },
    ]);
  });

  it("does not dispatch early when a CRLF is split between chunks", async () => {
    const msgs = [];
    for await (const m of parseSSE(streamOf(["event: state\r", "\ndata: a\r", "\ndata: b\r\n\r", "\n"]))) msgs.push(m);
    expect(msgs).toEqual([{ event: "state", data: "a\nb" }]);
  });

  it("joins multi-line data and flushes a final frame without a blank line", async () => {
    const msgs = [];
    for await (const m of parseSSE(streamOf(["data: a\ndata: b\n\ndata: tail"]))) msgs.push(m);
    expect(msgs).toEqual([
      { event: "message", data: "a\nb" },
      { event: "message", data: "tail" },
    ]);
  });

  it("an in-flight run streams only its state", async () => {
    server.use(http.get(`${BASE}/v1/runs/run_1/stream`, () => new HttpResponse('event: state\ndata: {"run_id":"run_1","state":"running"}\n\n')));
    const events = [];
    for await (const e of client().runs.stream("run_1")) events.push(e);
    expect(events).toEqual([{ event: "state", data: { run_id: "run_1", state: "running" } }]);
  });

  it("stream errors map to classes", async () => {
    server.use(http.get(`${BASE}/v1/runs/run_1/stream`, () => HttpResponse.json({ error: { code: "run_not_found", message: "m", request_id: "r" } }, { status: 404 })));
    const it = client().runs.stream("run_1");
    await expect(it.next()).rejects.toMatchObject({ code: "run_not_found", status: 404 });
  });
});

describe("waitFor", () => {
  it("polls until terminal", async () => {
    let n = 0;
    server.use(http.get(`${BASE}/v1/runs/run_1`, () => HttpResponse.json(run({ state: ++n < 3 ? "running" : "completed" }))));
    const r = await client().runs.waitFor("run_1", { interval: 1 });
    expect(r.state).toBe("completed");
    expect(n).toBe(3);
  });

  it("throws wait_timeout instead of returning a run that is not finished", async () => {
    server.use(http.get(`${BASE}/v1/runs/run_1`, () => HttpResponse.json(run({ state: "running" }))));
    await expect(client().runs.waitFor("run_1", { interval: 5, timeout: 30 })).rejects.toMatchObject({ code: "wait_timeout" });
  });

  it("bounds each poll by the time left", async () => {
    server.use(http.get(`${BASE}/v1/runs/run_1`, () => new Promise<Response>(() => {})));
    await expect(client().runs.waitFor("run_1", { timeout: 50 })).rejects.toMatchObject({ code: "timeout" });
  });
});
