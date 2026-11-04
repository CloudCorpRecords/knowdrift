#!/usr/bin/env node
/**
 * knowdrift CLI.
 *
 *   knowdrift list-topics ['<json-args>']
 *   knowdrift search '<json-args>'
 *   knowdrift mcp
 *   knowdrift --version
 *
 * A tool subcommand takes an optional JSON argument string
 * with the tool's arguments, runs the same forwarded call
 * as the MCP path, and prints the result text. Exit codes:
 * 0 success, 1 on an isError result, 2 usage error.
 */
import { callTool, TOOL_NAMES, VERSION } from "./knowdrift.js";
import type { ToolResult } from "./types.js";

function usage(): never {
  console.error(`Usage:
  knowdrift list-topics ['<json-args>']
  knowdrift search '<json-args>'
  knowdrift mcp
  knowdrift --version`);
  process.exit(2);
}

function firstText(result: ToolResult): string {
  const content = result.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        return (item as { text: string }).text;
      }
    }
  }
  return typeof content === "string" ? content : JSON.stringify(content);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    if (rest.length !== 0) usage();
    await import("./mcp.js");
    return;
  }
  if (!TOOL_NAMES.includes(cmd ?? "")) usage();
  if (rest.length > 1) usage();
  let args: Record<string, unknown> = {};
  if (rest.length === 1) {
    try {
      const parsed: unknown = JSON.parse(rest[0]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      console.error("error: argument must be a JSON object string");
      process.exit(2);
    }
  }
  const result = await callTool(cmd, args);
  if (result.isError) {
    console.error(`error: ${firstText(result)}`);
    process.exit(1);
  }
  console.log(firstText(result));
}

void main();
