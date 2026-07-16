import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DraftboardClient, Query } from "../client.js";
import { READ_ONLY, WRITE, jsonResult, safeHandler } from "./util.js";

/**
 * Prospecting tools (BETA) — company-first discovery. The rest of the API works over people you
 * already track; these find NEW people by role at named companies:
 *
 *   search_accounts → (async) → list_pool → confirm_pool / reject_pool
 *
 * search_accounts starts a search and returns a campaignId; discovered people surface
 * ASYNCHRONOUSLY in the pool (there is no completion signal). Poll list_pool (optionally filtered by
 * that campaignId), then confirm the good ones into real targets, or reject the rest. Team/Enterprise
 * plans only. Every write is still gated behind the host's approval at runtime.
 */
export function registerProspectingTools(server: McpServer, client: DraftboardClient): void {
  server.registerTool(
    "search_accounts",
    {
      title: "Search for people at companies (WRITE, BETA)",
      description:
        'WRITE / BETA (Team & Enterprise plans only). Company-first discovery: find NEW people with the given job `titles` at the given `companies` — for when you have target companies but not the names yet. `companies` are domains (`acme.com`) or LinkedIn company URLs (`linkedin.com/company/…`); `titles` form the persona (e.g. "Head of Sales"). Returns a `campaignId`; discovered people appear ASYNCHRONOUSLY in the pool — there is no completion signal. After a short wait, read them with `list_pool` (filter by this `campaignId`), then `confirm_pool` the good ones into targets. Does NOT create targets by itself.',
      inputSchema: {
        companies: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("Companies to search — each a domain (acme.com) or a linkedin.com/company/… URL"),
        titles: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Job titles / roles to find at those companies, e.g. ["Head of Sales", "VP Marketing"]'),
        name: z.string().max(200).optional().describe("Optional label for the search (shown app-side)"),
      },
      annotations: WRITE,
    },
    (args) =>
      safeHandler(async () =>
        jsonResult(
          await client.searchAccounts(args as { companies: string[]; titles: string[]; name?: string }),
        ),
      ),
  );

  server.registerTool(
    "list_pool",
    {
      title: "List pool prospects (from a search)",
      description:
        "List the pool: potential prospects (status `new`) awaiting confirm/reject — the people `search_accounts` discovered. Each carries `id`, `name`, `linkedinUrl`, `headline`, `accountName`, `source`, and `tags`. Filter by `campaignId` (the id `search_accounts` returned) to read one search's results, or by `accountId` / `tagIds` / `query`. Paginated (loop until `nextPage` is 0). A search fills the pool asynchronously, so an empty result right after `search_accounts` means 'not ready yet', not 'nothing found' — re-poll shortly.",
      inputSchema: {
        query: z.string().optional().describe("Substring match on LinkedIn URL"),
        campaignId: z
          .string()
          .optional()
          .describe("Only prospects from this search (a `campaignId` returned by search_accounts)"),
        accountId: z.string().optional().describe("Only prospects at this account (company) id"),
        tagIds: z.array(z.string()).optional().describe("Filter by tag ids"),
        pageNumber: z.number().int().positive().optional().describe("1-based page number"),
        resultPerPage: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => safeHandler(async () => jsonResult(await client.listPool(args as Query))),
  );

  server.registerTool(
    "confirm_pool",
    {
      title: "Confirm pool prospects into targets (WRITE)",
      description:
        "WRITE. Promote pool prospects (by their `list_pool` ids) into saved targets — capacity-checked and idempotent. Returns `confirmedCount` and `remainingCapacity`. This is how you keep the good people a search found; the rest can be left or `reject_pool`ed. Once confirmed they are real targets, so `list_targets` / `find_top_paths` will include them (path scoring is async, so paths may take a moment).",
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .describe("Pool prospect ids (from list_pool) to confirm into targets"),
      },
      annotations: WRITE,
    },
    (args) => safeHandler(async () => jsonResult(await client.confirmPool(args as { ids: string[] }))),
  );

  server.registerTool(
    "reject_pool",
    {
      title: "Reject pool prospects (WRITE)",
      description:
        "WRITE. Discard pending pool prospects (by their `list_pool` ids) — soft-deletes the status-`new` entries. Idempotent; already-confirmed prospects are unaffected. Use to clear out people a search surfaced that you don't want.",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("Pool prospect ids (from list_pool) to reject"),
      },
      annotations: WRITE,
    },
    (args) => safeHandler(async () => jsonResult(await client.rejectPool(args as { ids: string[] }))),
  );
}
