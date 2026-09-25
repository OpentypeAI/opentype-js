/**
 * Vercel AI SDK tools (`ai` package), with zod input schemas.
 *
 * ```ts
 * import { generateText } from "ai";
 * import { openTypeTools } from "@opentype/sdk/tools/vercel";
 * await generateText({ model, prompt, tools: openTypeTools() });
 * ```
 */
import { jsonSchema, tool, type Tool } from "ai";
import * as z from "zod";
import { lazyClient, runTool, tools, type ClientSource, type ToolName } from "./index.js";

type FromJSONSchema = (schema: unknown) => z.ZodType;

/** The zod schema for a tool's input, converted from the shared JSON Schema. */
export function zodInputSchema(name: ToolName): z.ZodType {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  const from = (z as unknown as { fromJSONSchema?: FromJSONSchema }).fromJSONSchema;
  if (!from) throw new Error("zod >= 4.2 is required for zodInputSchema (z.fromJSONSchema)");
  return from(t.inputSchema);
}

export function openTypeTools(source?: ClientSource) {
  const client = lazyClient(source);
  const hasZod = typeof (z as unknown as { fromJSONSchema?: unknown }).fromJSONSchema === "function";
  const out = {} as Record<ToolName, Tool>;
  for (const t of tools) {
    out[t.name] = tool({
      description: t.description,
      // zod when available (validated by the AI SDK), the raw JSON Schema otherwise.
      inputSchema: hasZod ? (zodInputSchema(t.name) as z.ZodType<unknown>) : jsonSchema<unknown>(t.inputSchema as never),
      execute: async (args: unknown): Promise<unknown> => {
        const r = await runTool(client, t.name, args);
        return r.isError ? { error: r.text, ...(r.data as object) } : { summary: r.text, result: r.data };
      },
    }) as Tool;
  }
  return out;
}
