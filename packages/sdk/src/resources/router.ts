import type { Core, RequestOptions, WithRequestId } from "../core.js";
import type {
  RouterModelsResponse,
  RouterSelectRequest,
  RouterSelectResponse,
  RouterTaskTypesResponse,
} from "../types.js";

export class Router {
  constructor(private readonly core: Core) {}

  /** Pick a model for a task. Spends one classification decision. */
  select(body: RouterSelectRequest, options?: RequestOptions): Promise<WithRequestId<RouterSelectResponse>> {
    return this.core.request({ method: "POST", path: "/v1/router/select", body, retryable: true, options });
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
