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
      title: "List supporters (rated / closest connectors)",
      description:
        "List the customer's supporters — the connectors they have rated, plus the broader visible network. " +
        "Each supporter carries the caller's personal star `rating`: 1..5 where HIGHER IS BETTER " +
        "(5 = ★★★★★ 'ask anytime' … 1 = ★ 'don't ask'), absent when unreviewed. `tier` is the same value " +
        "as the raw wire number, counting DOWN (`rating = 6 - tier`), and ships alongside it. " +
        "Filter with `ratings` — `[5]` is 'my closest connections'. `tiers` is the equivalent wire-side filter " +
        "([1] ≡ ratings [5]); the two are UNIONED, not intersected. " +
        "IMPORTANT: a `rating: 1` ('don't ask') connector is also HIDDEN, so the default listing does not " +
        "return them — `ratings: [1]` (≡ `tiers: [5]`) is how you list the hidden ones; there is no separate " +
        "'hidden' flag. Team exception: a connector YOU rated 1 still shows in your default listing while a " +
        "teammate keeps them visible, carrying your own `rating: 1`. Set a rating with `set_connector_tier`.",
      inputSchema: {
        query: z.string().optional().describe("Search by name"),
        preferred: z
          .boolean()
          .optional()
          .describe(
            "Legacy star flag (superseded by the rating; `preferred: true` is in practice `rating: 5`). " +
              "true = starred/preferred only, false = non-starred only, omit = full network.",
          ),
        ratings: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe(
            "Filter by star rating 1..5, HIGHER IS BETTER: 5 = closest / 'ask anytime' (★★★★★), " +
              "1 = 'don't ask' (★). Multi-select, any-of (OR); scoped to your own ratings. " +
              "For 'my closest connections' use [5] or [4,5]. Asking for [1] also returns the connectors " +
              "the default listing HIDES — this is the 'Hidden' scope.",
          ),
        rating: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe(
            "Alias of `ratings`, spelled the way the HTTP API spells it (`filters[rating][]`). " +
              "Same values, same behaviour — pass either. Provided so the wire spelling is never " +
              "silently ignored.",
          ),
        tiers: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe(
            "The same filter on the raw wire scale, which counts DOWN: tier 1 = closest / 'ask anytime' " +
              "(≡ rating 5), tier 5 = 'don't ask' / hidden (≡ rating 1). Multi-select, any-of (OR), and " +
              "UNIONED with `ratings` rather than intersected. Prefer `ratings`; use this only when you " +
              "already hold tier numbers.",
          ),
        pageNumber: z.number().int().positive().optional(),
        resultPerPage: z.number().int().positive().max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const a = args as {
        query?: string;
        preferred?: boolean;
        ratings?: number[];
        rating?: number[];
        tiers?: number[];
        pageNumber?: number;
        resultPerPage?: number;
      };
      // `rating` is the wire spelling, `ratings` the MCP one — accept either and union them,
      // so the HTTP-doc spelling is never silently dropped by the schema.
      const { rating, ...rest } = a;
      const ratings = [...new Set([...(a.ratings ?? []), ...(rating ?? [])])];
      return safeHandler(async () =>
        jsonResult(await client.getSupporters({ ...rest, ratings: ratings.length ? ratings : undefined })),
      );
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
        "WRITE. Star (`preferred: true`) or unstar (`preferred: false`) a connector as a preferred supporter for this customer. Preferred connectors are prioritized when ranking warm paths. LEGACY: the product has moved on to the star rating, and 97% of the connectors marked preferred also carry the top rating. That is an observation about existing data, NOT an equivalence: `set_connector_tier` does NOT write the `preferred` column, so setting `rating: 5` will not mark someone preferred, and marking them preferred will not give them a rating. Prefer the rating for new work; use this tool only when you specifically need the `preferred` flag itself.",
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
        "WRITE. Exclude (`excluded: true`) or un-exclude (`excluded: false`) a connector for this customer. Excluded connectors are dropped from warm-path results. LEGACY: the product has moved on to the star rating. `rating: 1` ('don't ask') already sets this flag for you, so prefer `set_connector_tier` with `rating: 1` to hide someone. ⚠ The sync runs ONE WAY: writing a rating updates this flag, but `excluded: false` here does NOT clear a `rating: 1` — it leaves the connector rated don't-ask while un-excluded. To un-hide someone cleanly, give them a rating of 2..5 instead of un-excluding.",
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
    "set_connector_tier",
    {
      title: "Rate a connector (set their star rating) (WRITE)",
      description:
        "WRITE. Set the caller's personal star `rating` for a connector — how readily they'd ask this " +
        "person for an intro. This is how you 'rate' or 'prioritize' a supporter. `rating` is 1..5 and " +
        "HIGHER IS BETTER: 5 = ★★★★★ 'ask anytime' (the closest) down to 1 = ★ \"don't ask\", with 4, 3 " +
        "and 2 in between — and a rating of 1 also HIDES the connector from the default listings. " +
        "`tier` is the same rating as the raw wire number, counting DOWN (`tier = 6 - rating`), and is " +
        "still accepted: pass EXACTLY ONE of `rating` (1..5) or `tier` (0..5) — sending both, or neither, " +
        "is rejected. There is no `rating: 0`: clearing a rating back to unreviewed stays `tier: 0`. " +
        "Read the rating back on `list_supporters` (each supporter's `rating`) and filter there with " +
        "`ratings`. Personal to the API-key owner.",
      inputSchema: {
        connectorId: z
          .string()
          .describe("Connector UUID — a connection's `connectorId` (NOT its `id`), or a supporter's `id`"),
        rating: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Star rating 1..5, HIGHER IS BETTER: 5 = closest / 'ask anytime' (★★★★★) … 1 = \"don't ask\" (★, " +
              "also hides the connector). No 0 — to clear a rating send `tier: 0` instead. " +
              "Pass this OR `tier`, never both.",
          ),
        tier: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe(
            "The same rating on the raw wire scale, which counts DOWN: 1 = best (≡ rating 5) … " +
              "5 = \"don't ask\" (≡ rating 1), 0 = clear the rating. Pass this OR `rating`, never both.",
          ),
      },
      annotations: WRITE,
    },
    (args) => {
      const { connectorId, rating, tier } = args as {
        connectorId: string;
        rating?: number;
        tier?: number;
      };
      // The endpoint 400s on a body carrying both keys or neither — fail here with a usable message
      // instead of spending the round trip.
      const hasRating = rating !== undefined && rating !== null;
      const hasTier = tier !== undefined && tier !== null;
      if (hasRating && hasTier) {
        return Promise.resolve(
          errorResult(
            "`rating` and `tier` are the same value spelled two ways — send exactly one. Use `rating` (1..5, higher is better) unless you already hold a tier number.",
          ),
        );
      }
      if (!hasRating && !hasTier) {
        return Promise.resolve(
          errorResult(
            "Provide a `rating` (1..5, 5 = closest / 'ask anytime', 1 = \"don't ask\") — or `tier` (0..5 on the raw wire scale; `tier: 0` clears the rating).",
          ),
        );
      }
      return safeHandler(async () =>
        jsonResult(
          await client.setConnectorTier(connectorId, hasRating ? { rating } : { tier }),
        ),
      );
    },
  );

  server.registerTool(
    "get_connector_intros",
    {
      title: "Get intros for a connector (connector-first view)",
      description:
        "List the intro opportunities where a given connector is the connector — i.e. everyone this person can introduce you to, each with a relationship score and shared-history `scoreDetails`, plus the team members who can make the ask. Answers 'who can <this person> introduce me to?'. Each item may also carry `relationships` — how the connector and that target know each other, zero or more of exactly `current_colleague`, `former_colleague`, `university_classmate` — and `relationshipDetails`, the structured records behind `scoreDetails` (one per shared company / school / mutual-contact signal, exactly one of `employment` / `education` / `mutualConnections` set per record, dates ISO yyyy-MM-dd). BOTH KEYS ARE ABSENT WHEN EMPTY (never `[]`) and empty is the common case, so read them as `item.relationships ?? []`: absence means \"we hold no structured signal for this pair\", NOT \"these two have no relationship\" — keep reading `scoreDetails`, which is far more often present than the structured fields (it is the model's own prose), though it too is omitted when there is nothing to say. The two fields are independent: a mutual-contacts-only signal yields a `relationshipDetails` record and NO `relationships` entry, so never derive or index-align one from the other. The response's `connector` object also carries your personal star `rating` (1..5, higher is better; absent when unreviewed).",
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
