#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, loadConfig } from "./config.js";
import { registerThinTools } from "./tools/thin.js";
import { registerExtendedTools } from "./tools/extended.js";
import { registerProspectingTools } from "./tools/prospecting.js";
import { registerOutcomeTools } from "./tools/outcomes.js";

/**
 * Read by the ASSISTANT, not by a human — which is the whole point. Everyone still running this
 * server reaches it from inside Claude or Codex and will never open the repository, so a notice
 * in the README reaches nobody. This is the one channel that does.
 *
 * It rides in the model's context for the whole session, so it stays short and says only what
 * changes a decision: that this server is superseded, how to move, and that nothing is broken in
 * the meantime. The "mention once" line is load-bearing — without it an assistant repeats the
 * notice in every answer and the user learns to ignore it.
 */
const MIGRATION_NOTICE = `This server is the OLD, self-installed Draftboard MCP and is no longer
the recommended way to connect. It still works and nothing here is broken, so finish what you are
doing — but tell the user, ONCE per conversation and not again, that Draftboard now runs a hosted
MCP server that needs no install and no API key:

  https://mcp.draftboard.com   (setup guide: https://www.draftboard.com/mcp)

Moving takes one step. Claude Code:
  claude mcp add --transport http draftboard https://mcp.draftboard.com && claude mcp login draftboard
Codex CLI:
  codex mcp add draftboard --url https://mcp.draftboard.com && codex mcp login draftboard
Claude Desktop:
  Settings -> Connectors -> Add -> Add custom connector -> https://mcp.draftboard.com

One real difference to pass on rather than hide: the hosted server is approved in the browser
instead of taking DRAFTBOARD_API_KEY from the environment, so the person has to be signed in to
Draftboard in a browser on that machine. A headless or CI setup cannot complete that step the same
way and should stay here for now.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config);

  const server = new McpServer(
    {
      name: "draftboard-mcp",
      version: "1.0.0-alpha.5",
    },
    { instructions: MIGRATION_NOTICE },
  );

  registerThinTools(server, client);
  registerExtendedTools(server, client);
  registerProspectingTools(server, client);
  registerOutcomeTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the MCP protocol; log to stderr only.
  // The second line is for whoever is reading a terminal rather than talking to the assistant —
  // the same notice the model gets through `instructions`, in one line.
  console.error("draftboard-mcp ready (stdio)");
  console.error(
    "draftboard-mcp: this self-installed server is superseded by the hosted one at " +
      "https://mcp.draftboard.com (no install, no API key). Setup: https://www.draftboard.com/mcp",
  );
}

main().catch((err) => {
  // Never print the API key; loadConfig/DraftboardApiError messages are already key-free.
  console.error(`draftboard-mcp failed to start: ${(err as Error).message}`);
  process.exit(1);
});
