/**
 * Errors thrown by the client. Branch on `code` (stable, from the API's
 * problem catalog) or on the class, never on `message`.
 */

export interface ErrorInit {
  status?: number | undefined;
  code: string;
  message: string;
  requestId?: string | null | undefined;
  violations?: string[] | undefined;
  headers?: Headers | undefined;
  cause?: unknown;
}

export class OpenTypeError extends Error {
  /** HTTP status, or `undefined` when no response arrived. */
  readonly status: number | undefined;
  /** Stable snake_case code, e.g. `insufficient_credits`. Plain-text bodies map to `http_<status>`. */
  readonly code: string;
  /** The `request_id` of the failed request; quote it when reporting a problem. */
  readonly requestId: string | null;
  /** JSON Pointer paths, present on `verdict_schema_violation`. */
  readonly violations: string[] | undefined;
  readonly headers: Headers | undefined;

  constructor(init: ErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.violations = init.violations;
    this.headers = init.headers;
  }
}

/** 400, 413 or 422: the request is malformed. Nothing was stored. */
export class InvalidRequestError extends OpenTypeError {}
/** 401: missing, malformed or revoked key. */
export class AuthenticationError extends OpenTypeError {}
/** 402: credits cannot cover the run. */
export class InsufficientCreditsError extends OpenTypeError {}
/** 403: the key lacks the scope this call needs. */
export class PermissionDeniedError extends OpenTypeError {}
/** 404: no such run, key or route. */
export class NotFoundError extends OpenTypeError {}
/** 409: conflicts with stored state, e.g. `idempotency_conflict`. */
export class ConflictError extends OpenTypeError {}
/** 429: an organization quota is exhausted. `retryAfter` is in seconds when the server sent one. */
export class RateLimitError extends OpenTypeError {
  readonly retryAfter: number | undefined;
  constructor(init: ErrorInit & { retryAfter?: number | undefined }) {
    super(init);
    this.retryAfter = init.retryAfter;
  }
}
/** 5xx: the service failed. */
export class ServerError extends OpenTypeError {}
/** No response: DNS, TCP, TLS or a dropped connection. */
export class APIConnectionError extends OpenTypeError {}
/** No response within `timeout`. */
export class TimeoutError extends APIConnectionError {}

/**
 * `POST /v1/runs` answered `202`: a run stored under this idempotency key is
 * still `pending`. Replaying the same key keeps answering `202`; send the
 * request again with a new key, or read the run later with `runs.get`.
 */
export class RunPendingError extends OpenTypeError {
  readonly run: unknown;
  constructor(init: ErrorInit & { run: unknown }) {
    super(init);
    this.run = init.run;
  }
}

/** Seconds from a `Retry-After` header (delta-seconds or HTTP date). */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

/** Build the error for a non-2xx response from its body text. */
export function errorFromResponse(status: number, headers: Headers, text: string): OpenTypeError {
  let code = `http_${status}`;
  let message = text.trim() || `HTTP ${status}`;
  let requestId: string | null = headers.get("x-request-id");
  let violations: string[] | undefined;
  try {
    const body = JSON.parse(text) as { error?: Record<string, unknown> };
    const e = body?.error;
    if (e && typeof e === "object") {
      if (typeof e.code === "string") code = e.code;
      if (typeof e.message === "string") message = e.message;
      if (typeof e.request_id === "string") requestId = e.request_id;
      if (Array.isArray(e.violations)) violations = e.violations.map(String);
    }
  } catch {
    // Plain-text body from the HTTP layer: keep http_<status> and the header id.
  }
  const init: ErrorInit = { status, code, message, requestId, violations, headers };
  switch (status) {
    case 400:
    case 413:
    case 422:
      return new InvalidRequestError(init);
    case 401:
      return new AuthenticationError(init);
    case 402:
      return new InsufficientCreditsError(init);
    case 403:
      return new PermissionDeniedError(init);
    case 404:
      return new NotFoundError(init);
    case 409:
      return new ConflictError(init);
    case 429:
      return new RateLimitError({ ...init, retryAfter: parseRetryAfter(headers.get("retry-after")) });
    default:
      return status >= 500 ? new ServerError(init) : new OpenTypeError(init);
  }
}
