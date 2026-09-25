import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { KEYS_URL, OpenType, type ClientOptions } from "@opentype/sdk";
import { runTool, tools } from "@opentype/sdk/tools";

export const VERSION = "0.1.0";

export const MISSING_KEY_MESSAGE =
  `OPENTYPE_API_KEY is not set. Create a key at ${KEYS_URL}, then set OPENTYPE_API_KEY in this MCP server's environment ` +
  `(for Claude Code: claude mcp add opentype -e OPENTYPE_API_KEY=otsk_... -- npx -y @opentype/mcp) and restart the server.`;

export interface ServerOptions {
  /** A ready client, or a factory. Default: `new OpenType()` from the environment, created on the first tool call. */
  client?: OpenType | (() => OpenType);
  clientOptions?: ClientOptions;
  env?: Record<string, string | undefined>;
}

/**
 * Some MCP hosts send object and array arguments as JSON strings. Decode a
 * top-level string whose schema type is `object` or `array`; leave anything
 * that does not parse to that type as it came, for the API to reject.
 */
export function decodeArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const props = (tools.find((t) => t.name === name)?.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>;
  const out: Record<string, unknown> = { ...args };
  for (const [k, v] of Object.entries(args)) {
    const type = props[k]?.type;
    if (typeof v !== "string" || (type !== "object" && type !== "array")) continue;
    try {
      const parsed: unknown = JSON.parse(v);
      if (type === "array" ? Array.isArray(parsed) : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) out[k] = parsed;
    } catch {
      // not JSON: keep the string
    }
  }
  return out;
}

/**
 * Build the MCP server. Tools are always listed; a missing key is reported
 * when a tool is called, so hosts can still show what the server offers.
 */
export function createServer(opts: ServerOptions = {}): Server {
  const env = opts.env ?? process.env;
  let cached: OpenType | undefined;
  const client = (): OpenType => {
    if (typeof opts.client === "function") return opts.client();
    if (opts.client) return opts.client;
    if (!opts.clientOptions?.apiKey && !env.OPENTYPE_API_KEY) {
      throw Object.assign(new Error(MISSING_KEY_MESSAGE), { code: "missing_api_key" });
    }
    return (cached ??= new OpenType({
      apiKey: env.OPENTYPE_API_KEY,
      baseURL: env.OPENTYPE_BASE_URL,
      ...opts.clientOptions,
    }));
  };

  const server = new Server(
    { name: "opentype", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "OpenType gives calibrated probabilities (opentype_decide), schema-validated JSON (opentype_verdict) and model routing " +
        "(opentype_route_model). Use opentype_decide for any yes/no, pick-one or rating judgement and act on the probability; " +
        "call opentype_route_model before choosing a model for a sub-task. Pass a stable idempotency_key when retrying a paid call.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await runTool(client, req.params.name, decodeArguments(req.params.name, req.params.arguments ?? {}));
    return {
      content: [{ type: "text" as const, text: r.text }],
      ...(r.data && typeof r.data === "object" && !Array.isArray(r.data)
        ? { structuredContent: r.data as Record<string, unknown> }
        : {}),
      ...(r.isError ? { isError: true } : {}),
    };
  });

  return server;
}
