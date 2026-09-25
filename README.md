# OpenType for JavaScript and TypeScript

Official JavaScript packages for [OpenType](https://opentype.dev): calibrated decisions, schema-validated verdicts and model routing, served by Neon 1.1.

| Package | What it is |
| --- | --- |
| [`@opentype/sdk`](packages/sdk) | TypeScript client for the OpenType API, with tool adapters for the AI SDK, OpenAI and Anthropic |
| [`@opentype/mcp`](packages/mcp) | MCP server that gives coding agents (Claude Code, Codex, Cursor, VS Code, OpenCode) the same tools |
| [`@opentype/opencode-plugin`](packages/opencode-plugin) | Native OpenCode plugin |

Docs: https://docs.opentype.dev

## Install

The packages are not on npm yet. Until the first release, build them from this repository and
install the packed tarballs (Node 18 or later, pnpm 10):

```sh
git clone https://github.com/OpentypeAI/opentype-js
cd opentype-js
pnpm install && pnpm build
(cd packages/sdk && pnpm pack --pack-destination ../../dist)
(cd packages/mcp && pnpm pack --pack-destination ../../dist)

# in your project
npm install /path/to/opentype-js/dist/opentype-sdk-0.1.0.tgz
```

Once released, this becomes `npm install @opentype/sdk`.

## Quickstart

Create a key at https://console.opentype.dev/keys and export it:

```sh
export OPENTYPE_API_KEY=otsk_...
```

```ts
import { OpenType } from "@opentype/sdk";

const ot = new OpenType(); // reads OPENTYPE_API_KEY

const d = await ot.decide({
  prompt: "Refund me today or I dispute the charge.",
  question: "Is the customer threatening to escalate?",
});
console.log(d.answer); // { type: "noul", probability: 0.93 }
```

MCP server for a coding agent:

```sh
# until the npm release, point at the local build:
claude mcp add opentype -e OPENTYPE_API_KEY=otsk_... -- node /path/to/opentype-js/packages/mcp/dist/bin.js
# after the release:
claude mcp add opentype -e OPENTYPE_API_KEY=otsk_... -- npx -y @opentype/mcp
```

The Claude Code plugin lives in [OpentypeAI/opentype-claude-plugin](https://github.com/OpentypeAI/opentype-claude-plugin). The Python SDK lives in [OpentypeAI/opentype-python](https://github.com/OpentypeAI/opentype-python).

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:stdio   # starts the built MCP server over stdio and checks its tool list
pnpm test:plugin  # OpenCode plugin (Node >= 22.6)
```

`openapi.json` is a copy of the API contract; `pnpm generate` regenerates `packages/sdk/src/generated/schema.ts` from it.

## Releasing

`.github/workflows/release.yml` publishes all three packages to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, `npm publish --provenance`) when a `v*` tag is pushed. **It is inert until the owner configures npm:**

1. Create the `@opentype` scope (npm organization) on npmjs.com.
2. For each of `@opentype/sdk`, `@opentype/mcp`, `@opentype/opencode-plugin`, add a trusted publisher: GitHub Actions, organization `OpentypeAI`, repository `opentype-js`, workflow `release.yml`, environment `npm`. (A package must exist before a trusted publisher can be attached; if npm requires it, do the very first publish by hand.)
3. Create the `npm` environment in this repo's settings, and set the repository variable `NPM_PUBLISH=true`.
4. Bump the three `version` fields, then `git tag v0.1.0 && git push --tags`.

## License

Apache-2.0
