/**
 * The six OpenType agent tools, defined once. The framework adapters
 * (`/tools/vercel`, `/tools/openai`, `/tools/anthropic`) and the MCP server
 * all render this list, so a tool behaves the same everywhere.
 */
import { OpenType } from "../client.js";
import type { ClientOptions } from "../core.js";
import type {
  DecisionAnswer,
  DecisionQuestion,
  NeonModel,
  RouterModel,
  RouterModelFilters,
  RouterSelectResponse,
  RouterWeights,
  RunMessage,
} from "../types.js";

export type JSONSchema = { [k: string]: unknown };

export interface ToolResult {
  /** A short human/agent-readable summary. */
  text: string;
  /** The raw API JSON. */
  data: unknown;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface OpenTypeTool<A = Record<string, unknown>> {
  name: ToolName;
  description: string;
  inputSchema: JSONSchema;
  annotations: ToolAnnotations;
  execute(client: OpenType, args: A): Promise<ToolResult>;
}

export type ToolName =
  | "opentype_decide"
  | "opentype_verdict"
  | "opentype_route_model"
  | "opentype_list_models"
  | "opentype_get_run"
  | "opentype_usage";

export const DOMAINS = [
  "coding",
  "math",
  "reasoning",
  "knowledge",
  "agentic",
  "long_context",
  "writing",
  "multilingual",
  "general",
] as const;
export const POLICIES = ["balanced", "cost_efficient", "capability_heavy", "domain_skills"] as const;
export const LATENCIES = ["interactive", "standard", "batch"] as const;

const messagesSchema = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } },
    required: ["role", "content"],
    additionalProperties: false,
  },
} as const;

