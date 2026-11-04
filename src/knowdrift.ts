/**
 * knowdrift core: a forwarding client for a remote,
 * topic-indexed web-knowledge MCP server.
 *
 * The remote service crawls web pages and files them under
 * named topics. Two operations are exposed:
 *
 * - `list-topics` reports which topics currently hold
 *   crawled content, so a caller can discover the available
 *   subject areas before searching.
 * - `search` takes one or more of those topics plus a
 *   natural-language question and returns the best matching
 *   documents, ranked by relevance.
 *
 * Wire: calls are forwarded to a keyless public remote MCP
 * endpoint at `https://mcp.driflyte.com/mcp` using the
 * streamable-HTTP transport. Each forwarded call opens a
 * short JSON-RPC session — `initialize`, then
 * `notifications/initialized`, then `tools/call` — and
 * carries the `Mcp-Session-Id` header on the later requests
 * whenever the upstream issues one. The upstream endpoint
 * can be overridden with the `DRIFLYTE_MCP_URL` environment
 * variable (LABELLED RECONSTRUCTION: the override variable
 * name is this rebuild's own convention).
 *
 * Whatever the upstream returns for `tools/call` is handed
 * back verbatim. Transport failures, HTTP failures, and
 * JSON-RPC errors from upstream are reported as isError
 * results whose text starts with `knowdrift error:` (also a
 * labelled reconstruction — the upstream's own failure
 * wording is not pinned by its public description).
 *
 * All network access goes through an injectable fetch, so
 * the test suite runs entirely against a stubbed JSON-RPC
 * upstream and never touches the live service.
 */
import type {
  FetchFn,
  FetchResponseLike,
  KnowdriftDeps,
  ToolArgs,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_MCP_URL = "https://mcp.driflyte.com/mcp";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const PROTOCOL_VERSION = "2024-11-05";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, fixture-exact)               */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS = [
  {
    name: "list-topics",
    description:
      "Returns a list of topics for which resources (web pages, etc ...) have been crawled and content is available. This allows AI assistants to discover the most relevant and up-to-date subject areas currently indexed by the crawler.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "search",
    description:
      "Given a list of topics and a user question, this tool retrieves the top-K most relevant documents from the crawled content. It is designed to help AI assistants surface the most contextually appropriate and up-to-date information for a specific topic and query.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          description:
            "The natural language query or question for which relevant information is being sought. This will be used to rank documents by semantic relevance.",
          type: "string",
        },
        topK: {
          default: 10,
          description:
            "The maximum number of relevant documents to return. Results are sorted by descending relevance score.",
          maximum: 30,
          minimum: 1,
          type: "number",
        },
        topics: {
          description:
            "A list of one or more topic identifiers to constrain the search space. Only documents tagged with at least one of these topics will be considered.",
          items: { type: "string" },
          type: "array",
        },
      },
      required: ["topics", "query"],
    },
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/* ------------------------------------------------------------------ */
/* Argument validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Check a call's arguments for shape errors. Returns an error
 * message, or null when the arguments are well-formed. The
 * MCP layer maps a non-null return to McpError InvalidParams;
 * the core entry point surfaces it as an isError result.
 */
export function validateArgs(name: string, args: ToolArgs): string | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be a JSON object";
  }
  if (name === "list-topics") {
    return null;
  }
  if (name === "search") {
    if (
      !Array.isArray(args.topics) ||
      args.topics.length === 0 ||
      !args.topics.every((t) => typeof t === "string" && t.length > 0)
    ) {
      return "topics must be a non-empty array of strings";
    }
    if (typeof args.query !== "string" || args.query.length === 0) {
      return "query must be a non-empty string";
    }
    if (args.topK !== undefined) {
      if (
        typeof args.topK !== "number" ||
        !Number.isFinite(args.topK) ||
        args.topK < 1 ||
        args.topK > 30
      ) {
        return "topK must be a number between 1 and 30";
      }
    }
    return null;
  }
  return `unknown tool: ${name}`;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function upstreamUrl(deps: KnowdriftDeps): string {
  if (deps.url) return deps.url;
  const env = deps.env ?? process.env;
  const fromEnv = env.DRIFLYTE_MCP_URL;
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : DEFAULT_MCP_URL;
}

