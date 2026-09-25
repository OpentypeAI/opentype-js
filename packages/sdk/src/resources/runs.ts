import type { Core, CreateOptions, RequestOptions, WithRequestId } from "../core.js";
import { DEFAULT_TIMEOUT_MS, sleep } from "../core.js";
import { TimeoutError } from "../errors.js";
import { runEvents } from "../streaming.js";
import type { CreateRunRequest, Run, RunEvent, RunList } from "../types.js";

export interface ListParams {
  /** Page size; the server clamps it. */
  limit?: number;
  offset?: number;
}

/**
 * `await` it for the first page, or `for await` it for every run across pages.
 */
export class RunPage implements PromiseLike<WithRequestId<RunList>>, AsyncIterable<Run> {
  constructor(
    private readonly fetchPage: (p: ListParams) => Promise<WithRequestId<RunList>>,
    private readonly params: ListParams,
  ) {}

  then<A = WithRequestId<RunList>, B = never>(
    onfulfilled?: ((value: WithRequestId<RunList>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.fetchPage(this.params).then(onfulfilled, onrejected);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Run> {
    let offset = this.params.offset ?? 0;
    for (;;) {
      const page = await this.fetchPage({ ...this.params, offset });
      yield* page.runs;
      const size = page.limit || this.params.limit || page.runs.length;
      if (page.runs.length === 0 || page.runs.length < size) return;
      offset += page.runs.length;
    }
  }
}

const TERMINAL = new Set(["completed", "failed"]);

export class Runs {
  constructor(private readonly core: Core) {}

  /**
   * `POST /v1/runs`. Always sends an `Idempotency-Key`. A `202` (a stored run
   * under this key is still pending) throws `RunPendingError`, carrying the run.
   */
  create(body: CreateRunRequest, options?: CreateOptions): Promise<WithRequestId<Run>> {
    return this.core.request({ method: "POST", path: "/v1/runs", body, idempotent: true, pendingIsError: true, options });
  }

  get(runId: string, options?: RequestOptions): Promise<WithRequestId<Run>> {
    return this.core.request({ method: "GET", path: `/v1/runs/${encodeURIComponent(runId)}`, options });
  }

  list(params: ListParams = {}, options?: RequestOptions): RunPage {
    return new RunPage(
      (p) => this.core.request({ method: "GET", path: "/v1/runs", query: { limit: p.limit, offset: p.offset }, options }),
      params,
    );
  }

  /** `GET /v1/runs/{id}/stream`: `state`, then `terminal` once the run is finished. No resume. */
  async *stream(runId: string, options?: RequestOptions): AsyncGenerator<RunEvent> {
    const res = await this.core.request<Response>({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(runId)}/stream`,
      raw: true,
      options,
    });
    if (!res.body) return;
    yield* runEvents(res.body);
  }

  /**
   * Poll until the run is `completed` or `failed`. `timeout` bounds the whole
   * wait, each poll included; past it, throws `TimeoutError` (code `wait_timeout`).
   */
  async waitFor(
    runId: string,
    opts: { timeout?: number; interval?: number; signal?: AbortSignal } = {},
  ): Promise<WithRequestId<Run>> {
    const deadline = Date.now() + (opts.timeout ?? DEFAULT_TIMEOUT_MS);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new TimeoutError({ code: "wait_timeout", message: `Run ${runId} did not finish within the wait timeout` });
      }
      // One attempt per poll: client retries would each get `left` again and overrun the deadline.
      const run = await this.get(runId, { signal: opts.signal, timeout: left, maxRetries: 0 });
      if (TERMINAL.has(run.state)) return run;
      await sleep(Math.min(opts.interval ?? 1000, Math.max(0, deadline - Date.now())), opts.signal);
    }
  }
}