const idempotencySchema = {
  type: "string",
  maxLength: 200,
  description: "Optional stable key for this logical request. Reuse it when retrying the same call so you are never charged twice.",
} as const;

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export function summarizeAnswer(id: string, a: DecisionAnswer): string {
  switch (a.type) {
    case "noul":
      return `${id}: P(yes) = ${pct(a.probability)}`;
    case "choice": {
      const dist = Object.entries(a.probabilities)
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${k} ${pct(v)}`)
        .join(", ");
      return `${id}: ${a.choice} (${dist})`;
    }
    case "score": {
      const dist = Object.entries(a.probabilities)
        .map(([k, v]) => `${a.legend[k] ?? k} ${pct(v)}`)
        .join(", ");
      return `${id}: ${a.legend[String(a.score)] ?? a.score} (score ${a.score}; ${dist})`;
    }
    case "skipped":
      return `${id}: skipped (${JSON.stringify(a.because)})`;
    default:
      return `${id}: ${JSON.stringify(a)}`;
  }
}

const usd = (x: number) => (x < 0.01 ? `$${x.toPrecision(2)}` : `$${x.toFixed(2)}`);
const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function summarizeRoute(r: RouterSelectResponse): string {
  const tt = r.classification.task_type;
  const pick = r.ranking.find((x) => x.id === r.model.id) ?? r.ranking[0];
  const lines = [`Use ${r.model.id} (${r.model.name}, ${r.model.provider}). ${r.reason}`];
  const alt = tt.top
    .slice(1, 3)
    .filter((t) => t.probability >= 0.05)
    .map((t) => `${t.task_type} ${pct(t.probability)}`)
    .join(", ");
  lines.push(
    `Task type: ${tt.label} (${tt.family}${tt.fixed ? ", fixed" : `, ${pct(tt.top[0]?.probability ?? 0)}`}${alt ? `; also ${alt}` : ""}). ` +
      `Difficulty: ${r.classification.facets.difficulty.label}. Policy: ${r.policy}.` +
      (r.low_confidence ? " Low confidence: consider fixing task_type." : ""),
  );
  if (pick) {
    const est = `${usd(pick.estimated_cost_usd)}, ~${secs(pick.estimated_latency_ms)}${pick.latency_estimated ? " (latency estimated)" : ""}`;
    lines.push(`Pick: quality ${pick.expected_quality.toFixed(2)}, est. ${est}.`);
    if (pick.strengths.length) lines.push(`Strengths: ${pick.strengths.map((b) => b.name).join(", ")}.`);
    if (pick.weaknesses.length) lines.push(`Weaknesses: ${pick.weaknesses.map((b) => b.name).join(", ")}.`);
  }
  const top = r.ranking
    .slice(0, 3)
    .map((x) => `${x.id} (q ${x.expected_quality.toFixed(2)}, ${usd(x.estimated_cost_usd)}, ${secs(x.estimated_latency_ms)})`)
    .join("; ");
  lines.push(`Top: ${top}`);
  return lines.join("\n");
}

const decide: OpenTypeTool<{
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  instructions?: string;
  draws?: number;
  model?: NeonModel;
  max_output_tokens?: number;
  idempotency_key?: string;
}> = {
  name: "opentype_decide",
  description:
    "Get calibrated probabilities for a judgement instead of guessing. Use it WHEN you face a yes/no call (is this urgent? is this spam? should I escalate?), " +
    "a pick-one choice from a fixed set (which team, which category), or a rating on an ordered scale, and you want a number you can threshold. " +
    "Put the thing being judged in `state` and one or more questions in `questions`, keyed by your own ids: " +
    '{"type":"noul","instructions":"..."} (answer is P(yes)), {"type":"choice","instructions":"...","criteria":{"option":null,...}}, ' +
    'or {"type":"score","instructions":"...","criteria":["low","mid","high"]}. Several questions in one call cost one run. ' +
    "Do NOT use it for open-ended text or extraction (use opentype_verdict). Spends credit (fractions of a cent).",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "The text or record being judged. Keep it under ~15 KB." },
      questions: {
        type: "object",
        description: "Question id -> question.",
        additionalProperties: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["noul", "choice", "score"] },
            instructions: { type: "string", description: "The question, e.g. 'Does the customer threaten to leave?'" },
            criteria: {
              description:
                "noul: {true?, false?} descriptions; choice: {option_name: description|null}; score: ordered list of level names, lowest first.",
            },
            depends_on: { type: "array", items: { type: "string" } },
            ask_if: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
          },
          required: ["type", "instructions"],
        },
      },
      instructions: { type: "string", description: "Shared guidance for all questions." },
      draws: { type: "integer", minimum: 1, maximum: 8, description: "Independent reads to average (default 1)." },
      model: { type: "string", enum: ["neon-1.1", "neon-latest"] },
      max_output_tokens: { type: "integer", minimum: 1, description: "Default 16." },
      idempotency_key: idempotencySchema,
    },
    required: ["state", "questions"],
    additionalProperties: false,
  },
  annotations: { title: "Decide with probabilities", readOnlyHint: false, openWorldHint: true },
  async execute(client, a) {
    const d = await client.decide({
      state: a.state,
      questions: a.questions,
      instructions: a.instructions,
      draws: a.draws,
      model: a.model,
      maxOutputTokens: a.max_output_tokens,
      idempotencyKey: a.idempotency_key,
    });
    const lines = Object.entries(d.answers).map(([id, ans]) => summarizeAnswer(id, ans));
    return {
      text: `${lines.join("\n") || `run ${d.runId}: ${d.run.state}`}\n(run ${d.runId}${d.replayed ? ", replayed" : ""})`,
      data: d.run,
    };
  },
};

const verdict: OpenTypeTool<{
  messages: RunMessage[];
  system?: string;
  schema: unknown;
  max_output_tokens: number;
  deadline_ms?: number;
  idempotency_key?: string;
}> = {
  name: "opentype_verdict",
  description:
    "Produce one JSON document that is guaranteed to validate against a JSON Schema you supply. Use it WHEN you need structured extraction or a " +
    "schema-shaped answer from text (fields from an email, a typed classification record) and a malformed result is not acceptable. " +
    "For a probability on a yes/no, pick-one or rating question use opentype_decide instead. Spends credit.",
  inputSchema: {
    type: "object",
    properties: {
      messages: messagesSchema,
      system: { type: "string" },
      schema: { type: "object", description: "The JSON Schema the document must satisfy." },
      max_output_tokens: { type: "integer", minimum: 1 },
      deadline_ms: { type: "integer", minimum: 1, maximum: 120000 },
      idempotency_key: idempotencySchema,
    },
    required: ["messages", "schema", "max_output_tokens"],
    additionalProperties: false,
  },
  annotations: { title: "Schema-validated verdict", readOnlyHint: false, openWorldHint: true },
  async execute(client, a) {
    const v = await client.verdict({
      messages: a.messages,
      system: a.system,
      schema: a.schema,
      maxOutputTokens: a.max_output_tokens,
      deadlineMs: a.deadline_ms,
      idempotencyKey: a.idempotency_key,
    });
    return { text: `${JSON.stringify(v.verdict)}\n(run ${v.runId})`, data: v.run };
  },
};

const route: OpenTypeTool<{
  prompt?: string;
  messages?: RunMessage[];
  policy?: (typeof POLICIES)[number];
  domain?: (typeof DOMAINS)[number];
  task_type?: string;
  latency?: (typeof LATENCIES)[number];
  max_latency_ms?: number;
  weights?: RouterWeights;
  models?: RouterModelFilters;
}> = {
  name: "opentype_route_model",
  description:
    "Pick which LLM should handle a task. Use it BEFORE delegating a sub-task or choosing a model, when cost, capability or a domain specialty matters. " +
    "It classifies the task (task type, difficulty, facets) and ranks catalog models on that task type's benchmark mix, with an estimated cost and " +
    "latency for this very request. Policies: balanced (default: quality, cost and latency), cost_efficient (cheapest above the quality bar), " +
    "capability_heavy (best quality, cost aside), domain_skills (the specialist). Returns the pick, a reason, and the top ranking with strengths and " +
    "weaknesses. It only recommends; it does not call the model. Pass `prompt` or `messages`, not both. Spends credit (one small decision).",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", maxLength: 32000, description: "The task to route." },
      messages: messagesSchema,
      policy: { type: "string", enum: [...POLICIES] },
      task_type: {
        type: "string",
        description: "Skip task-type classification and route as this type, e.g. code_generation. opentype_list_models with task_types:true lists them.",
      },
      domain: { type: "string", enum: [...DOMAINS], description: "v1 override: route as this domain's default task type. task_type wins." },
      latency: { type: "string", enum: [...LATENCIES], description: "How much latency weighs in balanced. Default standard." },
      max_latency_ms: { type: "number", minimum: 1, description: "Drop models whose estimated time to the full answer exceeds this." },
      weights: {
        type: "object",
        description: "balanced only: your own trade-off, normalized to sum to 1.",
        properties: { quality: { type: "number", minimum: 0 }, cost: { type: "number", minimum: 0 }, speed: { type: "number", minimum: 0 } },
        additionalProperties: false,
      },
      models: {
        type: "object",
        description: "Filters on the candidate set.",
        properties: {
          include: { type: "array", items: { type: "string" } },
          exclude: { type: "array", items: { type: "string" } },
          providers: { type: "array", items: { type: "string" } },
          open_weights: { type: "boolean" },
          max_price_per_mtok: { type: "number", description: "Blended USD per million tokens." },
          min_context_tokens: { type: "integer" },
          modalities: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  annotations: { title: "Route to a model", readOnlyHint: false, openWorldHint: true },
  async execute(client, a) {
    if ((a.prompt === undefined) === (a.messages === undefined)) {
      throw new TypeError("Pass exactly one of `prompt` or `messages`.");
    }
    const r = await client.route({
      prompt: a.prompt,
      messages: a.messages,
      policy: a.policy,
      domain: a.domain,
      taskType: a.task_type,
      latency: a.latency,
      maxLatencyMs: a.max_latency_ms,
      weights: a.weights,
      models: a.models,
    });
    return { text: summarizeRoute(r), data: r };
  },
};

const listModels: OpenTypeTool<{ provider?: string; open_weights?: boolean; domain?: string; limit?: number; task_types?: boolean }> = {
  name: "opentype_list_models",
  description:
    "List the LLM catalog the router scores: providers, context size, prices and benchmark scores. Use it WHEN you need to know which models " +
    "exist or compare them yourself; to get a recommendation use opentype_route_model. With task_types:true it lists the task types instead " +
    "(ids to pass as opentype_route_model task_type, and the benchmarks each one weighs). Free, read-only.",
  inputSchema: {
    type: "object",
    properties: {
      provider: { type: "string" },
      open_weights: { type: "boolean" },
      domain: { type: "string", enum: [...DOMAINS], description: "Only models listing this specialty." },
      limit: { type: "integer", minimum: 1, maximum: 500 },
      task_types: { type: "boolean", description: "List the router's task types and their benchmark weights instead of models." },
    },
    additionalProperties: false,
  },
  annotations: { title: "List models", readOnlyHint: true, openWorldHint: false },
  async execute(client, a) {
    if (a.task_types) {
      const tt = await client.router.taskTypes();
      const text = tt.task_types
        .map((t) => `${t.id} (${t.family}): ${t.description} [${[...t.weights].sort((x, y) => y.weight - x.weight).slice(0, 3).map((w) => `${w.name} ${pct(w.weight)}`).join(", ")}]`)
        .join("\n");
      return { text: `${tt.task_types.length} task types (benchmarks as of ${tt.benchmarks_as_of})\n${text}`, data: tt };
    }
    const cat = await client.router.models();
    let models: RouterModel[] = cat.models;
    if (a.provider) models = models.filter((m) => m.provider === a.provider);
    if (a.open_weights !== undefined) models = models.filter((m) => m.open_weights === a.open_weights);
    if (a.domain) models = models.filter((m) => m.domains.includes(a.domain as string));
    if (a.limit) models = models.slice(0, a.limit);
    const text = models
      .map((m) => `${m.id} (${m.provider}${m.open_weights ? ", open" : ""}) in $${m.price_input_per_mtok}/out $${m.price_output_per_mtok} per Mtok, ctx ${m.context_tokens}`)
      .join("\n");
    return { text: `${models.length} models (as of ${cat.as_of})\n${text}`, data: { ...cat, models } };
  },
};

const getRun: OpenTypeTool<{ run_id: string }> = {
  name: "opentype_get_run",
  description:
    "Read a run by id: its state, answer (verdict or decision), usage and cost. Use it WHEN a decide/verdict call returned a pending run, " +
    "or to re-read an earlier result. Free, read-only.",
  inputSchema: {
    type: "object",
    properties: { run_id: { type: "string", description: "The run id, prefixed run_." } },
    required: ["run_id"],
    additionalProperties: false,
  },
  annotations: { title: "Get run", readOnlyHint: true, openWorldHint: false },
  async execute(client, a) {
    const run = await client.runs.get(a.run_id);
    const answers = (run.decision?.answers ?? {}) as Record<string, DecisionAnswer>;
    const detail = run.decision
      ? Object.entries(answers).map(([id, x]) => summarizeAnswer(id, x)).join("\n")
      : run.verdict !== undefined
        ? JSON.stringify(run.verdict)
        : "";
    return { text: `${run.run_id} ${run.kind} ${run.state}${detail ? `\n${detail}` : ""}`, data: run };
  },
};

const usage: OpenTypeTool<{ start_at?: string; end_at?: string; include_quota?: boolean }> = {
  name: "opentype_usage",
  description:
    "Report OpenType spend, run counts and tokens for the organization over a window (default: the last 30 days, UTC), optionally with the quota. " +
    "Use it WHEN the user asks what OpenType has cost or whether a quota is close. Free, read-only.",
  inputSchema: {
    type: "object",
    properties: {
      start_at: { type: "string", description: "RFC 3339, e.g. 2026-09-01T00:00:00Z" },
      end_at: { type: "string", description: "RFC 3339" },
      include_quota: { type: "boolean" },
    },
    additionalProperties: false,
  },
  annotations: { title: "Usage", readOnlyHint: true, openWorldHint: false },
  async execute(client, a) {
    const end = a.end_at ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const start = a.start_at ?? new Date(Date.parse(end) - 30 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
    const summary = await client.usage.summary({ startAt: start, endAt: end });
    const quota = a.include_quota ? await client.usage.quota() : undefined;
    const s = summary as unknown as { runs?: Record<string, number>; spend?: Record<string, number>; tokens?: Record<string, number> };
    const text =
      `Usage ${start} .. ${end}\nruns: ${JSON.stringify(s.runs)}\ntokens: ${JSON.stringify(s.tokens)}\nspend: ${JSON.stringify(s.spend)}` +
      (quota ? `\nquota: ${JSON.stringify(quota)}` : "");
    return { text, data: quota ? { usage: summary, quota } : { usage: summary } };
  },
};

export const tools: readonly OpenTypeTool<any>[] = [decide, verdict, route, listModels, getRun, usage];

export function getTool(name: string): OpenTypeTool<any> | undefined {
  return tools.find((t) => t.name === name);
}

/** A client from an instance, options, or the environment. Resolved lazily so listing tools never needs a key. */
export type ClientSource = OpenType | ClientOptions | undefined;

export function lazyClient(source: ClientSource): () => OpenType {
  // Duck-typed: the CJS build bundles each entry separately, so `instanceof` would miss a client from the main entry.
  let c: OpenType | undefined = source && "runs" in source && "_core" in source ? (source as OpenType) : undefined;
  return () => (c ??= new OpenType(source as ClientOptions | undefined));
}

/** Run a tool by name and return the text a model should read. Errors become text, never throws. */
export async function runTool(
  client: () => OpenType,
  name: string,
  args: unknown,
): Promise<ToolResult & { isError: boolean }> {
  const tool = getTool(name);
  if (!tool) return { text: `Unknown tool ${name}`, data: null, isError: true };
  try {
    const r = await tool.execute(client(), (args ?? {}) as Record<string, unknown>);
    return { ...r, isError: false };
  } catch (e) {
    const err = e as { code?: string; message?: string; requestId?: string | null; run?: unknown };
    const id = err.requestId ? ` (request ${err.requestId})` : "";
    return {
      text: `${err.code ? `${err.code}: ` : ""}${err.message ?? String(e)}${id}`,
      data: { error: { code: err.code, message: err.message, request_id: err.requestId ?? null }, run: err.run },
      isError: true,
    };
  }
}
