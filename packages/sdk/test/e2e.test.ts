/**
 * Live end-to-end tests against a real API. Opt-in:
 *   OPENTYPE_E2E=1 OPENTYPE_API_KEY=otsk_... [OPENTYPE_BASE_URL=...] pnpm vitest run test/e2e.test.ts
 * Sequential on purpose. Spends a few micro-dollars.
 */
import { describe, expect, it } from "vitest";
import { OpenType, type RunEvent } from "../src/index.js";

const enabled = process.env.OPENTYPE_E2E === "1" && !!process.env.OPENTYPE_API_KEY;

describe.skipIf(!enabled).sequential("live API", () => {
  const ot = enabled ? new OpenType({ maxRetries: 1 }) : (undefined as unknown as OpenType);
  const key = `sdk-e2e-${Date.now()}`;
  let runId = "";

  it("decide", { timeout: 180_000 }, async () => {
    const d = await ot.decide({
      prompt: "Refund me today or I dispute the charge with my bank.",
      question: "Is the customer threatening to escalate?",
      idempotencyKey: key,
    });
    runId = d.runId;
    expect(d.run.state).toBe("completed");
    expect(d.answer?.type).toBe("noul");
    const p = d.answer?.type === "noul" ? d.answer.probability : -1;
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
    console.log(`decide: ${runId} P(yes)=${p} cost=${d.costMicros} model=${d.model}`);
  });

  it("decide replay with the same key", { timeout: 60_000 }, async () => {
    const d = await ot.decide({
      prompt: "Refund me today or I dispute the charge with my bank.",
      question: "Is the customer threatening to escalate?",
      idempotencyKey: key,
    });
    expect(d.runId).toBe(runId);
    expect(d.replayed).toBe(true);
  });

  it("verdict", { timeout: 180_000 }, async () => {
    try {
      const v = await ot.verdict({
        prompt: "Order #4822: two lamps, shipped to Lyon.",
        schema: { type: "object", properties: { order: { type: "integer" } }, required: ["order"] },
        maxOutputTokens: 64,
      });
      console.log(`verdict: ${v.runId} ${JSON.stringify(v.verdict)}`);
      expect(v.run.state).toBe("completed");
    } catch (e) {
      // Neon 1.1 serves decisions only today; a verdict answers 503 no_route_available.
      const code = (e as { code?: string }).code;
      console.log(`verdict: ${code}`);
      expect(code).toBe("no_route_available");
    }
  });

  it("stream", async () => {
    const events: RunEvent[] = [];
    for await (const e of ot.runs.stream(runId)) events.push(e);
    expect(events.map((e) => e.event)).toEqual(["state", "terminal"]);
    const t = events[1] as Extract<RunEvent, { event: "terminal" }>;
    expect(t.data.kind).toBe("decision");
    expect(t.data.decision?.answers).toBeTruthy();
  });

  it("get", async () => {
    const r = await ot.runs.get(runId);
    expect(r.run_id).toBe(runId);
    expect(r._requestId).toBeTruthy();
  });

  it("list", async () => {
    const page = await ot.runs.list({ limit: 5 });
    expect(page.runs.some((r) => r.run_id === runId)).toBe(true);
    let n = 0;
    for await (const _ of ot.runs.list({ limit: 2 })) if (++n >= 3) break;
    expect(n).toBeGreaterThan(0);
  });

  it("usage and quota", async () => {
    const u = await ot.usage.summary();
    expect(u.organization_id).toBeTruthy();
    const ru = await ot.usage.run(runId);
    expect(ru).toBeTruthy();
    const q = await ot.usage.quota();
    expect(q.organization_id).toBe(u.organization_id);
  });

  it("router select", { timeout: 120_000 }, async () => {
    const r = await ot.route({ prompt: "Write a Rust function that parses RFC 3339 timestamps.", policy: "cost_efficient" });
    const pick = r.ranking[0]!;
    console.log(
      `route: ${r.model.id} task_type=${r.classification.task_type.label} cost=$${pick.estimated_cost_usd} ` +
        `latency=${Math.round(pick.estimated_latency_ms)}ms strengths=${pick.strengths.map((b) => b.name).join("|")}`,
    );
    expect(r.model.id).toBeTruthy();
    expect(r.classification.task_type.top.length).toBeGreaterThan(0);
    expect(pick.estimated_cost_usd).toBeGreaterThan(0);
  });

  it("router select with v2 knobs", { timeout: 120_000 }, async () => {
    const r = await ot.route({
      prompt: "Summarize this quarterly report in three bullet points.",
      taskType: "summarization",
      latency: "interactive",
      weights: { quality: 0.5, cost: 0.3, speed: 0.2 },
      models: { open_weights: true },
    });
    console.log(`route knobs: ${r.model.id} fixed=${r.classification.task_type.fixed} filters=${JSON.stringify(r.filters_applied)}`);
    expect(r.classification.task_type.fixed).toBe(true);
    expect(r.model.open_weights).toBe(true);
  });

  it("router task types", async () => {
    const t = await ot.router.taskTypes();
    console.log(`task types: ${t.task_types.length} in ${t.families.length} families (as of ${t.benchmarks_as_of})`);
    expect(t.task_types.length).toBeGreaterThan(5);
    expect(t.task_types.every((x) => x.weights.length > 0)).toBe(true);
  });

  it("long decision (~20k tokens)", { timeout: 200_000 }, async () => {
    const line = "Ticket 0000: the customer reports the export button does nothing on Safari; no data loss, workaround exists.\n";
    const prompt = Array.from({ length: 800 }, (_, i) => line.replace("0000", String(i).padStart(4, "0"))).join("");
    const t0 = Date.now();
    const d = await ot.decide({ prompt, question: "Does any ticket report data loss?" });
    const input = (d.run.usage as { input_tokens?: number } | null | undefined)?.input_tokens;
    console.log(`long decide: ${d.runId} input_tokens=${input} P(yes)=${d.answer?.type === "noul" ? d.answer.probability : "?"} ${Date.now() - t0}ms cost=${d.costMicros}`);
    expect(d.run.state).toBe("completed");
    expect(input ?? 0).toBeGreaterThan(15_000);
  });
});
