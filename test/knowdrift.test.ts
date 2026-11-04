import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  callTool,
  parseRpcBody,
  TOOL_DEFS,
  validateArgs,
  VERSION,
} from "../src/knowdrift.js";
import type { FetchFn, FetchResponseLike, ToolResult } from "../src/types.js";

/* ------------------------------------------------------------------ */
/* Stubbed JSON-RPC upstream                                           */
/* ------------------------------------------------------------------ */

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface StubOptions {
  sessionId?: string | null;
  callResult?: unknown;
  callError?: { code: number; message: string };
  callHttpStatus?: number;
  callBody?: string;
  initHttpStatus?: number;
  throwOn?: string;
}

const SEARCH_RESULT = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        documents: [
          { content: "Vector stores index embeddings.", metadata: { url: "https://example.test/v" }, score: 0.91 },
        ],
      }),
    },
  ],
};

const TOPICS_RESULT = {
  content: [
    { type: "text", text: JSON.stringify({ topics: ["technology", "science"] }) },
  ],
};

function makeResponse(status: number, body: string, sessionId?: string | null): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "mcp-session-id") return sessionId ?? null;
        return null;
      },
    },
    text: async () => body,
  };
}

function stubUpstream(options: StubOptions = {}) {
  const requests: RecordedRequest[] = [];
  const sessionId = options.sessionId === undefined ? "sess-abc-123" : options.sessionId;
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    requests.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("connection refused by stub");
    if (method === "initialize") {
      const status = options.initHttpStatus ?? 200;
      return makeResponse(
        status,
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "upstream", version: "9.9.9" },
          },
        }),
        sessionId,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "", sessionId);
    }
    if (method === "tools/call") {
      if (options.callHttpStatus !== undefined) {
        return makeResponse(options.callHttpStatus, "upstream exploded", sessionId);
      }
      if (options.callBody !== undefined) {
        return makeResponse(200, options.callBody, sessionId);
      }
      if (options.callError) {
        return makeResponse(
          200,
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: options.callError }),
          sessionId,
        );
      }
      const params = body.params as { name: string };
      const result =
        options.callResult ??
        (params.name === "list-topics" ? TOPICS_RESULT : SEARCH_RESULT);
      return makeResponse(
        200,
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        sessionId,
      );
    }
    return makeResponse(404, "unknown method", sessionId);
  };
  return { fetchFn, requests };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0]?.text ?? "";
}

const GOOD_SEARCH = { topics: ["technology"], query: "How do vector databases work?" };

/* ------------------------------------------------------------------ */
/* Forwarding behaviour                                                */
/* ------------------------------------------------------------------ */

