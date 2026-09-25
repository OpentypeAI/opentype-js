import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  AuthenticationError,
  ConflictError,
  InsufficientCreditsError,
  InvalidRequestError,
  NotFoundError,
  OpenType,
  OpenTypeError,
  PermissionDeniedError,
  RateLimitError,
  RunPendingError,
  ServerError,
  TimeoutError,
} from "../src/index.js";
import { BASE, client, errBody, run, server, useServer } from "./helpers.js";

useServer();

/** Headers at once, then a body that never ends; aborting the signal errors the body, as fetch does. */
function stallingFetch(type: string) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        init?.signal?.addEventListener("abort", () => ctl.error(init.signal!.reason), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": type } });
  };
}

describe("configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads OPENTYPE_API_KEY and OPENTYPE_BASE_URL", async () => {
    vi.stubEnv("OPENTYPE_API_KEY", "otsk_env");
    vi.stubEnv("OPENTYPE_BASE_URL", `${BASE}/`);
    let auth = "";
    server.use(
      http.get(`${BASE}/v1/quota`, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ ok: 1 });
      }),
    );
    const ot = new OpenType();
    expect(ot.baseURL).toBe(BASE);
    await ot.usage.quota();
    expect(auth).toBe("Bearer otsk_env");
  });

  it("defaults the base URL", () => {
    expect(new OpenType({ apiKey: "k" }).baseURL).toBe("https://api.opentype.dev");
  });

  it("throws a clear error without a key", () => {
    vi.stubEnv("OPENTYPE_API_KEY", "");
    expect(() => new OpenType()).toThrow(/OPENTYPE_API_KEY.*console\.opentype\.dev\/keys/);
  });

  it("uses a custom fetch and exposes the request id", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(run()), { headers: { "x-request-id": "req_x" } }));
    const r = await new OpenType({ apiKey: "k", fetch: f }).runs.get("run_1");
    expect(f).toHaveBeenCalledOnce();
    expect(r._requestId).toBe("req_x");
    expect(Object.keys(r)).not.toContain("_requestId");
  });
});

describe("error mapping", () => {
  const cases: Array<[number, string, new (...a: never[]) => OpenTypeError]> = [
    [400, "invalid_body", InvalidRequestError],
    [413, "input_too_large", InvalidRequestError],
    [401, "invalid_credential", AuthenticationError],
    [402, "insufficient_credits", InsufficientCreditsError],
    [403, "scope_denied", PermissionDeniedError],
    [404, "run_not_found", NotFoundError],
    [409, "idempotency_conflict", ConflictError],
    [429, "organization_spend_quota_exhausted", RateLimitError],
    [500, "internal_error", ServerError],
    [503, "no_route_available", ServerError],
    [504, "deadline_exceeded", ServerError],
  ];
  for (const [status, code, cls] of cases) {
    it(`${status} ${code} -> ${cls.name}`, async () => {
      server.use(http.get(`${BASE}/v1/runs/run_1`, () => HttpResponse.json(errBody(code, "msg"), { status })));
      const e = await client({ maxRetries: 0 }).runs.get("run_1").catch((x) => x);
      expect(e).toBeInstanceOf(cls);
      expect(e).toBeInstanceOf(OpenTypeError);
      expect(e).toMatchObject({ status, code, message: "msg", requestId: "req_1" });
    });
  }

  it("carries violations", async () => {
    server.use(
      http.post(`${BASE}/v1/runs`, () =>
        HttpResponse.json(errBody("verdict_schema_violation", "bad", { violations: ["/risk/score"] }), { status: 503 }),
      ),
    );
    const e = await client({ maxRetries: 0 }).runs.create({ max_output_tokens: 1 }).catch((x) => x);
    expect(e.violations).toEqual(["/risk/score"]);
  });

  it("maps a plain-text body to http_<status> with the header id", async () => {
    server.use(
      http.get(`${BASE}/v1/runs/run_1`, () =>
        new HttpResponse("Payload Too Large", { status: 413, headers: { "x-request-id": "req_h", "content-type": "text/plain" } }),
      ),
    );
    const e = await client().runs.get("run_1").catch((x) => x);
    expect(e).toBeInstanceOf(InvalidRequestError);
    expect(e).toMatchObject({ code: "http_413", requestId: "req_h", message: "Payload Too Large" });
  });

  it("RateLimitError parses Retry-After", async () => {
    server.use(
      http.get(`${BASE}/v1/quota`, () => HttpResponse.json(errBody("q"), { status: 429, headers: { "retry-after": "7" } })),
    );
    const e = await client().usage.quota().catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.retryAfter).toBe(7);
  });

  it("network failure -> APIConnectionError", async () => {
    server.use(http.get(`${BASE}/v1/quota`, () => HttpResponse.error()));
    const e = await client({ maxRetries: 0 }).usage.quota().catch((x) => x);
    expect(e).toBeInstanceOf(APIConnectionError);
    expect(e.status).toBeUndefined();
  });

  it("timeout -> TimeoutError", async () => {
    server.use(
      http.get(`${BASE}/v1/quota`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({});
      }),
    );
    const e = await client({ maxRetries: 0, timeout: 20 }).usage.quota().catch((x) => x);
    expect(e).toBeInstanceOf(TimeoutError);
    expect(e).toBeInstanceOf(APIConnectionError);
  });
});

