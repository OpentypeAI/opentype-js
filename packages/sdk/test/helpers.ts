import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { OpenType, type ClientOptions } from "../src/index.js";

export const BASE = "https://api.test.opentype";
export const server = setupServer();

export function useServer() {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

export const client = (o: ClientOptions = {}) =>
  new OpenType({ apiKey: "otsk_test", baseURL: BASE, initialRetryDelay: 0, ...o });

export const errBody = (code: string, message = code, extra: Record<string, unknown> = {}) => ({
  error: { code, message, request_id: "req_1", ...extra },
});

export const run = (over: Record<string, unknown> = {}) => ({
  run_id: "run_1",
  kind: "decision",
  state: "completed",
  input_digest: "ab",
  replayed: false,
  ...over,
});
