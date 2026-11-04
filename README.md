# knowdrift

knowdrift connects an MCP client to a web crawl that is organised by topic. Instead of searching the open web blindly, you first ask which topics the crawler has already covered, then pull the documents it filed under the topics that match your question. Answers come back as ranked documents drawn from pages that were actually crawled and indexed.

This package is a thin forwarding client. It speaks MCP over stdio on one side and relays each tool call to the public remote service over streamable HTTP on the other, returning whatever the remote sends back.

## Tools

### `list-topics`

Takes no arguments. Returns the names of the topics for which crawled content is currently available, so you can discover the subject areas the index covers before searching it.

### `search`

Retrieves the documents that best match a question inside chosen topics.

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `topics` | array of string | yes | One or more topic identifiers, as returned by `list-topics`. Only documents filed under at least one of these topics are considered. |
| `query` | string | yes | The natural-language question used to rank documents by semantic relevance. |
| `topK` | number | no | How many documents to return at most, from 1 to 30. Defaults to 10; results arrive sorted by descending relevance. |

## CLI usage

```bash
npx @reneturcios/knowdrift list-topics
npx @reneturcios/knowdrift search '{"topics":["technology"],"query":"How do vector databases work?","topK":5}'
npx @reneturcios/knowdrift --version
```

The tool subcommands accept the tool's arguments as a single JSON object string and print the first text block of the result. Exit codes are 0 on success, 1 when the call returns an error result, and 2 for usage errors.

## MCP usage

Start the stdio server with the `mcp` subcommand:

```bash
npx -y @reneturcios/knowdrift mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "knowdrift": {
      "command": "npx",
      "args": ["-y", "@reneturcios/knowdrift", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/knowdrift
docker run --rm ghcr.io/cloudcorprecords/knowdrift search '{"topics":["technology"],"query":"What is new in quantum computing?"}'
```

With no arguments the container runs the stdio MCP server; any other arguments are passed to the CLI.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRIFLYTE_MCP_URL` | `https://mcp.driflyte.com/mcp` | Overrides the upstream remote MCP endpoint that calls are forwarded to. |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout for upstream calls, in milliseconds. |

No account or API key is needed: the upstream service is public. When the upstream cannot be reached or answers with an error, the tool returns an error result whose text begins with `knowdrift error:` rather than fabricating documents.

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

The test suite runs fully offline. It drives the forwarding logic against a stubbed JSON-RPC upstream and checks the served tool list against the documented tool surface.

## License

MIT — see [LICENSE](LICENSE).