describe("forwarding", () => {
  it("list-topics runs initialize, initialized, tools/call in order", async () => {
    const { fetchFn, requests } = stubUpstream();
    const result = await callTool("list-topics", {}, { fetchFn });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      requests.map((r) => r.body.method),
      ["initialize", "notifications/initialized", "tools/call"],
    );
    const callParams = requests[2].body.params as { name: string; arguments: unknown };
    assert.equal(callParams.name, "list-topics");
    assert.deepEqual(callParams.arguments, {});
  });

  it("passes the upstream result through verbatim", async () => {
    const { fetchFn } = stubUpstream();
    const topics = await callTool("list-topics", {}, { fetchFn });
    assert.deepEqual(topics, TOPICS_RESULT);
    const search = await callTool("search", GOOD_SEARCH, { fetchFn });
    assert.deepEqual(search, SEARCH_RESULT);
  });

  it("forwards search arguments verbatim, including topK", async () => {
    const { fetchFn, requests } = stubUpstream();
    const args = { topics: ["science", "technology"], query: "dark matter?", topK: 3 };
    await callTool("search", args, { fetchFn });
    const callParams = requests[2].body.params as { name: string; arguments: unknown };
    assert.equal(callParams.name, "search");
    assert.deepEqual(callParams.arguments, args);
  });

  it("honours the Mcp-Session-Id issued at initialize", async () => {
    const { fetchFn, requests } = stubUpstream({ sessionId: "sess-xyz-789" });
    await callTool("list-topics", {}, { fetchFn });
    assert.equal(requests[0].headers["mcp-session-id"], undefined);
    assert.equal(requests[1].headers["mcp-session-id"], "sess-xyz-789");
    assert.equal(requests[2].headers["mcp-session-id"], "sess-xyz-789");
  });

  it("works when the upstream issues no session id", async () => {
    const { fetchFn, requests } = stubUpstream({ sessionId: null });
    const result = await callTool("list-topics", {}, { fetchFn });
    assert.deepEqual(result, TOPICS_RESULT);
    assert.equal(requests[2].headers["mcp-session-id"], undefined);
  });

  it("uses DRIFLYTE_MCP_URL from the environment as the upstream", async () => {
    const { fetchFn, requests } = stubUpstream();
    await callTool("list-topics", {}, {
      fetchFn,
      env: { DRIFLYTE_MCP_URL: "https://example.test/custom-mcp" },
    });
    assert.equal(requests[0].url, "https://example.test/custom-mcp");
  });

  it("defaults to the pinned public upstream URL", async () => {
    const { fetchFn, requests } = stubUpstream();
    await callTool("list-topics", {}, { fetchFn, env: {} });
    assert.equal(requests[0].url, "https://mcp.driflyte.com/mcp");
  });

  it("sends the initialize handshake with this client's identity", async () => {
    const { fetchFn, requests } = stubUpstream();
    await callTool("list-topics", {}, { fetchFn });
    const params = requests[0].body.params as {
      protocolVersion: string;
      clientInfo: { name: string; version: string };
    };
    assert.equal(params.protocolVersion, "2024-11-05");
    assert.equal(params.clientInfo.name, "knowdrift");
    assert.equal(params.clientInfo.version, VERSION);
  });

  it("accepts an SSE-framed tools/call response", async () => {
    const sse =
      "event: message\n" +
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: SEARCH_RESULT })}\n\n`;
    const { fetchFn } = stubUpstream({ callBody: sse });
    const result = await callTool("search", GOOD_SEARCH, { fetchFn });
    assert.deepEqual(result, SEARCH_RESULT);
  });
});

/* ------------------------------------------------------------------ */
/* Failure handling                                                    */
/* ------------------------------------------------------------------ */

describe("failures", () => {
  it("surfaces an upstream JSON-RPC error as a knowdrift error", async () => {
    const { fetchFn } = stubUpstream({
      callError: { code: -32000, message: "topic index unavailable" },
    });
    const result = await callTool("search", GOOD_SEARCH, { fetchFn });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^knowdrift error: /);
    assert.match(textOf(result), /topic index unavailable/);
  });

  it("surfaces an upstream HTTP failure on tools/call", async () => {
    const { fetchFn } = stubUpstream({ callHttpStatus: 503 });
    const result = await callTool("list-topics", {}, { fetchFn });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^knowdrift error: upstream HTTP 503/);
  });

  it("surfaces an upstream HTTP failure on initialize", async () => {
    const { fetchFn } = stubUpstream({ initHttpStatus: 500 });
    const result = await callTool("list-topics", {}, { fetchFn });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /HTTP 500 on initialize/);
  });

  it("surfaces a transport failure as a knowdrift error", async () => {
    const { fetchFn } = stubUpstream({ throwOn: "initialize" });
    const result = await callTool("list-topics", {}, { fetchFn });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^knowdrift error: connection refused by stub/);
  });

  it("reports an unknown tool without contacting the upstream", async () => {
    const { fetchFn, requests } = stubUpstream();
    const result = await callTool("nope", {}, { fetchFn });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /unknown tool/);
    assert.equal(requests.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Argument validation                                                 */
/* ------------------------------------------------------------------ */

describe("argument validation", () => {
  it("rejects a search with no query before any request is made", async () => {
    const { fetchFn, requests } = stubUpstream();
    const result = await callTool("search", { topics: ["technology"] }, { fetchFn });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /query/);
    assert.equal(requests.length, 0);
  });

  it("rejects a search with no topics", async () => {
    const { fetchFn, requests } = stubUpstream();
    const result = await callTool("search", { query: "anything" }, { fetchFn });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /topics/);
    assert.equal(requests.length, 0);
  });

  it("rejects an empty topics array and non-string topics", () => {
    assert.match(validateArgs("search", { topics: [], query: "q" }) ?? "", /topics/);
    assert.match(validateArgs("search", { topics: [42], query: "q" }) ?? "", /topics/);
    assert.match(validateArgs("search", { topics: "science", query: "q" }) ?? "", /topics/);
  });

  it("rejects topK outside 1..30 and non-number topK", () => {
    assert.match(validateArgs("search", { ...GOOD_SEARCH, topK: 0 }) ?? "", /topK/);
    assert.match(validateArgs("search", { ...GOOD_SEARCH, topK: 31 }) ?? "", /topK/);
    assert.match(validateArgs("search", { ...GOOD_SEARCH, topK: "5" }) ?? "", /topK/);
  });

  it("accepts boundary topK values and a search without topK", () => {
    assert.equal(validateArgs("search", { ...GOOD_SEARCH, topK: 1 }), null);
    assert.equal(validateArgs("search", { ...GOOD_SEARCH, topK: 30 }), null);
    assert.equal(validateArgs("search", GOOD_SEARCH), null);
    assert.equal(validateArgs("list-topics", {}), null);
  });
});

/* ------------------------------------------------------------------ */
/* RPC body parsing                                                    */
/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses a plain JSON body and picks the matching id", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    assert.deepEqual(parseRpcBody(body, 2)?.result, { ok: true });
  });

  it("returns null for an empty body", () => {
    assert.equal(parseRpcBody("", 1), null);
    assert.equal(parseRpcBody("   ", 1), null);
  });
});

/* ------------------------------------------------------------------ */
/* Registration integrity                                              */
/* ------------------------------------------------------------------ */

describe("registration integrity", () => {
  it("served tools/list deep-equals the fixture's 2 tools", (t) => {
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "harness",
      "fixtures",
      "driflyte-tools-original.json",
    );
    if (!existsSync(fixturePath)) {
      t.skip("parity fixture lives in the build harness, not the repo tree");
      return;
    }
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      tools: unknown[];
    };
    assert.equal(fixture.tools.length, 2);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it(
    "the live MCP server's tools/list deep-equals the fixture",
    { timeout: 30000 },
    async (t) => {
      const root = join(dirname(fileURLToPath(import.meta.url)), "..");
      const fixturePath = join(
        root,
        "..",
        "..",
        "harness",
        "fixtures",
        "driflyte-tools-original.json",
      );
      if (!existsSync(fixturePath)) {
        t.skip("parity fixture lives in the build harness, not the repo tree");
        return;
      }
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        tools: unknown[];
      };
      const proc = spawn(join(root, "node_modules", ".bin", "tsx"), ["src/cli.ts", "mcp"], {
        cwd: root,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        const responses = new Map<number, Record<string, unknown>>();
        let buffer = "";
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          let idx = buffer.indexOf("\n");
          while (idx !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf("\n");
            if (line === "") continue;
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (typeof msg.id === "number") responses.set(msg.id, msg);
            } catch {
              // ignore non-JSON noise
            }
          }
        });
        const send = (obj: unknown) => proc.stdin.write(`${JSON.stringify(obj)}\n`);
        const waitFor = async (id: number) => {
          for (let i = 0; i < 200; i++) {
            if (responses.has(id)) return responses.get(id) as Record<string, unknown>;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error(`no response for id ${id}`);
        };
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        });
        const initResponse = await waitFor(1);
        const initResult = initResponse.result as { serverInfo: { name: string } };
        assert.equal(initResult.serverInfo.name, "knowdrift");
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const listResponse = await waitFor(2);
        const listResult = listResponse.result as { tools: unknown[] };
        assert.deepEqual(listResult.tools, fixture.tools);
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "search", arguments: { topics: ["technology"] } },
        });
        const callResponse = await waitFor(3);
        const error = callResponse.error as { code: number; message: string };
        assert.equal(error.code, -32602);
        assert.match(error.message, /query/);
      } finally {
        proc.kill();
      }
    },
  );
});

/* ------------------------------------------------------------------ */
/* CLI (spawned from source via tsx)                                   */
/* ------------------------------------------------------------------ */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function runCli(args: string[]) {
  return spawnSync(join(root, "node_modules", ".bin", "tsx"), ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
  });
}

describe("CLI", () => {
  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown subcommand prints usage and exits 2", () => {
    const res = runCli(["not-a-command"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument string exits 2", () => {
    const res = runCli(["search", "not json"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a malformed-args search exits 1 naming the missing field, with no network", () => {
    const res = runCli(["search", '{"topics":["technology"]}']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /query/);
  });
});
