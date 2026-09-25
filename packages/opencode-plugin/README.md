# OpenType for OpenCode

Two ways in. Pick one.

## A. MCP server (simplest)

Merge `opencode.json` from this folder into your `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "opentype": {
      "type": "local",
      "command": ["npx", "-y", "@opentype/mcp"],
      "environment": { "OPENTYPE_API_KEY": "{env:OPENTYPE_API_KEY}" },
      "enabled": true,
      "timeout": 150000
    }
  }
}
```

## B. Native plugin `@opentype/opencode-plugin`

The plugin registers the six OpenType tools directly in OpenCode (no MCP process, no `npx` at start-up) and ships an instructions file that tells the agent when to call each one.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opentype/opencode-plugin"],
  "instructions": ["https://raw.githubusercontent.com/OpentypeAI/opentype-js/main/packages/opencode-plugin/instructions/opentype.md"]
}
```

Or `opencode plugin @opentype/opencode-plugin`. Options can be passed with the tuple form, for example a different API base:

```json
{ "plugin": [["@opentype/opencode-plugin", { "baseUrl": "https://api.opentype.dev" }]] }
```

The key comes from `OPENTYPE_API_KEY` (or the `apiKey` option; prefer the environment so it stays out of config files). The tools register without a key and fail at call time with a clear message.

To use it from a checkout, point OpenCode at the source: drop a file in `.opencode/plugins/opentype.ts` containing
`export { OpenTypePlugin } from "/path/to/opentype-js/packages/opencode-plugin/src/index.ts"`.

### Tools

`opentype_decide`, `opentype_verdict`, `opentype_route_model`, `opentype_list_models`, `opentype_get_run`, `opentype_usage`. The first three spend credit.

### Tests

```bash
cd plugin && npm i --no-save @opencode-ai/plugin && npm test
```

## Key

Create one at https://console.opentype.dev/keys with the scopes `runs_write`, `runs_read` and `usage_read`, then `export OPENTYPE_API_KEY=otsk_...`.
