import {
  APIConnectionError,
  OpenTypeError,
  RunPendingError,
  TimeoutError,
  errorFromResponse,
  parseRetryAfter,
} from "./errors.js";

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://api.opentype.dev";
/** Above the 120 s maximum `deadline_ms`, so a slow run is not cut off client-side. */
export const DEFAULT_TIMEOUT_MS = 170_000;
export const DEFAULT_MAX_RETRIES = 2;
export const KEYS_URL = "https://console.opentype.dev/keys";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Defaults to `process.env.OPENTYPE_API_KEY`. */
  apiKey?: string | undefined;
  /** Defaults to `process.env.OPENTYPE_BASE_URL`, then `https://api.opentype.dev`. */
  baseURL?: string | undefined;
  /** Per-attempt timeout in ms. Default 170 000: a 256k-token decision may take up to 150 s server-side. */
  timeout?: number | undefined;
  /** Retries after the first attempt, for network errors and 5xx. Default 2. */
  maxRetries?: number | undefined;
  /** A `fetch` implementation; defaults to the global one. */
  fetch?: Fetch | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  /**
   * Statuses below 500 the client may also retry, e.g. `[429]`. Off by default:
   * a 4xx (402 and 429 included) is never retried unless listed here.
   */
  retryStatuses?: number[] | undefined;
  /** First backoff step in ms (1 s, 2 s, 4 s, ... with full jitter). Default 1000. */
  initialRetryDelay?: number | undefined;
  /** Largest backoff step in ms. Default 8000. */
  maxRetryDelay?: number | undefined;
}

export interface RequestOptions {
  /** Aborts the request; an abort is never retried. */
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
  maxRetries?: number | undefined;
  headers?: Record<string, string> | undefined;
}

export interface CreateOptions extends RequestOptions {
  /** Reused on a network error; a 5xx retry sends `<key>:r1`, `<key>:r2`, ... Default: a random UUID per call. */
  idempotencyKey?: string | undefined;
}

export interface FinalRequest {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null> | undefined;
  body?: unknown;
  /** Send an `Idempotency-Key` header and apply the create retry rules. */
  idempotent?: boolean;
  /** Return the raw `Response` (for SSE) instead of parsed JSON. */
  raw?: boolean;
  /** Throw `RunPendingError` on `202`. */
  pendingIsError?: boolean;
  /**
   * Allow retries on a POST that is not `idempotent`. GET, PUT and DELETE are
   * always retryable; a plain POST (checkout, rotate) is not, so a lost
   * response never rotates a key twice.
   */
  retryable?: boolean;
  options?: CreateOptions | undefined;
}

/** Response objects carry the `x-request-id` of the call that produced them. */
export type WithRequestId<T> = T & { readonly _requestId: string | null };

function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const v = p?.env?.[name];
  return v === "" ? undefined : v;
}

function randomKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // ponytail: Math.random fallback for runtimes without Web Crypto; fine for idempotency keys, not secrets.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function attachRequestId<T>(value: T, requestId: string | null): WithRequestId<T> {
  if (value && typeof value === "object") {
    Object.defineProperty(value, "_requestId", { value: requestId, enumerable: false, configurable: true });
  }
  return value as WithRequestId<T>;
}

export class Core {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  private readonly customFetch: Fetch | undefined;
  private readonly defaultHeaders: Record<string, string>;
  private readonly retryStatuses: Set<number>;
  private readonly initialRetryDelay: number;
  private readonly maxRetryDelay: number;

