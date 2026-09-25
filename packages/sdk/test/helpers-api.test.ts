import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { BASE, client, run, server, useServer } from "./helpers.js";

useServer();

function captureRun(reply: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = [];
  const keys: (string | null)[] = [];
  server.use(
    http.post(`${BASE}/v1/runs`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      keys.push(request.headers.get("idempotency-key"));
      return HttpResponse.json(reply);
    }),
  );
  return { bodies, keys };
}

const decision = {
  answers: {
    answer: { type: "choice", choice: "billing", probabilities: { billing: 0.8, other: 0.2 }, confidence: 0.8 },
  },
  draws: 1,
  read: "slot_constrained",
  model: "neon-1.1",
};

describe("decide", () => {
  it("shorthand yes/no", async () => {
    const { bodies } = captureRun(run({ decision: { ...decision, answers: { answer: { type: "noul", probability: 0.91 } } } }));
    const d = await client().decide({ prompt: "Refund now or I dispute.", question: "Is this urgent?" });
    expect(bodies[0]).toEqual({
      kind: "decision",
      state: "Refund now or I dispute.",
      questions: { answer: { type: "noul", instructions: "Is this urgent?" } },
      max_output_tokens: 16,
    });
    expect(d.answer).toEqual({ type: "noul", probability: 0.91 });
    expect(d.model).toBe("neon-1.1");
  });

  it("shorthand choices become a criteria map", async () => {
    const { bodies } = captureRun(run({ decision }));
    const d = await client().decide({ prompt: "x", question: "Team?", choices: ["billing", "other"], draws: 3, model: "neon-1.1" });
    expect(bodies[0]).toMatchObject({
      questions: { answer: { type: "choice", instructions: "Team?", criteria: { billing: null, other: null } } },
      draws: 3,
      model: "neon-1.1",
    });
    expect(d.answer?.type === "choice" && d.answer.probabilities.billing).toBe(0.8);
  });

  it("levels become a score question; messages become state", async () => {
    const { bodies } = captureRun(run({ decision }));
    await client().decide({ messages: [{ role: "user", content: "hi" }], levels: ["low", "high"] });
    expect(bodies[0]).toMatchObject({
      state: { messages: [{ role: "user", content: "hi" }] },
      questions: { answer: { type: "score", instructions: "Decide.", criteria: ["low", "high"] } },
    });
  });

  it("full form with an idempotency key", async () => {
    const { bodies, keys } = captureRun(run({ decision }));
    await client().decide({
      state: { ticket: 1 },
      questions: { a: { type: "noul", instructions: "?" } },
      instructions: "be strict",
      thinkTokens: 64,
      idempotencyKey: "biz-1",
    });
    expect(bodies[0]).toMatchObject({ state: { ticket: 1 }, instructions: "be strict", think_tokens: 64 });
    expect(keys[0]).toBe("biz-1");
  });

  it("requires input", async () => {
    await expect(client().decide({ question: "?" } as never)).rejects.toThrow(TypeError);
  });
});

describe("verdict", () => {
  it("prompt shorthand", async () => {
    const { bodies } = captureRun(run({ kind: "verdict", verdict: { ok: true } }));
    const v = await client().verdict<{ ok: boolean }>({ prompt: "p", schema: { type: "object" }, maxOutputTokens: 64, system: "s" });
    expect(bodies[0]).toEqual({
      kind: "verdict",
      messages: [{ role: "user", content: "p" }],
      system: "s",
      schema: { type: "object" },
      max_output_tokens: 64,
    });
    expect(v.verdict.ok).toBe(true);
  });
});

describe("route", () => {
  it("posts the selection request", async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/v1/router/select`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "rtr_1", model: { id: "m" } });
      }),
    );
    const r = await client().route({ prompt: "refactor this", policy: "cost_efficient", models: { open_weights: true } });
    expect(body).toEqual({ prompt: "refactor this", policy: "cost_efficient", models: { open_weights: true } });
    expect(r.id).toBe("rtr_1");
  });

  it("maps the v2 knobs to snake_case", async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/v1/router/select`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "rtr_2" });
      }),
    );
    await client().route({
      prompt: "p",
      taskType: "code_generation",
      latency: "interactive",
      maxLatencyMs: 20_000,
      weights: { quality: 0.6, cost: 0.2, speed: 0.2 },
    });
    expect(body).toEqual({
      prompt: "p",
      task_type: "code_generation",
      latency: "interactive",
      max_latency_ms: 20_000,
      weights: { quality: 0.6, cost: 0.2, speed: 0.2 },
    });
  });
});
