import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DraftboardClient, Query } from "../client.js";
import { DESTRUCTIVE, READ_ONLY, WRITE, errorResult, jsonResult, safeHandler } from "./util.js";

/**
 * Extended thin tools — the rest of the Integration API beyond the core 5. Includes account
 * discovery, supporters (preferred connectors), connector preferred/excluded toggles,
 * connector-first intros, target tag/archive management, and the intro lifecycle.
 *
 * Tools that change data are marked WRITE / DESTRUCTIVE in their descriptions; the MCP host
 * still gates every call behind user approval at runtime.
 */
export function registerExtendedTools(server: McpServer, client: DraftboardClient): void {
  // ---- accounts ----
  server.registerTool(
    "list_accounts",
    {
      title: "List accounts (companies) with saved targets",
      description:
        "List the companies where the customer has saved targets, with per-account counts: saved targets, total paths, and how many are 1st- vs 2nd-degree reachable. Filter by company name (`query`) or by degree. Useful for an account-level view of where warm reach already exists.",
      inputSchema: {
        query: z.string().optional().describe("Search by company name (also matches person name/title)"),
        connectionDegree: z.enum(["1st", "2nd"]).optional().describe("Only accounts with a target at this degree"),
        pageNumber: z.number().int().positive().optional(),
        resultPerPage: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => safeHandler(async () => jsonResult(await client.getAccounts(args as Query))),
  );

  // ---- supporters ----
  server.registerTool(
    "list_supporters",
    {
      title: "List supporters (closest / preferred connectors)",
      description:
        "List the customer's supporters — connectors marked as preferred plus the broader non-excluded network. Set `preferred: true` for starred supporters only, `false` for non-starred only, or omit for the full non-excluded list. This is how you see 'my closest connections'.",
      inputSchema: {
        query: z.string().optional().describe("Search by name"),
        preferred: z
          .boolean()
          .optional()
          .describe("true = starred/preferred only, false = non-starred only, omit = full network"),
        pageNumber: z.number().int().positive().optional(),
        resultPerPage: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const a = args as { query?: string; preferred?: boolean; pageNumber?: number; resultPerPage?: number };
      return safeHandler(async () => jsonResult(await client.getSupporters(a)));
    },
  );

  server.registerTool(
    "import_supporters",
    {
      title: "Import supporters by LinkedIn URL (WRITE)",
      description:
        "WRITE. Add people as supporters from their LinkedIn profile URLs (max 100 per call). Supporters are prioritized as warm-intro connectors.",
      inputSchema: {
        linkedinUrls: z.array(z.string().url()).min(1).max(100).describe("LinkedIn profile URLs to add as supporters"),
      },
      annotations: WRITE,
    },
    (args) =>
      safeHandler(async () =>
        jsonResult(await client.importSupporters(args as { linkedinUrls: string[] })),
      ),
  );

  // ---- connector preferred / excluded toggles ----
  server.registerTool(
    "set_connector_preferred",
    {
      title: "Mark/unmark a connector as preferred (WRITE)",
      description:
        "WRITE. Star (`preferred: true`) or unstar (`preferred: false`) a connector as a preferred supporter for this customer. Preferred connectors are prioritized when ranking warm paths — this is how you 'mark my closest connections'.",
      inputSchema: {
        connectorId: z.string().describe("Connector UUID (e.g. from a connection's id)"),
        preferred: z.boolean().describe("true = mark preferred, false = unmark"),
      },
      annotations: WRITE,
    },
    (args) => {
      const { connectorId, preferred } = args as { connectorId: string; preferred: boolean };
      return safeHandler(async () => jsonResult(await client.setConnectorPreferred(connectorId, preferred)));
    },
  );

  server.registerTool(
    "set_connector_excluded",
    {
      title: "Mark/unmark a connector as excluded (WRITE)",
      description:
        "WRITE. Exclude (`excluded: true`) or un-exclude (`excluded: false`) a connector for this customer. Excluded connectors are dropped from warm-path results — this is how you hide connections you'd never ask for an intro.",
      inputSchema: {
        connectorId: z.string().describe("Connector UUID"),
        excluded: z.boolean().describe("true = exclude, false = un-exclude"),
      },
      annotations: WRITE,
    },
    (args) => {
      const { connectorId, excluded } = args as { connectorId: string; excluded: boolean };
      return safeHandler(async () => jsonResult(await client.setConnectorExcluded(connectorId, excluded)));
    },
  );

  server.registerTool(
    "get_connector_intros",
    {
      title: "Get intros for a connector (connector-first view)",
      description:
        "List the intro opportunities where a given connector is the connector — i.e. everyone this person can introduce you to, each with a relationship score and shared-history reasons, plus the team members who can make the ask. Answers 'who can <this person> introduce me to?'.",
      inputSchema: {
        connectorId: z.string().describe("Connector UUID"),
        pageNumber: z.number().int().positive().optional(),
        resultPerPage: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const { connectorId, pageNumber, resultPerPage } = args as {
        connectorId: string;
        pageNumber?: number;
        resultPerPage?: number;
      };
      return safeHandler(async () =>
        jsonResult(await client.getConnectorIntros(connectorId, { pageNumber, resultPerPage })),
      );
    },
  );

  // ---- target tag / archive management ----
  server.registerTool(
    "attach_tags_to_targets",
    {
      title: "Attach tags to targets (WRITE)",
      description:
        "WRITE. Attach tags (by id and/or name; names auto-create as manual tags) to one or more targets. Idempotent. All-or-nothing: if any target id is missing or foreign, the whole request is rejected. Caps: 1–500 targets, ≤50 tags, ≤5000 associations.",
      inputSchema: {
        targetIds: z.array(z.string()).min(1).max(500).describe("Target UUIDs to tag"),
        tagIds: z.array(z.string()).optional().describe("Existing tag ids"),
        tagNames: z.array(z.string()).optional().describe("Tag names (auto-created if new)"),
      },
      annotations: WRITE,
    },
    (args) => {
      const a = args as { targetIds: string[]; tagIds?: string[]; tagNames?: string[] };
      const hasTags = (a.tagIds?.length ?? 0) > 0 || (a.tagNames?.length ?? 0) > 0;
      if (!hasTags) {
        return Promise.resolve(
          errorResult("Provide at least one tag: pass a non-empty `tagIds` and/or `tagNames`."),
        );
      }
      return safeHandler(async () => jsonResult(await client.attachTagsToTargets(a)));
    },
  );

  server.registerTool(
    "archive_target",
    {
      title: "Archive a target (WRITE, DESTRUCTIVE)",
      description:
        "WRITE / DESTRUCTIVE and NOT reversible via the public API. Soft-deletes a target: it disappears from list_targets and frees its capacity slot (associated intros remain as history). Requires `confirm: true` AND must be confirmed with the user first.",
      inputSchema: {
        targetId: z.string().describe("Target UUID to archive"),
        confirm: z
          .boolean()
          .describe("Must be true to proceed — a deliberate guard against accidental irreversible deletes"),
      },
      annotations: DESTRUCTIVE,
    },
    (args) => {
      const { targetId, confirm } = args as { targetId: string; confirm?: boolean };
      if (confirm !== true) {
        return Promise.resolve(
          errorResult(
            "archive_target is irreversible. Re-call with `confirm: true` only after the user has explicitly approved archiving this target.",
          ),
        );
      }
      return safeHandler(async () => jsonResult(await client.archiveTarget(targetId)));
    },
  );

  // ---- intro lifecycle ----
  server.registerTool(
    "set_intro_status",
    {
      title: "Update an intro's status (WRITE)",
      description:
        "WRITE. Move an intro through its lifecycle: `requested` (intro sent), `completed` (intro made), or `declined`. For `declined` you may pass `reasonId` (connector_declined | prospect_declined | other) and a free-text `customReason` (≤200 chars). Idempotent per status.",
      inputSchema: {
        introId: z.string().describe("Intro (path) UUID"),
        status: z.enum(["requested", "completed", "declined"]).describe("Target status"),
        reasonId: z
          .enum(["connector_declined", "prospect_declined", "other"])
          .optional()
          .describe("Only for status=declined"),
        customReason: z.string().max(200).optional().describe("Only for status=declined; free text ≤200 chars"),
      },
      annotations: WRITE,
    },
    (args) => {
      const { introId, status, reasonId, customReason } = args as {
        introId: string;
        status: "requested" | "completed" | "declined";
        reasonId?: string;
        customReason?: string;
      };
      return safeHandler(async () =>
        jsonResult(await client.setIntroStatus(introId, status, { reasonId, customReason })),
      );
    },
  );
}
