/**
 * knowdrift types.
 *
 * Two tools backed by forwarding to a remote MCP server:
 * `list-topics` takes no arguments, and `search` takes a
 * list of topic identifiers, a natural-language query, and
 * an optional result limit.
 */

export interface SearchArgs {
  topics: string[];
  query: string;
  topK?: number;
}

/** A tool's arguments, as decoded JSON. */
export type ToolArgs = Record<string, unknown>;

/** The result shape shared by the MCP handler and the CLI. */
export interface ToolResult {
  content: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** The minimal slice of a fetch Response this client relies on. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Injectable fetch, so tests never touch the live network. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Runtime dependencies for the core, all injectable in tests. */
export interface KnowdriftDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchFn?: FetchFn;
  /** Environment (DRIFLYTE_MCP_URL, REQUEST_TIMEOUT_MS). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Upstream MCP URL override. Defaults to env DRIFLYTE_MCP_URL or the pinned default. */
  url?: string;
  /** Per-request timeout in ms override. Defaults to env REQUEST_TIMEOUT_MS or 30000. */
  timeoutMs?: number;
}
