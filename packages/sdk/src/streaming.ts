import type { RunEvent } from "./types.js";

export interface SSEMessage {
  event: string;
  data: string;
  id?: string;
}

/** Parse a `text/event-stream` byte stream into messages. Handles frames split across chunks, CRLF, comments and multi-line data. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  // The previous chunk ended in `\r`, already taken as a line end; a `\n` opening this chunk completes that CRLF.
  let skipLF = false;
  const flush = (): SSEMessage | undefined => {
    if (data.length === 0 && !event) return undefined;
    const msg: SSEMessage = { event: event || "message", data: data.join("\n") };
    if (id !== undefined) msg.id = id;
    event = "";
    data = [];
    return msg;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (skipLF && buffer) {
        if (buffer[0] === "\n") buffer = buffer.slice(1);
        skipLF = false;
      }
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, nl);
        // A standalone `\r` ends the line now; if it was half of a CRLF split across chunks, the `\n` is dropped next chunk.
        if (nl === buffer.length - 1 && buffer[nl] === "\r") skipLF = true;
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          const m = flush();
          if (m) yield m;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "event") event = val;
        else if (field === "data") data.push(val);
        else if (field === "id") id = val;
      }
      if (done) {
        if (buffer) {
          // A final line with no trailing newline.
          const colon = buffer.indexOf(":");
          if (colon !== -1 && buffer.slice(0, colon) === "data") data.push(buffer.slice(colon + 1).replace(/^ /, ""));
        }
        const m = flush();
        if (m) yield m;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** SSE messages as typed run events; `data` is parsed JSON (the raw string if it is not JSON). */
export async function* runEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEvent> {
  for await (const m of parseSSE(body)) {
    let data: unknown = m.data;
    try {
      data = JSON.parse(m.data);
    } catch {
      // keep the raw string
    }
    yield { event: m.event, data } as RunEvent;
  }
}