  constructor(opts: ClientOptions = {}) {
    const apiKey = opts.apiKey ?? env("OPENTYPE_API_KEY");
    if (!apiKey) {
      throw new OpenTypeError({
        code: "missing_api_key",
        message: `No OpenType API key. Set the OPENTYPE_API_KEY environment variable or pass { apiKey }. Create a key at ${KEYS_URL}`,
      });
    }
    this.apiKey = apiKey;
    this.baseURL = (opts.baseURL ?? env("OPENTYPE_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!opts.fetch && typeof globalThis.fetch !== "function") {
      throw new OpenTypeError({ code: "missing_fetch", message: "No global fetch; pass { fetch }." });
    }
    this.customFetch = opts.fetch;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.retryStatuses = new Set(opts.retryStatuses ?? []);
    this.initialRetryDelay = opts.initialRetryDelay ?? 1000;
    this.maxRetryDelay = opts.maxRetryDelay ?? 8000;
  }

  private backoff(attempt: number, retryAfter: number | undefined): number {
    if (retryAfter !== undefined) return retryAfter * 1000;
    const step = Math.min(this.maxRetryDelay, this.initialRetryDelay * 2 ** attempt);
    return Math.random() * step; // full jitter
  }

  private shouldRetryStatus(status: number): boolean {
    return status >= 500 || this.retryStatuses.has(status);
  }

  private url(path: string, query: FinalRequest["query"]): string {
    const u = new URL(this.baseURL + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T>(req: FinalRequest): Promise<T> {
    const o = req.options ?? {};
    const safe = req.method !== "POST" && req.method !== "PATCH";
    const maxRetries = safe || req.idempotent || req.retryable ? (o.maxRetries ?? this.maxRetries) : 0;
    const timeout = o.timeout ?? this.timeout;
    const baseKey = req.idempotent ? (o.idempotencyKey ?? randomKey()) : undefined;
    let keySuffix = 0; // bumped only after a 5xx: that key's stored run will not run again
    const url = this.url(req.path, req.query);

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: req.raw ? "text/event-stream" : "application/json",
        "User-Agent": `opentype-sdk-ts/${VERSION}`,
        ...this.defaultHeaders,
        ...o.headers,
      };
      if (req.body !== undefined) headers["Content-Type"] = "application/json";
      if (baseKey) headers["Idempotency-Key"] = keySuffix === 0 ? baseKey : `${baseKey}:r${keySuffix}`;

      const timeoutCtl = new AbortController();
      const timer = setTimeout(() => timeoutCtl.abort(), timeout);
      const onCallerAbort = () => timeoutCtl.abort();
      o.signal?.addEventListener("abort", onCallerAbort, { once: true });

      let res: Response;
      try {
        // The global is read per call, so a fetch patched after construction (tests, tracing) is honoured.
        res = await (this.customFetch ?? (globalThis.fetch as Fetch))(url, {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: timeoutCtl.signal,
        });
      } catch (cause) {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onCallerAbort);
        if (o.signal?.aborted) throw o.signal.reason ?? cause;
        const timedOut = timeoutCtl.signal.aborted;
        const err = timedOut
          ? new TimeoutError({ code: "timeout", message: `Request timed out after ${timeout} ms`, cause })
          : new APIConnectionError({ code: "connection_error", message: `Connection error: ${String((cause as Error)?.message ?? cause)}`, cause });
        if (attempt >= maxRetries) throw err;
        // No response: the run may exist, so the same key is reused.
        await sleep(this.backoff(attempt, undefined), o.signal);
        continue;
      }
      if (!req.raw) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onCallerAbort);
      const requestId = res.headers.get("x-request-id");

      if (res.ok) {
        if (req.raw) {
          clearTimeout(timer);
          return res as T;
        }
        const text = await res.text();
        const data = text ? (JSON.parse(text) as T) : (undefined as T);
        if (res.status === 202 && req.pendingIsError) {
          throw new RunPendingError({
            status: 202,
            code: "run_pending",
            message:
              "A run stored under this Idempotency-Key is still pending. Replaying the key keeps answering 202; retry with a new key or read the run later.",
            requestId,
            headers: res.headers,
            run: attachRequestId(data, requestId),
          });
        }
        return attachRequestId(data, requestId) as T;
      }

      clearTimeout(timer);
      const err = errorFromResponse(res.status, res.headers, await res.text());
      if (attempt >= maxRetries || !this.shouldRetryStatus(res.status)) throw err;
      if (res.status >= 500) keySuffix++;
      await sleep(this.backoff(attempt, parseRetryAfter(res.headers.get("retry-after"))), o.signal);
    }
  }
}
