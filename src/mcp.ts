/**
 * knowdrift MCP server. Tools: list-topics, search.
 *
 * The low-level Server API is used on purpose: the
 * high-level helper rewrites tool schemas while converting
 * them, which would break exact parity with the documented
 * tool surface. Here tools/list serves the core's literal
 * definitions unchanged, argument shape errors are raised
 * as InvalidParams, and upstream failures come back as
 * isError results carrying the core's error text.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { callTool, TOOL_DEFS, TOOL_NAMES, validateArgs, VERSION } from "./knowdrift.js";

const server = new Server(
  { name: "knowdrift", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (!TOOL_NAMES.includes(name)) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  const validationError = validateArgs(name, (args ?? {}) as Record<string, unknown>);
  if (validationError !== null) {
    throw new McpError(ErrorCode.InvalidParams, validationError);
  }
  const result = await callTool(name, (args ?? {}) as Record<string, unknown>);
  return {
    content: result.content as Array<{ type: "text"; text: string }>,
    ...(result.isError ? { isError: true as const } : {}),
  };
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
