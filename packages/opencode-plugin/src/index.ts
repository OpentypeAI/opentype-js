import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ponytail: plain fetch against the public HTTP API instead of @opentype/sdk, so the plugin has
// no runtime dependency; switch to the SDK once it is published if retries/streaming are needed.

const DEFAULT_BASE_URL = "https://api.opentype.dev"

export type OpenTypeOptions = {
  apiKey?: string
  baseUrl?: string
  /** Per-request deadline in ms. Default 170 000, above the longest run deadline. */
  timeoutMs?: number
}

type Fetch = typeof fetch

const DEFAULT_TIMEOUT_MS = 170_000
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** The key is only ever sent over HTTPS; plain HTTP is allowed for a local server. */
function checkBaseUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`OpenType base URL must use https (http only for localhost): ${raw}`)
  }
  return raw.replace(/\/+$/, "")
}

const PAID = new Set(["/v1/runs", "/v1/router/select"])

export function createClient(opts: OpenTypeOptions = {}, fetchImpl: Fetch = fetch) {
  const baseUrl = checkBaseUrl(opts.baseUrl ?? process.env.OPENTYPE_BASE_URL ?? DEFAULT_BASE_URL)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async function call(method: string, path: string, body?: unknown, idempotencyKey?: string) {
    // Read the key at call time, so the tools still register without one.
    const apiKey = opts.apiKey ?? process.env.OPENTYPE_API_KEY
    if (!apiKey) {
      throw new Error(
        "OPENTYPE_API_KEY is not set. Create a key at https://console.opentype.dev/keys, export it, and restart OpenCode.",
      )
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
    if (body !== undefined) headers["Content-Type"] = "application/json"
    // A new key per paid call. A failure names it, and passing it back as `idempotency_key` replays that run instead of paying again.
    const key = method === "POST" && PAID.has(path) ? (idempotencyKey ?? crypto.randomUUID()) : undefined
    if (key) headers["Idempotency-Key"] = key
    const replay = key ? ` Retry with idempotency_key "${key}" to replay it instead of paying again.` : ""
    let res: Response
    let text: string
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      text = await res.text()
    } catch (cause) {
      const timedOut = (cause as Error)?.name === "TimeoutError"
      throw new Error(
        `${timedOut ? `OpenType API did not answer within ${timeoutMs} ms` : `OpenType API unreachable: ${(cause as Error)?.message ?? cause}`}.${replay}`,
        { cause },
      )
    }
    let json: any
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const err = json?.error
      const detail = err ? `${err.code}: ${err.message}${err.request_id ? ` (request ${err.request_id})` : ""}` : text
      throw new Error(`OpenType API ${res.status} ${detail}`.trim() + (res.status >= 500 ? replay : ""))
    }
    return json
  }
}

const out = (title: string, data: unknown) => ({ title, output: JSON.stringify(data, null, 2) })
const drop = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

const pct = (p: number) => `${Math.round(p * 100)}%`

/** One-glance summary of a /v1/router/select response; the full JSON follows it. */
export function routeSummary(r: any): string {
  const tt = r?.classification?.task_type
  const top = r?.ranking?.find((e: any) => e.id === r?.model?.id) ?? r?.ranking?.[0]
  const p = tt?.top?.[0]?.probability
  const lines = [
    `task_type: ${tt?.label ?? "?"}${tt?.family ? ` (${tt.family})` : ""}${tt?.fixed ? ", fixed" : p !== undefined ? `, ${pct(p)}` : ""}${r?.low_confidence ? ", LOW CONFIDENCE" : ""}`,
    `pick: ${r?.model?.name ?? r?.model?.id ?? "?"} (${r?.model?.provider ?? "?"}${r?.model?.open_weights ? ", open weights" : ""}), policy ${r?.policy ?? "?"}`,
  ]
  if (top) {
    lines.push(
      `estimate: $${Number(top.estimated_cost_usd).toFixed(4)}, ${Math.round(top.estimated_latency_ms)} ms${top.latency_estimated ? " (latency imputed)" : ""}, quality ${Number(top.expected_quality).toFixed(2)}`,
    )
    if (top.strengths?.length) lines.push(`strengths: ${top.strengths.map((s: any) => s.name ?? s.benchmark).join(", ")}`)
  }
  return lines.join("\n")
}