function requestTimeoutMs(deps: KnowdriftDeps): number {
  if (deps.timeoutMs !== undefined) return deps.timeoutMs;
  const env = deps.env ?? process.env;
  const raw = env.REQUEST_TIMEOUT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function resolveFetch(deps: KnowdriftDeps): FetchFn {
  if (deps.fetchFn) return deps.fetchFn;
  return (url, init) => fetch(url, init) as Promise<FetchResponseLike>;
}

/* ------------------------------------------------------------------ */
/* JSON-RPC plumbing                                                   */
/* ------------------------------------------------------------------ */

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | unknown;
  [key: string]: unknown;
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `knowdrift error: ${message}` }],
    isError: true,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract the JSON-RPC message for `id` from a response body.
 * Streamable-HTTP servers answer either with a plain JSON
 * body or with a `text/event-stream` payload whose `data:`
 * lines carry the messages; both shapes are handled here.
 */
export function parseRpcBody(body: string, id: number): JsonRpcMessage | null {
  const trimmed = body.trim();
  if (trimmed === "") return null;
  const candidates: string[] = [];
  if (trimmed.startsWith("{")) {
    candidates.push(trimmed);
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("data:")) {
        const payload = t.slice("data:".length).trim();
        if (payload !== "" && payload !== "[DONE]") candidates.push(payload);
      }
    }
    if (candidates.length === 0) candidates.push(trimmed);
  }
  let fallback: JsonRpcMessage | null = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as JsonRpcMessage;
      if (parsed !== null && typeof parsed === "object") {
        if (parsed.id === id) return parsed;
        fallback = parsed;
      }
    } catch {
      // Not JSON; keep looking through the remaining candidates.
    }
  }
  return fallback;
}

function rpcErrorText(message: JsonRpcMessage): string | null {
  if (message.error === undefined || message.error === null) return null;
  const err = message.error as { message?: unknown };
  if (typeof err === "object" && typeof err.message === "string") {
    return err.message;
  }
  return JSON.stringify(message.error);
}

async function postRpc(
  fetchFn: FetchFn,
  url: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
  timeoutMs: number,
): Promise<{ response: FetchResponseLike; body: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId !== null) headers["mcp-session-id"] = sessionId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.text();
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Forwarding                                                          */
/* ------------------------------------------------------------------ */

/**
 * Forward one tool call to the upstream remote MCP server
 * and return its result verbatim. Any failure — transport,
 * HTTP status, JSON-RPC error, or a malformed upstream
 * reply — becomes an isError result carrying a
 * `knowdrift error:` message.
 */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: KnowdriftDeps = {},
): Promise<ToolResult> {
  if (!TOOL_NAMES.includes(name)) {
    return errorResult(`unknown tool: ${name}`);
  }
  const validationError = validateArgs(name, args ?? {});
  if (validationError !== null) return errorResult(validationError);

  const fetchFn = resolveFetch(deps);
  const url = upstreamUrl(deps);
  const timeoutMs = requestTimeoutMs(deps);

  try {
    // 1. initialize — opens the session and may issue an id.
    const init = await postRpc(
      fetchFn,
      url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "knowdrift", version: VERSION },
        },
      },
      null,
      timeoutMs,
    );
    if (!init.response.ok) {
      return errorResult(`upstream HTTP ${init.response.status} on initialize`);
    }
    const initMessage = parseRpcBody(init.body, 1);
    if (initMessage === null) {
      return errorResult("upstream returned an unreadable initialize response");
    }
    const initError = rpcErrorText(initMessage);
    if (initError !== null) return errorResult(`upstream initialize failed: ${initError}`);

    const sessionId =
      init.response.headers.get("mcp-session-id") ??
      init.response.headers.get("Mcp-Session-Id");

    // 2. notifications/initialized — completes the handshake.
    const ready = await postRpc(
      fetchFn,
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
      timeoutMs,
    );
    if (!ready.response.ok && ready.response.status !== 202) {
      return errorResult(
        `upstream HTTP ${ready.response.status} on notifications/initialized`,
      );
    }

    // 3. tools/call — the actual forwarded request.
    const call = await postRpc(
      fetchFn,
      url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args ?? {} },
      },
      sessionId,
      timeoutMs,
    );
    if (!call.response.ok) {
      return errorResult(`upstream HTTP ${call.response.status} on tools/call`);
    }
    const callMessage = parseRpcBody(call.body, 2);
    if (callMessage === null) {
      return errorResult("upstream returned an unreadable tools/call response");
    }
    const callError = rpcErrorText(callMessage);
    if (callError !== null) return errorResult(`upstream error: ${callError}`);
    if (callMessage.result === undefined) {
      return errorResult("upstream tools/call response carried no result");
    }
    // Verbatim pass-through of the upstream result.
    return callMessage.result as ToolResult;
  } catch (err) {
    return errorResult(describeError(err));
  }
}
