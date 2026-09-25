#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./index.js";

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const server = createServer();
await server.connect(new StdioServerTransport());
// stdout carries the protocol; diagnostics go to stderr only.
if (!process.env.OPENTYPE_API_KEY) {
  console.error("opentype-mcp: OPENTYPE_API_KEY is not set; tools will report how to set it when called.");
}