export function createTools(opts: OpenTypeOptions = {}, fetchImpl: Fetch = fetch) {
  const call = createClient(opts, fetchImpl)
  const z = tool.schema
  const message = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })
  const question = z
    .object({
      type: z.enum(["noul", "choice", "score"]),
      instructions: z.string(),
      criteria: z
        .union([z.record(z.string(), z.string().nullable()), z.array(z.string())])
        .optional()
        .describe("noul: {true?, false?}; choice: {option: description|null}; score: [level names, lowest first]"),
      depends_on: z.array(z.string()).optional(),
      ask_if: z.record(z.string(), z.array(z.string())).optional().describe("{question_id: [answer names]}; noul answers are yes/no"),
    })
    .passthrough()

  return {
    opentype_decide: tool({
      description:
        "Typed decisions with calibrated probabilities from Neon 1.1. One call answers several questions (noul = yes/no, choice = pick one, score = rating) about one input `state`. Use for branching, classification and triage; act on the probability. Spends credit (one decision run).",
      args: {
        state: z.union([z.string(), z.record(z.string(), z.any())]).describe("The thing being decided about: text or a JSON object."),
        questions: z.record(z.string(), question).describe("Questions keyed by your own ids."),
        instructions: z.string().optional().describe("Shared context for all questions."),
        draws: z.number().int().min(1).max(8).optional().describe("Noise draws to average, 1-8."),
        model: z.enum(["neon-1.1", "neon-latest"]).optional(),
        idempotency_key: z.string().min(1).optional().describe("Retrying after an error? Pass the key that error named, so the retry replays the run instead of paying again."),
      },
      async execute({ idempotency_key, ...a }) {
        const run = await call("POST", "/v1/runs", drop({ kind: "decision", max_output_tokens: 16, ...a }), idempotency_key)
        return out(`decide ${run?.id ?? ""}`.trim(), run)
      },
    }),

    opentype_verdict: tool({
      description:
        "A schema-validated verdict from Neon 1.1: yes/no or pass/fail judgments and structured extraction against a JSON Schema. Spends credit (one verdict run).",
      args: {
        messages: z.array(message).min(1),
        system: z.string().optional(),
        schema: z.record(z.string(), z.any()).describe("JSON Schema the answer must satisfy."),
        max_output_tokens: z.number().int().min(1),
        deadline_ms: z.number().int().min(0).optional(),
        idempotency_key: z.string().min(1).optional().describe("Retrying after an error? Pass the key that error named."),
      },
      async execute({ idempotency_key, ...a }) {
        const run = await call("POST", "/v1/runs", drop({ kind: "verdict", ...a }), idempotency_key)
        return out(`verdict ${run?.id ?? ""}`.trim(), run)
      },
    }),

    opentype_route_model: tool({
      description:
        "Pick the best LLM for a task (Router v2). Neon 1.1 classifies the task type (e.g. code_generation) and facets (difficulty, output length, tools, vision, language); a benchmark scorer ranks the catalog per policy (balanced, cost_efficient, capability_heavy, domain_skills). Returns the pick, per-request cost and latency estimates, strengths/weaknesses per benchmark, the quality threshold and the ranking. Selection only; spends credit (one decision run).",
      args: {
        prompt: z.string().optional().describe("The task. Bodies up to 4 MiB; only head and tail are read."),
        messages: z.array(message).optional(),
        policy: z.enum(["balanced", "cost_efficient", "capability_heavy", "domain_skills"]).optional(),
        task_type: z
          .string()
          .optional()
          .describe("Skip classification and route as this task type (list them with opentype_list_models task_types=true). Wins over `domain`."),
        domain: z
          .enum(["coding", "math", "reasoning", "knowledge", "agentic", "long_context", "writing", "multilingual", "general"])
          .optional()
          .describe("v1 override: route as this domain's default task type."),
        latency: z.enum(["interactive", "standard", "batch"]).optional().describe("How much latency weighs in `balanced`; default standard."),
        max_latency_ms: z.number().positive().optional().describe("Drop models slower than this, or whose speed is not measured."),
        weights: z
          .object({ quality: z.number().min(0).optional(), cost: z.number().min(0).optional(), speed: z.number().min(0).optional() })
          .optional()
          .describe("`balanced` only: custom quality/cost/speed trade-off, normalized server-side."),
        models: z
          .object({
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
            providers: z.array(z.string()).optional(),
            open_weights: z.boolean().optional(),
            max_price_per_mtok: z.number().optional(),
            min_context_tokens: z.number().int().optional(),
            modalities: z.array(z.string()).optional(),
          })
          .optional(),
        idempotency_key: z.string().min(1).optional().describe("Retrying after an error? Pass the key that error named."),
      },
      async execute({ idempotency_key, ...a }) {
        if (!a.prompt === !a.messages) throw new Error("Pass exactly one of `prompt` or `messages`.")
        if (a.weights && (a.policy ?? "balanced") !== "balanced") throw new Error("`weights` requires policy `balanced`.")
        const r = await call("POST", "/v1/router/select", drop(a), idempotency_key)
        return { title: `route: ${r?.model?.id ?? "?"}`, output: `${routeSummary(r)}\n\n${JSON.stringify(r, null, 2)}` }
      },
    }),

    opentype_list_models: tool({
      description:
        "List the router's model catalog with benchmark scores and prices, or with task_types=true the task types the router classifies into (families and benchmark weights). Read-only, free.",
      args: {
        provider: z.string().optional(),
        open_weights: z.boolean().optional(),
        domain: z.string().optional(),
        limit: z.number().int().min(1).optional(),
        task_types: z.boolean().optional().describe("Return the task-type taxonomy instead of models."),
      },
      async execute({ provider, open_weights, domain, limit, task_types }) {
        if (task_types) {
          const t = await call("GET", "/v1/router/task-types")
          return out(`${t?.task_types?.length ?? 0} task types`, t)
        }
        const cat = await call("GET", "/v1/router/models")
        let models: any[] = Array.isArray(cat) ? cat : (cat?.models ?? [])
        if (provider) models = models.filter((m) => m.provider === provider)
        if (open_weights !== undefined) models = models.filter((m) => m.open_weights === open_weights)
        if (domain) models = models.filter((m) => m.domains?.includes(domain))
        if (limit) models = models.slice(0, limit)
        return out(`${models.length} models`, models)
      },
    }),

    opentype_get_run: tool({
      description: "Fetch a run (decision or verdict) by id, e.g. one that returned pending. Read-only.",
      args: { run_id: z.string() },
      async execute({ run_id }) {
        return out(`run ${run_id}`, await call("GET", `/v1/runs/${encodeURIComponent(run_id)}`))
      },
    }),

    opentype_usage: tool({
      description: "OpenType spend and run counts for a window (default: last 30 days UTC), optionally with the remaining quota. Read-only.",
      args: {
        start_at: z.string().optional().describe("RFC 3339"),
        end_at: z.string().optional().describe("RFC 3339"),
        include_quota: z.boolean().optional(),
      },
      async execute({ start_at, end_at, include_quota }) {
        const end = end_at ?? new Date().toISOString()
        const start = start_at ?? new Date(Date.parse(end) - 30 * 864e5).toISOString()
        const usage = await call("GET", `/v1/usage?${new URLSearchParams({ start_at: start, end_at: end })}`)
        const quota = include_quota ? await call("GET", "/v1/quota") : undefined
        return out("usage", drop({ usage, quota }))
      },
    }),
  }
}

export const OpenTypePlugin: Plugin = async (_input, options?: PluginOptions) => ({
  tool: createTools((options ?? {}) as OpenTypeOptions),
})

export default OpenTypePlugin
