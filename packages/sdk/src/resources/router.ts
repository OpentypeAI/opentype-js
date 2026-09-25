import type { Core, CreateOptions, RequestOptions, WithRequestId } from "../core.js";
import type {
  RouterModelsResponse,
  RouterSelectRequest,
  RouterSelectResponse,
  RouterTaskTypesResponse,
} from "../types.js";

export class Router {
  constructor(private readonly core: Core) {}

  /**
   * Pick a model for a task. Spends one classification decision. Sends an
   * `Idempotency-Key`, so a retry after a lost response replays the stored
   * classification rather than paying for a second one.
   */
  select(body: RouterSelectRequest, options?: CreateOptions): Promise<WithRequestId<RouterSelectResponse>> {
    return this.core.request({ method: "POST", path: "/v1/router/select", body, idempotent: true, options });
  }
  /** The benchmark catalog the router scores. */
  models(options?: RequestOptions): Promise<WithRequestId<RouterModelsResponse>> {
    return this.core.request({ method: "GET", path: "/v1/router/models", options });
  }
  /** The task types the router classifies into, with each one's benchmark weights. */
  taskTypes(options?: RequestOptions): Promise<WithRequestId<RouterTaskTypesResponse>> {
    return this.core.request({ method: "GET", path: "/v1/router/task-types", options });
  }
}