describe("retries and idempotency", () => {
  it("sends an automatic Idempotency-Key on create", async () => {
    let key: string | null = null;
    server.use(
      http.post(`${BASE}/v1/runs`, ({ request }) => {
        key = request.headers.get("idempotency-key");
        return HttpResponse.json(run());
      }),
    );
    await client().runs.create({ max_output_tokens: 1 });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses the caller's key", async () => {
    let key: string | null = null;
    server.use(
      http.post(`${BASE}/v1/runs`, ({ request }) => {
        key = request.headers.get("idempotency-key");
        return HttpResponse.json(run());
      }),
    );
    await client().runs.create({ max_output_tokens: 1 }, { idempotencyKey: "biz-42" });
    expect(key).toBe("biz-42");
  });

  it("reuses the same key after a network error", async () => {
    const keys: string[] = [];
    server.use(
      http.post(`${BASE}/v1/runs`, ({ request }) => {
        keys.push(request.headers.get("idempotency-key")!);
        return keys.length === 1 ? HttpResponse.error() : HttpResponse.json(run());
      }),
    );
    await client().runs.create({ max_output_tokens: 1 }, { idempotencyKey: "k1" });
    expect(keys).toEqual(["k1", "k1"]);
  });

  it("does not retry a paid create after a 5xx, which may already have been charged", async () => {
    const keys: string[] = [];
    server.use(
      http.post(`${BASE}/v1/runs`, ({ request }) => {
        keys.push(request.headers.get("idempotency-key")!);
        return HttpResponse.json(errBody("provider_unavailable"), { status: 503 });
      }),
    );
    await expect(client().runs.create({ max_output_tokens: 1 }, { idempotencyKey: "k1" })).rejects.toBeInstanceOf(ServerError);
    expect(keys).toEqual(["k1"]);
  });

  it("puts the generated key on the error so the caller can replay it", async () => {
    const keys: string[] = [];
    server.use(
      http.post(`${BASE}/v1/runs`, ({ request }) => {
        keys.push(request.headers.get("idempotency-key")!);
        return HttpResponse.json(errBody("provider_unavailable"), { status: 503 });
      }),
    );
    const e = await client().runs.create({ max_output_tokens: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(ServerError);
    expect(e.idempotencyKey).toBe(keys[0]);
  });

  it("router.select sends one Idempotency-Key and reuses it after a network error", async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.post(`${BASE}/v1/router/select`, ({ request }) => {
        keys.push(request.headers.get("idempotency-key"));
        return keys.length === 1 ? HttpResponse.error() : HttpResponse.json({ id: "rtr_1" });
      }),
    );
    await client().router.select({ prompt: "p" });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("router.select is not retried after a 5xx", async () => {
    let n = 0;
    server.use(
      http.post(`${BASE}/v1/router/select`, () => {
        n++;
        return HttpResponse.json(errBody("internal_error"), { status: 500 });
      }),
    );
    await expect(client().router.select({ prompt: "p" })).rejects.toBeInstanceOf(ServerError);
    expect(n).toBe(1);
  });

  it("gives up after maxRetries", async () => {
    let n = 0;
    server.use(
      http.get(`${BASE}/v1/runs/run_1`, () => {
        n++;
        return HttpResponse.json(errBody("internal_error"), { status: 500 });
      }),
    );
    await expect(client({ maxRetries: 3 }).runs.get("run_1")).rejects.toBeInstanceOf(ServerError);
    expect(n).toBe(4);
  });

  for (const status of [400, 402, 403, 409, 429]) {
    it(`never retries ${status} by default`, async () => {
      let n = 0;
      server.use(
        http.post(`${BASE}/v1/runs`, () => {
          n++;
          return HttpResponse.json(errBody("x"), { status });
        }),
      );
      await expect(client().runs.create({ max_output_tokens: 1 })).rejects.toBeInstanceOf(OpenTypeError);
      expect(n).toBe(1);
    });
  }

  it("retries 429 on opt-in and respects Retry-After", async () => {
    const at: number[] = [];
    server.use(
      http.get(`${BASE}/v1/quota`, () => {
        at.push(Date.now());
        return at.length === 1
          ? HttpResponse.json(errBody("q"), { status: 429, headers: { "retry-after": "0.3" } })
          : HttpResponse.json({ ok: true });
      }),
    );
    await client({ retryStatuses: [429], initialRetryDelay: 5000 }).usage.quota();
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(280);
    expect(at[1]! - at[0]!).toBeLessThan(2000);
  });

  it("backs off exponentially with jitter", async () => {
    const at: number[] = [];
    server.use(
      http.get(`${BASE}/v1/quota`, () => {
        at.push(Date.now());
        return HttpResponse.json(errBody("x"), { status: 500 });
      }),
    );
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0.999);
    await client({ maxRetries: 2, initialRetryDelay: 40 }).usage.quota().catch(() => {});
    rnd.mockRestore();
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(35);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(75);
  });

  it("surfaces a 202 pending replay as RunPendingError", async () => {
    server.use(http.post(`${BASE}/v1/runs`, () => HttpResponse.json(run({ state: "pending", replayed: true }), { status: 202 })));
    const e = await client().runs.create({ max_output_tokens: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(RunPendingError);
    expect(e.status).toBe(202);
    expect(e.run).toMatchObject({ run_id: "run_1", state: "pending", replayed: true });
    expect(e.idempotencyKey).toMatch(/.+/);
  });

  it("retries a body cut off mid-read with the same key and exposes it", async () => {
    const keys: string[] = [];
    server.use(
      http.post(`${BASE}/v1/runs`, ({ request }) => {
        keys.push(request.headers.get("idempotency-key")!);
        const body = new ReadableStream({
          start(ctl) {
            ctl.enqueue(new TextEncoder().encode('{"run_id":'));
            ctl.error(new Error("socket closed"));
          },
        });
        return new HttpResponse(body, { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const e = await client({ maxRetries: 1, initialRetryDelay: 1 }).runs.create({ max_output_tokens: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(APIConnectionError);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(e.idempotencyKey).toBe(keys[0]);
  });

  it("bounds a stalled body by the timeout", async () => {
    const ot = new OpenType({ apiKey: "otsk_test", baseURL: BASE, timeout: 50, maxRetries: 0, fetch: stallingFetch("application/json") });
    await expect(ot.usage.quota()).rejects.toBeInstanceOf(TimeoutError);
  });

  it("an invalid JSON answer to a paid call carries its key", async () => {
    server.use(http.post(`${BASE}/v1/runs`, () => new HttpResponse("<html>", { status: 200 })));
    const e = await client().runs.create({ max_output_tokens: 1 }, { idempotencyKey: "k9" }).catch((x) => x);
    expect(e).toBeInstanceOf(OpenTypeError);
    expect(e.code).toBe("invalid_response");
    expect(e.idempotencyKey).toBe("k9");
  });

  it("keeps a stream abortable after its headers arrive", async () => {
    const ot = new OpenType({ apiKey: "otsk_test", baseURL: BASE, fetch: stallingFetch("text/event-stream") });
    const ctl = new AbortController();
    const next = ot.runs.stream("run_1", { signal: ctl.signal })[Symbol.asyncIterator]().next();
    setTimeout(() => ctl.abort(new Error("stop")), 30);
    await expect(next).rejects.toBeDefined();
  });

  it("does not retry a plain POST such as key rotation", async () => {
    let n = 0;
    server.use(
      http.post(`${BASE}/v1/keys/key_1/rotate`, () => {
        n++;
        return HttpResponse.error();
      }),
    );
    await expect(client().keys.rotate("key_1")).rejects.toBeInstanceOf(APIConnectionError);
    expect(n).toBe(1);
  });

  it("an abort is not retried", async () => {
    let n = 0;
    server.use(
      http.get(`${BASE}/v1/quota`, async () => {
        n++;
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({});
      }),
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("stop")), 20);
    await expect(client().usage.quota({ signal: ac.signal })).rejects.toThrow("stop");
    expect(n).toBe(1);
  });
});
