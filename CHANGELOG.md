# Changelog

## 0.1.0 (2026-10-27)

- Initial release: a stdio MCP server and CLI that forward tool calls to the public Driflyte remote MCP endpoint.
- Tools: `list-topics` (discover the topics the crawler has indexed) and `search` (retrieve the top-K documents for a set of topics and a natural-language query).
- Upstream results pass through verbatim; upstream failures surface as `knowdrift error:` text results.
- Upstream endpoint can be overridden with the `DRIFLYTE_MCP_URL` environment variable.
