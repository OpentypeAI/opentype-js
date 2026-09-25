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
  // Malformed model arguments become an error result, so every tool call still gets its answer.
  const run = async (name: string, args: string) => {
    let parsed: unknown;
    try {
      parsed = args ? JSON.parse(args) : {};
    } catch (e) {
      return `invalid_arguments: ${(e as Error).message}`;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "invalid_arguments: tool arguments must be a JSON object";
    }
    return (await runTool(client, name, parsed)).text;
  };

  /** Chat Completions: returns the `role: "tool"` message to append. */
  async function handle(call: ChatToolCall) {
    return { role: "tool" as const, tool_call_id: call.id, content: await run(call.function.name, call.function.arguments) };
  }
  /** Responses API: returns the `function_call_output` item to append. */
  async function handleResponse(call: ResponsesToolCall) {
    return { type: "function_call_output" as const, call_id: call.call_id, output: await run(call.name, call.arguments) };
  }
  return { definitions, responsesDefinitions, handle, handleResponse };
}
