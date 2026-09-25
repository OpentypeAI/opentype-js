/**
 * Anthropic Messages API tools.
 *
 * ```ts
 * const ot = openTypeTools();
 * const msg = await anthropic.messages.create({ model, max_tokens, messages, tools: ot.definitions });
 * const results = await Promise.all(msg.content.filter((b) => b.type === "tool_use").map(ot.handle));
 * messages.push({ role: "user", content: results });
 * ```
 */
import { lazyClient, runTool, tools, type ClientSource } from "./index.js";

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export function openTypeTools(source?: ClientSource) {
  const client = lazyClient(source);
  const definitions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as { type: "object"; [k: string]: unknown },
  }));
  /** Returns the `tool_result` block for a `tool_use` block. */
  async function handle(block: ToolUseBlock) {
    const r = await runTool(client, block.name, block.input);
    return {
      type: "tool_result" as const,
      tool_use_id: block.id,
      content: r.text,
      ...(r.isError ? { is_error: true } : {}),
    };
  }
  return { definitions, handle };
}
