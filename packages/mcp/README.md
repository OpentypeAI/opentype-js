# @opentype/mcp

MCP server for [OpenType](https://opentype.dev). Gives coding agents calibrated probabilities, schema-validated JSON and model routing, served by Neon 1.1.

| Tool | Use it when | Cost |
| --- | --- | --- |
| `opentype_decide` | a yes/no, pick-one or rating judgement you want as a probability | credit |
| `opentype_verdict` | structured extraction that must match a JSON Schema | credit |
| `opentype_route_model` | choosing which LLM should handle a task: task type, pick, estimated cost and latency, strengths | credit |
| `opentype_list_models` | browsing the model catalog, or the router's task types with `task_types: true` | free, read-only |
| `opentype_get_run` | re-reading a run | free, read-only |
| `opentype_usage` | checking spend and quota | free, read-only |

Not on npm yet. Until the first release, build [OpentypeAI/opentype-js](https://github.com/OpentypeAI/opentype-js#install) and replace `npx -y @opentype/mcp` below with `node /path/to/opentype-js/packages/mcp/dist/bin.js`.

Create a key at https://console.opentype.dev/keys (scopes `runs_write`, `runs_read`, `usage_read`). The server starts without a key and lists its tools; a tool call then explains how to set `OPENTYPE_API_KEY`. `OPENTYPE_BASE_URL` overrides the API URL.

### Routing

`opentype_route_model` takes `prompt` or `messages`, plus optional `policy` (`balanced`, `cost_efficient`, `capability_heavy`, `domain_skills`), `task_type` (skip classification; ids from `opentype_list_models` with `task_types: true`), `latency` (`interactive`, `standard`, `batch`), `max_latency_ms`, `weights` (`{quality, cost, speed}`, `balanced` only) and `models` filters. Its text reply reads:

```
Use m1 (Model One, p1). Best balance of quality, cost and latency for code generation.
Task type: code_generation (coding, 72.0%; also code_review 15.0%). Difficulty: standard. Policy: balanced.
Pick: quality 0.82, est. $0.0042, ~6.3 s.
Strengths: SWE-bench Verified, LiveCodeBench.
Weaknesses: Aider Polyglot.
Top: m1 (q 0.82, $0.0042, 6.3 s)
```

The full response is in `structuredContent`.

## Claude Code

```sh
claude mcp add opentype -e OPENTYPE_API_KEY=otsk_... -- npx -y @opentype/mcp
# for every project:
claude mcp add opentype --scope user -e OPENTYPE_API_KEY=otsk_... -- npx -y @opentype/mcp
```

## Codex

```sh
codex mcp add opentype --env OPENTYPE_API_KEY=otsk_... -- npx -y @opentype/mcp
```

or `~/.codex/config.toml`:

```toml
[mcp_servers.opentype]
command = "npx"
args = ["-y", "@opentype/mcp"]
env = { OPENTYPE_API_KEY = "otsk_..." }
startup_timeout_sec = 30
tool_timeout_sec = 180   # a long decision may take up to 150 s
```

## OpenCode

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "opentype": {
      "type": "local",
      "command": ["npx", "-y", "@opentype/mcp"],
      "environment": { "OPENTYPE_API_KEY": "{env:OPENTYPE_API_KEY}" },
      "enabled": true
    }
  }
}
```

## Cursor

`.cursor/mcp.json` (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "opentype": {
      "command": "npx",
      "args": ["-y", "@opentype/mcp"],
      "env": { "OPENTYPE_API_KEY": "otsk_..." }
    }
  }
}
```

## VS Code

`.vscode/mcp.json`:

```json
{
  "inputs": [
    { "type": "promptString", "id": "opentype-key", "description": "OpenType API key", "password": true }
  ],
  "servers": {
    "opentype": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@opentype/mcp"],
      "env": { "OPENTYPE_API_KEY": "${input:opentype-key}" }
    }
  }
}
```

## Agent guidance

Add to `AGENTS.md` or `CLAUDE.md`:

> Before picking a model for a sub-task, call `opentype_route_model` with the task and a policy. For any yes/no, pick-one or rating judgement you would otherwise eyeball, call `opentype_decide` and act on the probability. Pass a stable `idempotency_key` when retrying.

## Programmatic use

```ts
import { createServer } from "@opentype/mcp";
const server = createServer({ client: new OpenType({ apiKey }) });
```

Tool results carry a short text summary plus the raw API JSON in `structuredContent`.
