#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, loadConfig } from "./config.js";
import { registerThinTools } from "./tools/thin.js";
import { registerExtendedTools } from "./tools/extended.js";
import { registerProspectingTools } from "./tools/prospecting.js";
import { registerOutcomeTools } from "./tools/outcomes.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config);

  const server = new McpServer({
    name: "draftboard-mcp",
    version: "1.0.0-alpha.2",
  });

  registerThinTools(server, client);
  registerExtendedTools(server, client);
  registerProspectingTools(server, client);
  registerOutcomeTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the MCP protocol; log to stderr only.
  console.error("draftboard-mcp ready (stdio)");
}

main().catch((err) => {
  // Never print the API key; loadConfig/DraftboardApiError messages are already key-free.
  console.error(`draftboard-mcp failed to start: ${(err as Error).message}`);
  process.exit(1);
});
