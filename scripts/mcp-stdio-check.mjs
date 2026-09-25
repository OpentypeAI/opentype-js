// Start the built MCP server over stdio, as an agent would, and check it lists its tools.
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const bin = fileURLToPath(new URL("../packages/mcp/dist/bin.js", import.meta.url))
const EXPECTED = ["opentype_decide", "opentype_verdict", "opentype_route_model", "opentype_list_models", "opentype_get_run", "opentype_usage"]
const client = new Client({ name: "opentype-stdio-check", version: "0.0.0" })
const env = { ...process.env }
delete env.OPENTYPE_API_KEY // the server must start and list tools without a key
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env, stderr: "pipe" }))
const names = (await client.listTools()).tools.map((t) => t.name)
await client.close()
const missing = EXPECTED.filter((n) => !names.includes(n))
console.log(`${missing.length ? "FAIL" : "PASS"} ${names.length} tools: ${names.join(", ")}`)
process.exit(missing.length ? 1 : 0)
