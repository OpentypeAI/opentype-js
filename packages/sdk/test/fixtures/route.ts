import type { RouterSelectResponse } from "../../src/types.js";

const contrib = (benchmark: string, name: string, contribution: number) => ({ benchmark, name, norm: 0.9, weight: 0.3, contribution });

export const routeResponse: RouterSelectResponse = {
  id: "rtr_1",
  run_id: "run_1",
  policy: "balanced",
  model: { id: "m1", name: "Model One", provider: "p1", open_weights: false },
  classification: {
    domain: { label: "coding", probabilities: { coding: 0.9 } },
    difficulty: { label: "medium", probabilities: { medium: 0.8 } },
    task_type: {
      label: "code_generation",
      family: "coding",
      fixed: false,
      top: [
        { task_type: "code_generation", family: "coding", probability: 0.72 },
        { task_type: "code_review", family: "coding", probability: 0.15 },
      ],
    },
    facets: {
      difficulty_expected: 1.4,
      difficulty: { label: "standard", probabilities: { standard: 0.6 } },
      output_length: { label: "medium", probabilities: { medium: 0.7 } },
      output_tokens_est: 800,
      needs_tools: 0.1,
      needs_vision: 0,
      safety_sensitive: 0,
      language: "en",
      input_tokens_est: 40,
    },
  },
  ranking: [
    {
      id: "m1",
      name: "Model One",
      provider: "p1",
      open_weights: false,
      score: 0.8,
      blended_price_per_mtok: 3,
      domain_score: 0.82,
      expected_quality: 0.82,
      uncertainty: 0,
      estimated_cost_usd: 0.0042,
      estimated_latency_ms: 6300,
      latency_estimated: false,
      strengths: [contrib("swe_bench_verified", "SWE-bench Verified", 0.3), contrib("livecodebench", "LiveCodeBench", 0.2)],
      weaknesses: [{ ...contrib("aider_polyglot", "Aider Polyglot", 0.1), gap_to_best: -0.04 }],
      imputed: [],
    },
  ],
  score_basis: "benchmarks",
  threshold: { q_star: 0.9, r: 0.85, tau: 0.765 },
  filters_applied: [],
  low_confidence: false,
  input_tokens_est: 40,
  reason: "Best balance of quality, cost and latency for code generation.",
  decision_model: "neon-1.1",
  catalog_as_of: "2026-09-01",
  benchmarks_as_of: "2026-09-01",
  replayed: false,
};

export const taskTypes = {
  benchmarks_as_of: "2026-09-01",
  families: ["coding"],
  task_types: [
    {
      id: "code_generation",
      family: "coding",
      domain: "coding",
      description: "Write new code from a spec.",
      turns: 1,
      weights: [{ benchmark: "swe_bench_verified", name: "SWE-bench Verified", weight: 0.4 }],
    },
  ],
};
