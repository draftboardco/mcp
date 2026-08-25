import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DraftboardClient, Query } from "../client.js";
import { READ_ONLY, WRITE, jsonResult, safeHandler } from "./util.js";

/**
 * Thin tools: 1:1 with the Integration API endpoints. They pass the raw JSON response through
 * unchanged, so the agent always has access to the full payload (useful as an escape hatch when
 * an outcome tool does not fit). For ranked intro discovery, prefer the outcome tools.
 */
export function registerThinTools(server: McpServer, client: DraftboardClient): void {
  server.registerTool(
    "get_me",
    {
      title: "Get current Draftboard customer",
      description:
        "Return the authenticated customer: `{ id, name, user{ id, firstName, lastName, linkedinUrl }, teamMembers[]{ id, firstName, lastName, linkedinUrl } }`. Call this first to confirm whose account you are working with. `teamMembers` is your team roster — to filter paths through a teammate, match them by name here and pass their `id` as `ownerIds`.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => safeHandler(async () => jsonResult(await client.getMe())),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "List the customer's tags. Tag `type` is either `manual` (a label the customer created and applied themselves, e.g. via import or attach-tags) or `automatic` (a system-generated batch marker Draftboard stamps on everything ingested together — usually the date of the campaign/upload/discovery batch, e.g. \"20-Apr-2026\"). There is no queryable `icp` tag type. Use to discover tag names/ids before filtering targets. Paginated.",
      inputSchema: {
        query: z.string().optional().describe("Search by tag name"),
        type: z
          .enum(["manual", "automatic"])
          .optional()
          .describe("Filter to user-created (manual) or system batch (automatic) tags"),
        pageNumber: z.number().int().positive().optional().describe("1-based page number"),
        resultPerPage: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      safeHandler(async () => jsonResult(await client.listTags(args as Query))),
  );

  server.registerTool(
    "list_targets",
    {
      title: "List targets",
      description:
        "List the customer's saved targets (leads) with status, best path rank (`maxRank`), path count (`pathsCount`), and tags. Filter by tag, status, update time, **company** (`accountId`), or **title/position** (`title`). To scope to a company, first resolve its name to an id with `list_accounts` (company search), then pass that id as `accountId` here — far cheaper than paging the whole target list. Paginated — loop pages until `nextPage` is 0.",
      inputSchema: {
        updatedSince: z.string().optional().describe("ISO 8601 timestamp filter"),
        tagIds: z.array(z.string()).optional(),
        tagNames: z.array(z.string()).optional(),
        statuses: z.array(z.enum(["new", "completed", "stopped"])).optional(),
        accountId: z
          .string()
          .optional()
          .describe("Only targets at this company — an account id from `list_accounts`. Resolve a company name via `list_accounts` first."),
        title: z
          .string()
          .optional()
          .describe('Only targets whose title/position contains this text (case-insensitive substring). e.g. "Head of Sales".'),
        pageNumber: z.number().int().positive().optional().describe("1-based page number"),
        resultPerPage: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      safeHandler(async () => jsonResult(await client.listTargets(args as Query))),
  );

  server.registerTool(
    "import_targets",
    {
      title: "Import targets by LinkedIn URL",
      description:
        "Import one or more people as targets from their LinkedIn profile URLs, optionally tagging them. Tags are created if they do not exist. Enrichment and path scoring happen asynchronously, so paths may not be available immediately after import.",
      inputSchema: {
        linkedinUrls: z
          .array(z.string().url())
          .min(1)
          .describe("LinkedIn profile URLs to import"),
        tags: z.array(z.string()).optional().describe("Tag names to apply"),
      },
      annotations: WRITE,
    },
    (args) =>
      safeHandler(async () =>
        jsonResult(
          await client.importTargets(args as { linkedinUrls: string[]; tags?: string[] }),
        ),
      ),
  );

  server.registerTool(
    "get_target_connections",
    {
      title: "Get connections (paths) for a target",
      description:
        "List the warm-intro connections for one target: each connector's profile, relationship `score` (0-100, `rank` in the outcome tools), `scoreDetails` (the human-readable shared history — omitted when there is nothing to say, so read it as `scoreDetails ?? []`), and the team members (`owners`) whose network the connection comes from. Filter by `ownerIds` to see paths through specific teammates. Paginated. " +
        "A connection may also carry two structured relationship fields. `relationships`: how the connector and the target know each other — zero or more of exactly `current_colleague`, `former_colleague`, `university_classmate`, and no other value is ever emitted. `relationshipDetails`: the machine-readable facts behind `scoreDetails` — one record per shared company / school / mutual-contact signal, with exactly one of `employment` (`company`, `department`, `location`, `overlapStartDate`, `overlapEndDate` as ISO yyyy-MM-dd, `loose`, `unit`) / `education` (`school` + the same window) / `mutualConnections` (`count`) set, plus that record's `score`. " +
        "BOTH KEYS ARE ABSENT WHEN EMPTY — the key is simply not in the JSON, it is never `[]` — so read them as `connection.relationships ?? []`. They are present when we hold that signal for the pair and omitted when we do not: absence means \"we hold no structured signal for this pair\", NOT \"these two have no relationship\". PROMOTE on the signal, NEVER demote on its absence — never drop or downrank a connector for it; `scoreDetails` carries the human-readable summary. " +
        "The two fields are also INDEPENDENT: a connection whose only signal is shared contacts gets a `relationshipDetails` record and NO `relationships` entry, and a rank can carry `relationships` with no records. Never derive, gate or index-align one from the other or from `scoreDetails`.",
      inputSchema: {
        targetId: z.string().describe("Target UUID"),
        updatedSince: z.string().optional().describe("ISO 8601 timestamp filter"),
        ownerIds: z.array(z.string()).optional().describe("Filter by team member ids"),
        pageNumber: z.number().int().positive().optional().describe("1-based page number"),
        resultPerPage: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      safeHandler(async () => {
        const { targetId, ...query } = args as { targetId: string } & Query;
        return jsonResult(await client.getTargetConnections(targetId, query));
      }),
  );
}
