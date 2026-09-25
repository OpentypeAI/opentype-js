import type { components } from "./generated/schema.js";

type S = components["schemas"];

export type CreateRunRequest = S["CreateRunRequest"];
export type Run = S["RunResponse"];
export type RunList = S["RunListResponse"];
export type RunKind = S["RunKind"];
export type RunState = S["RunStateResponse"];
export type RunMessage = S["RunMessage"];
export type DecisionQuestion = S["DecisionQuestionRequest"];
export type DecisionResult = S["DecisionResponse"];
export type RunUsage = S["RunUsageResponse"];
export type OrganizationUsage = S["OrganizationUsageResponse"];
export type DailyUsage = S["DailyUsageResponse"];
export type Ledger = S["LedgerResponse"];
export type Quota = S["QuotaResponse"];
export type Billing = S["BillingResponse"];
export type AutoRechargeRequest = S["AutoRechargeRequest"];
export type CheckoutRequest = S["CheckoutRequest"];
export type Checkout = S["CheckoutResponse"];
export type Portal = S["PortalResponse"];
export type Key = S["KeyResponse"];
export type KeyWithSecret = S["KeyWithSecretResponse"];
export type KeyList = S["KeyListResponse"];
export type CreateKeyRequest = S["CreateKeyRequest"];
export type Scope = S["Scope"];

/** The public model ids a decision may pin. */
export type NeonModel = "neon-1.1" | "neon-latest";

/** One decoded answer inside `decision.answers`. */
export type DecisionAnswer =
  | { type: "noul"; probability: number; label_mass?: number; answered_within_labels?: boolean }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
      label_mass?: number;
      answered_within_labels?: boolean;
    }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
      label_mass?: number;
      answered_within_labels?: boolean;
    }
  | { type: "skipped"; because: Record<string, unknown> };

/** A server-sent event from `GET /v1/runs/{id}/stream`. */
export type RunEvent =
  | { event: "state"; data: { run_id: string; state: RunState } }
  | {
      event: "terminal";
      data: {
        run_id: string;
        state: RunState;
        input_digest: string;
        output_digest: string | null;
        kind?: RunKind;
        verdict?: unknown;
        decision?: DecisionResult;
      };
    }
  | { event: string; data: unknown };

// Router v2, from the generated contract.
export type RouterSelectRequest = S["RouterSelectRequest"];
export type RouterSelectResponse = S["RouterSelectResponse"];
export type RouterModelFilters = S["RouterModelFilters"];
export type RouterWeights = S["RouterWeights"];
export type RouterClassification = S["RouterClassification"];
export type RouterTaskType = S["RouterTaskType"];
export type RouterFacets = S["RouterFacets"];
export type RouterLabel = S["RouterLabel"];
export type RouterRankingEntry = S["RouterRankingEntry"];
export type RouterBenchmarkContribution = S["RouterBenchmarkContribution"];
export type RouterThreshold = S["RouterThreshold"];
export type RouterModel = S["RouterCatalogModel"];
export type RouterModelsResponse = S["RouterModelsResponse"];
export type RouterTaskTypeInfo = S["RouterTaskTypeInfo"];
export type RouterTaskTypesResponse = S["RouterTaskTypesResponse"];

/** The server validates these; the unions document the current values. */
export type RouterPolicy = "balanced" | "cost_efficient" | "capability_heavy" | "domain_skills";
export type RouterLatency = "interactive" | "standard" | "batch";
export type RouterDomain =
  | "coding"
  | "math"
  | "reasoning"
  | "knowledge"
  | "agentic"
  | "long_context"
  | "writing"
  | "multilingual"
  | "general";
