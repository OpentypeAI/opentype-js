import { Core, type ClientOptions, type CreateOptions, type RequestOptions, type WithRequestId } from "./core.js";
import { Billing } from "./resources/billing.js";
import { Keys } from "./resources/keys.js";
import { Router } from "./resources/router.js";
import { Runs } from "./resources/runs.js";
import { Usage } from "./resources/usage.js";
import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionResult,
  NeonModel,
  RouterDomain,
  RouterLatency,
  RouterModelFilters,
  RouterPolicy,
  RouterSelectResponse,
  RouterWeights,
  Run,
  RunMessage,
} from "./types.js";

/** Shorthand for a one-question decision; the question id is `answer`. */
export interface DecideShorthand {
  /** The thing being decided about (becomes `state`). */
  prompt?: unknown;
  /** Conversation turns, used as `state` when there is no `prompt`. */
  messages?: RunMessage[];
  /** What to decide, e.g. "Is this ticket urgent?". Defaults to "Decide." */
  question?: string;
  /** A closed option set: a list of names, or name -> description. Makes a `choice` question. */
  choices?: string[] | Record<string, string | null>;
  /** Ordered levels, lowest first. Makes a `score` question. */
  levels?: string[];
  /** For a yes/no question: what each side means. */
  criteria?: { true?: string | null; false?: string | null };
}

export interface DecideFull {
  /** The thing being decided about. Any JSON. */
  state: unknown;
  /** Question id -> question. */
  questions: Record<string, DecisionQuestion>;
}

export type DecideParams = (DecideShorthand | DecideFull) & {
  instructions?: string;
  /** 1..8 independent draws, averaged. */
  draws?: number;
  thinkTokens?: number;
  model?: NeonModel;
  maxOutputTokens?: number;
  deadlineMs?: number;
  questionOrder?: string[];
} & CreateOptions;

export interface Decision {
  runId: string;
  /** Answers keyed by question id. */
  answers: Record<string, DecisionAnswer>;
  /** The single answer, for the shorthand form (question id `answer`). */
  answer: DecisionAnswer | undefined;
  decision: DecisionResult | null | undefined;
  model: string | null | undefined;
  costMicros: number | null | undefined;
  replayed: boolean;
  run: WithRequestId<Run>;
}

export type VerdictParams = {
  /** Shorthand for `messages: [{ role: "user", content: prompt }]`. */
  prompt?: string;
  messages?: RunMessage[];
  system?: string;
  /** JSON Schema the document must satisfy. */
  schema: unknown;
  maxOutputTokens: number;
  deadlineMs?: number;
} & CreateOptions;

export interface Verdict<T = unknown> {
  runId: string;
  verdict: T;
  replayed: boolean;
  costMicros: number | null | undefined;
  run: WithRequestId<Run>;
}

export type RouteParams = {
  prompt?: string;
  messages?: RunMessage[];
  policy?: RouterPolicy;
  /** v1 override: route as this domain's default task type. */
  domain?: RouterDomain;
  /** Skip classification and route as this task type (see `router.taskTypes()`). Wins over `domain`. */
  taskType?: string;
  /** How much estimated latency weighs in `balanced`. Default `standard`. */
  latency?: RouterLatency;
  /** Drop models whose estimated time to the full answer exceeds this, or whose speed is unmeasured. */
  maxLatencyMs?: number;
  /** `balanced` only: your own quality/cost/speed trade-off, normalized server-side. */
  weights?: RouterWeights;
  models?: RouterModelFilters;
} & CreateOptions;

function pickOptions<T extends CreateOptions>(p: T): CreateOptions {
  return { idempotencyKey: p.idempotencyKey, signal: p.signal, timeout: p.timeout, maxRetries: p.maxRetries, headers: p.headers };
}

function shorthandQuestion(p: DecideShorthand): DecisionQuestion {
  const instructions = p.question ?? "Decide.";
  if (p.choices) {
    const criteria = Array.isArray(p.choices) ? Object.fromEntries(p.choices.map((c) => [c, null])) : p.choices;
    return { type: "choice", instructions, criteria };
  }
  if (p.levels) return { type: "score", instructions, criteria: p.levels };
  return p.criteria ? { type: "noul", instructions, criteria: p.criteria } : { type: "noul", instructions };
}

export class OpenType {
  readonly runs: Runs;
  readonly usage: Usage;
  readonly billing: Billing;
  readonly keys: Keys;
  readonly router: Router;
  /** @internal */
  readonly _core: Core;

  constructor(options: ClientOptions = {}) {
    this._core = new Core(options);
    this.runs = new Runs(this._core);
    this.usage = new Usage(this._core);
    this.billing = new Billing(this._core);
    this.keys = new Keys(this._core);
    this.router = new Router(this._core);
  }

  get baseURL(): string {
    return this._core.baseURL;
  }

  /**
   * A decision run on Neon 1.1: probabilities over a closed answer set.
   *
   * ```ts
   * const d = await ot.decide({ prompt: ticket, question: "Is this urgent?" });
   * if (d.answer?.type === "noul" && d.answer.probability > 0.8) escalate();
   * ```
   */
  async decide(params: DecideParams): Promise<Decision> {
    let state: unknown;
    let questions: Record<string, DecisionQuestion>;
    if ("questions" in params && params.questions) {
      state = (params as DecideFull).state;
      questions = params.questions;
    } else {
      const s = params as DecideShorthand;
      state = s.prompt ?? (s.messages ? { messages: s.messages } : undefined);
      if (state === undefined) throw new TypeError("decide() needs `prompt`, `messages` or `state`");
      questions = { answer: shorthandQuestion(s) };
    }
    const run = await this.runs.create(
      {
        kind: "decision",
        state,
        questions,
        instructions: params.instructions,
        draws: params.draws,
        think_tokens: params.thinkTokens,
        model: params.model,
        max_output_tokens: params.maxOutputTokens ?? 16,
        deadline_ms: params.deadlineMs,
        question_order: params.questionOrder,
      },
      pickOptions(params),
    );
    const answers = (run.decision?.answers ?? {}) as Record<string, DecisionAnswer>;
    return {
      runId: run.run_id,
      answers,
      answer: answers.answer,
      decision: run.decision,
      model: run.decision?.model,
      costMicros: run.cost_micros,
      replayed: run.replayed,
      run,
    };
  }

  /** A verdict run: one JSON document validated against your schema. */
  async verdict<T = unknown>(params: VerdictParams): Promise<Verdict<T>> {
    const messages = params.messages ?? (params.prompt !== undefined ? [{ role: "user" as const, content: params.prompt }] : undefined);
    if (!messages) throw new TypeError("verdict() needs `prompt` or `messages`");
    const run = await this.runs.create(
      {
        kind: "verdict",
        messages,
        system: params.system,
        schema: params.schema,
        max_output_tokens: params.maxOutputTokens,
        deadline_ms: params.deadlineMs,
      },
      pickOptions(params),
    );
    return { runId: run.run_id, verdict: run.verdict as T, replayed: run.replayed, costMicros: run.cost_micros, run };
  }

  /** Which model should handle this task, under a policy and filters. */
  route(params: RouteParams): Promise<WithRequestId<RouterSelectResponse>> {
    const { prompt, messages, policy, domain, taskType, latency, maxLatencyMs, weights, models, ...options } = params;
    const body = { prompt, messages, policy, domain, task_type: taskType, latency, max_latency_ms: maxLatencyMs, weights, models };
    return this.router.select(body, options);
  }
}
