import type { Core, RequestOptions, WithRequestId } from "../core.js";
import type { DailyUsage, Ledger, OrganizationUsage, Quota, RunUsage } from "../types.js";

export interface Window {
  /** RFC 3339 UTC. */
  startAt?: string;
  endAt?: string;
}

const q = (w: Window) => ({ start_at: w.startAt, end_at: w.endAt });

export class Usage {
  constructor(private readonly core: Core) {}

  summary(w: Window = {}, options?: RequestOptions): Promise<WithRequestId<OrganizationUsage>> {
    return this.core.request({ method: "GET", path: "/v1/usage", query: q(w), options });
  }
  daily(w: Window = {}, options?: RequestOptions): Promise<WithRequestId<DailyUsage>> {
    return this.core.request({ method: "GET", path: "/v1/usage/daily", query: q(w), options });
  }
  ledger(w: Window & { limit?: number } = {}, options?: RequestOptions): Promise<WithRequestId<Ledger>> {
    return this.core.request({ method: "GET", path: "/v1/usage/ledger", query: { ...q(w), limit: w.limit }, options });
  }
  run(runId: string, options?: RequestOptions): Promise<WithRequestId<RunUsage>> {
    return this.core.request({ method: "GET", path: `/v1/usage/runs/${encodeURIComponent(runId)}`, options });
  }
  quota(options?: RequestOptions): Promise<WithRequestId<Quota>> {
    return this.core.request({ method: "GET", path: "/v1/quota", options });
  }
}
