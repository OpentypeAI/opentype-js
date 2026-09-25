/**
 * OpenAI function tools. `definitions` works with Chat Completions
 * (`tools: definitions`), `responsesDefinitions` with the Responses API.
 *
 * ```ts
 * const ot = openTypeTools();
 * const res = await openai.chat.completions.create({ model, messages, tools: ot.definitions });
 * for (const call of res.choices[0].message.tool_calls ?? []) messages.push(await ot.handle(call));
 * ```
 */
import { lazyClient, runTool, tools, type ClientSource } from "./index.js";

export interface ChatToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}
export interface ResponsesToolCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export function openTypeTools(source?: ClientSource) {
  const client = lazyClient(source);
  const definitions = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  const responsesDefinitions = tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
  const parse = (s: string) => (s ? JSON.parse(s) : {});

  /** Chat Completions: returns the `role: "tool"` message to append. */
  async function handle(call: ChatToolCall) {
    const r = await runTool(client, call.function.name, parse(call.function.arguments));
    return { role: "tool" as const, tool_call_id: call.id, content: r.text };
  }
  /** Responses API: returns the `function_call_output` item to append. */
  async function handleResponse(call: ResponsesToolCall) {
    const r = await runTool(client, call.name, parse(call.arguments));
    return { type: "function_call_output" as const, call_id: call.call_id, output: r.text };
  }
  return { definitions, responsesDefinitions, handle, handleResponse };
}
