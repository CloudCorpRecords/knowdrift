# BUILD REPORT — knowdrift

## Summary

Clean-room rebuild of the Driflyte remote MCP surface as a forwarding
client. Built entirely in `builds/knowdrift/`; no other directory touched.
Tools are registered through the MCP SDK low-level `Server` API so the
served `tools/list` literals match the fixture exactly.

## Fixture conflicts

None. The fixture (`driflyte-tools-original.json`), the spec prose, and
this brief agree on both tool names, the `search` required fields
(`topics`, `query`), and the `topK` schema (number, default 10,
minimum 1, maximum 30). The fixture carries no `title` fields, so none
are served.

## Surface

- Tool count: 2 — `list-topics` (no inputs) and `search`
  (required `topics` + `query`, optional `topK`).
- Forwarding: each `tools/call` opens a streamable-HTTP JSON-RPC
  session against the upstream (`initialize` →
  `notifications/initialized` → `tools/call`), honours
  `Mcp-Session-Id` when the upstream issues one, passes the upstream
  result through verbatim, and surfaces failures as isError results
  whose text starts with `knowdrift error:`.
- Upstream: `https://mcp.driflyte.com/mcp`, overridable via the
  `DRIFLYTE_MCP_URL` environment variable (labelled reconstruction).
- All network access goes through an injectable fetch; tests use a
  stubbed JSON-RPC upstream only. No live network call was made or
  claimed anywhere.

## Verification (all run in the build directory)

- `npx tsc --noEmit` — exit 0.
- `npm run build` — exit 0; real `dist/` emitted and verified
  non-empty (`dist/cli.js` 2139 bytes, `dist/knowdrift.js` 10686
  bytes, plus `mcp.js`, `index.js`, `types.js` and declarations).
- `node dist/cli.js --version` — prints `0.1.0`, exit 0.
- `npm test` — 28 tests, 28 pass, 0 fail. Coverage: forwarding order
  and argument pass-through, session-id handling (issued and absent),
  verbatim result pass-through, SSE-framed responses, upstream
  JSON-RPC / HTTP / transport failures, missing and invalid argument
  rejection with no upstream contact, RPC body parsing, a
  registration-integrity check (both the core literals and the live
  server's `tools/list` deep-equal the fixture's 2 tools), and CLI
  cases (`--version`, unknown command exit 2, bad JSON exit 2,
  `mcp extra` exit 2, malformed search exit 1).
- Parity: `parity.py` against the fixture with
  `stdio:node dist/cli.js mcp` — **PASS, parity 100.0**
  (2/2 tools identical, no missing, no extra, no schema diffs).
  Report at `parity-out/parity.json`.
- `server.json`: description is exactly the pinned 90-character
  string; npm entry carries `"version": "0.1.0"`; OCI entry
  `ghcr.io/cloudcorprecords/knowdrift:0.1.0` carries no `version`
  field (verified programmatically).

## Lockfile

Route 3, clean from birth: generated in a temp directory containing
only the new `package.json` via
`npm install --package-lock-only --ignore-scripts --offline`.
Verified after placement: parses, `name` is
`@reneturcios/knowdrift`, **128 package entries**. Dependencies were
then installed in the build directory with
`npm install --offline --ignore-scripts`.

## Write-guard / fallback notes

No fallback was needed. No EPERM, zeroed files, or startup failures
occurred in this lineage; the build and test suite ran directly in
the build directory against its own freshly installed
`node_modules` (no sibling symlink, no /tmp staging copy).
