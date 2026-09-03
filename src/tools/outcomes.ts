import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DraftboardClient } from "../client.js";
import { fetchAllPages } from "../pagination.js";
import {
  connectionRank,
  connectionRankDetails,
  connectionRelationshipDetails,
  connectionRelationships,
  fullName,
  linkedin,
  targetMaxRank,
  targetPathsCount,
} from "../normalize.js";
import type { IntegrationTarget } from "../types.js";
import { READ_ONLY, WRITE, jsonResult, safeHandler } from "./util.js";

const TARGETS_FETCH_CAP = 200;

// ---------- find_top_paths ----------

export interface FindTopPathsParams {
  tagNames?: string[];
  accountId?: string;
  title?: string;
  ownerIds?: string[];
  statuses?: string[];
  minTargetMaxRank?: number;
  minRank?: number;
  limit?: number;
  maxTargetsScanned?: number;
  connectorsPerTarget?: number;
  includeRankDetails?: boolean;
  includeRelationships?: boolean;
}

export async function findTopPaths(client: DraftboardClient, p: FindTopPathsParams) {
  const statuses = p.statuses ?? ["new"];
  const connectorsPerTarget = p.connectorsPerTarget ?? 3;
  const maxTargetsScanned = p.maxTargetsScanned ?? 25;
  const minRank = p.minRank ?? 0;

  const targetsPage = await fetchAllPages(
    (pageNumber) =>
      client.listTargets({
        tagNames: p.tagNames,
        accountId: p.accountId,
        title: p.title,
        statuses,
        pageNumber,
        resultPerPage: 50,
      }),
    (r) => r.targets ?? [],
    { maxItems: TARGETS_FETCH_CAP, maxPages: 20 },
  );

  const candidates = targetsPage.items
    .filter((t) => targetMaxRank(t) >= (p.minTargetMaxRank ?? 0))
    .sort(
      (a, b) =>
        targetMaxRank(b) - targetMaxRank(a) || targetPathsCount(b) - targetPathsCount(a),
    );
  const scanned = candidates.slice(0, maxTargetsScanned);

  let connectionsFetched = 0;
  const warnings: string[] = [];
  const opportunities: Record<string, unknown>[] = [];

  for (const t of scanned) {
    let conns;
    try {
      const resp = await client.getTargetConnections(t.id, {
        ownerIds: p.ownerIds,
        pageNumber: 1,
        resultPerPage: Math.max(connectorsPerTarget, 10),
      });
      conns = resp.connections ?? [];
    } catch (err) {
      warnings.push(`Could not fetch connections for "${fullName(t)}": ${(err as Error).message}`);
      continue;
    }
    connectionsFetched += conns.length;
    const top = conns
      .filter((c) => connectionRank(c) >= minRank)
      .sort((a, b) => connectionRank(b) - connectionRank(a))
      .slice(0, connectorsPerTarget);

    for (const c of top) {
      // The API omits these two keys entirely when empty (they are never `[]`) — so read them
      // defensively and only re-emit them when there is something to say. An opportunity without
      // them means "no structured signal", not "no relationship".
      const relationships = p.includeRelationships === false ? [] : connectionRelationships(c);
      const relationshipDetails =
        p.includeRelationships === false ? [] : connectionRelationshipDetails(c);
      opportunities.push({
        targetId: t.id,
        target: fullName(t),
        targetLinkedinUrl: linkedin(t),
        targetCompany: t.position?.companyName,
        targetHeadline: t.headline,
        targetMaxRank: targetMaxRank(t),
        connector: fullName(c),
        connectorLinkedinUrl: linkedin(c),
        connectorPosition: c.position?.title,
        rank: connectionRank(c),
        ...(p.includeRankDetails !== false ? { rankDetails: connectionRankDetails(c) } : {}),
        ...(relationships.length ? { relationships } : {}),
        ...(relationshipDetails.length ? { relationshipDetails } : {}),
        owners: (c.owners ?? []).map((o) => ({ id: o.id, name: fullName(o) })),
      });
    }
  }

  opportunities.sort((a, b) => (b.rank as number) - (a.rank as number));
  const limited = opportunities.slice(0, p.limit ?? 20);
  const truncated = targetsPage.truncated || candidates.length > scanned.length;

  return {
    opportunities: limited,
    telemetry: {
      targetsMatched: targetsPage.total,
      targetsScanned: scanned.length,
      connectionsFetched,
      opportunitiesFound: opportunities.length,
      truncated,
      ...(truncated
        ? {
            nextSuggestedFilter:
              "More targets matched than were scanned. Narrow with `tagNames`, raise `minTargetMaxRank`, or increase `maxTargetsScanned`.",
          }
        : {}),
    },
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---------- check_if_connected ----------

/** Lookups in flight at once. Small: the read rate limit is 50/min per customer. */
const RESOLVE_CONCURRENCY = 4;

export interface CheckIfConnectedParams {
  linkedinUrls: string[];
  importIfMissing?: boolean;
  tags?: string[];
}

/** One URL and what the direct lookup said about it. */
interface ResolvedUrl {
  url: string;
  target: IntegrationTarget | null;
  /** The lookup itself errored. NOT the same as "no such target" — never import over this. */
  failed?: boolean;
  /** We asked the API to import this URL. Still unresolved => the async import has not landed yet. */
  importAttempted?: boolean;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function checkIfConnected(client: DraftboardClient, p: CheckIfConnectedParams) {
  const warnings: string[] = [];

  // One direct lookup per URL. Deliberately NOT a walk over `listTargets`: that costs a page
  // request per 100 targets AND silently stops after the first N, so on a large book it reports
  // "not a target" for people who are.
  const resolveOne = async (url: string): Promise<ResolvedUrl> => {
    try {
      return { url, target: await client.resolveTarget(url) };
    } catch (err) {
      warnings.push(`Could not look up ${url}: ${(err as Error).message}`);
      return { url, target: null, failed: true };
    }
  };

  const resolved = await mapWithConcurrency(p.linkedinUrls, RESOLVE_CONCURRENCY, resolveOne);

  // Import ONLY what is genuinely missing — not the ones already saved (that would re-import
  // them and spawn an import campaign every call), and not the ones whose lookup errored (a
  // failed lookup is not evidence of absence).
  const missing = resolved.filter((r) => !r.target && !r.failed);
  let importRequested = 0;
  let afterImport: ResolvedUrl[] = resolved;

  if (p.importIfMissing !== false && missing.length > 0) {
    try {
      await client.importTargets({ linkedinUrls: missing.map((r) => r.url), tags: p.tags });
    } catch (err) {
      warnings.push(`Import step failed (continuing with existing targets): ${(err as Error).message}`);
    }
    // Re-check the missing ones REGARDLESS of whether the import call reported an error: a partial
    // failure still persists some people, and the resolver is the only thing that knows which.
    //
    // This is a best-effort recheck, NOT a guarantee: intro-svc processes an import batch
    // fire-and-forget (import.service.ts, "Fire-and-forget: first batch processed async, rest by
    // cron"), so `POST /targets/import` routinely returns before the row exists. A URL that still
    // does not resolve here is reported as `import_pending` — never as `not_a_target`, which would
    // be a wrong answer about someone we just saved.
    const rechecked = new Map(
      (await mapWithConcurrency(missing, RESOLVE_CONCURRENCY, (r) => resolveOne(r.url))).map((r) => [
        r.url,
        r,
      ]),
    );
    afterImport = resolved.map((r) =>
      r.target ? r : { ...(rechecked.get(r.url) ?? r), importAttempted: true },
    );
    importRequested = missing.length;
  }

  const results = await mapWithConcurrency(afterImport, RESOLVE_CONCURRENCY, async (r) => {
    // A lookup that ERRORED is not a "no". Reporting `isTarget: false` here would hand a caller a
    // definitive negative we never established — so the booleans are null and the status says why.
    if (r.failed) {
      return {
        linkedinUrl: r.url,
        status: "lookup_failed" as const,
        isTarget: null,
        hasPaths: null,
        note: "Lookup failed — see warnings. This is NOT a confirmed 'not a target'; retry before acting on it.",
      };
    }
    if (!r.target && r.importAttempted) {
      return {
        linkedinUrl: r.url,
        status: "import_pending" as const,
        isTarget: null,
        hasPaths: null,
        note: "Import accepted but not visible yet — Draftboard processes an import batch asynchronously. Re-check with `resolve_target`; do not report this person as missing.",
        // "asynchronous" alone reads as "a second or two" and sends an agent back too early, which
        // is how a good import gets reported as a failure. Observed on a real account: the row
        // landed 6-23s after the import responded, its paths 14 minutes later.
        recheckAfterSeconds: 30,
      };
    }
    if (!r.target) {
      return {
        linkedinUrl: r.url,
        status: "not_a_target" as const,
        isTarget: false,
        hasPaths: false,
        note: "Not one of your targets. Pass `importIfMissing: true` to save them.",
      };
    }
    const t = r.target;
    // `targetPathsCount` reads 0 for an ABSENT field as well as a real zero. Keep the two apart:
    // undefined means "the target did not say", and then the connections response is the authority.
    const reportsPathCount = t.connectionsNumber !== undefined || t.pathsCount !== undefined;
    let pathsCount = reportsPathCount ? targetPathsCount(t) : undefined;
    let topConnector: string | undefined;
    let topRank = targetMaxRank(t);
    /** Set when the target reported no count and we had to read the connections page ourselves. */
    let sawConnections: boolean | undefined;
    // Skip the extra request only when the target EXPLICITLY reported zero paths (common right
    // after an import) — never on an absent field, which would silently drop real connectors.
    if (pathsCount === undefined || pathsCount > 0) {
      try {
        const resp = await client.getTargetConnections(t.id, { pageNumber: 1, resultPerPage: 5 });
        const conns = (resp.connections ?? []).sort((a, b) => connectionRank(b) - connectionRank(a));
        if (conns[0]) {
          topConnector = fullName(conns[0]);
          topRank = connectionRank(conns[0]);
        }
        // The target did not report a count — take the total from the response so we can never
        // claim `hasPaths: false` while returning a connector. `conns.length` is only the TOTAL
        // when this page is the last one; otherwise the count stays unknown rather than wrong.
        if (pathsCount === undefined) {
          if (typeof resp.count === "number") pathsCount = resp.count;
          else if (!resp.nextPage) pathsCount = conns.length;
          sawConnections = conns.length > 0;
        }
      } catch (err) {
        warnings.push(`Could not fetch connections for ${r.url}: ${(err as Error).message}`);
      }
    }
    return {
      linkedinUrl: r.url,
      status: "target" as const,
      isTarget: true,
      targetId: t.id,
      // "1st" degree = directly connected already.
      degree: t.degree,
      directlyConnected: t.degree === "1st",
      // `hasPaths` is answerable even when the exact count is not: seeing one connector is proof
      // of a path. Only when we have neither a count nor a page does it stay null (never a false
      // "no", which is the failure mode this whole tool exists to avoid).
      hasPaths: pathsCount !== undefined ? pathsCount > 0 : (sawConnections ?? null),
      pathsCount,
      topConnector,
      topRank,
    };
  });

  return {
    results,
    telemetry: {
      checked: p.linkedinUrls.length,
      resolved: afterImport.filter((r) => r.target).length,
      importRequested,
      importPending: afterImport.filter((r) => r.importAttempted && !r.target).length,
    },
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---------- intro_status_overview ----------

export interface IntroStatusOverviewParams {
  tagNames?: string[];
}

export async function introStatusOverview(client: DraftboardClient, p: IntroStatusOverviewParams) {
  const targetsPage = await fetchAllPages(
    (pageNumber) => client.listTargets({ tagNames: p.tagNames, pageNumber, resultPerPage: 100 }),
    (r) => r.targets ?? [],
    { maxItems: 2000, maxPages: 40 },
  );

  const byStatus: Record<string, number> = {};
  const byTag: Record<string, Record<string, number>> = {};
  for (const t of targetsPage.items) {
    const s = t.status ?? "unknown";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    for (const tag of t.tags ?? []) {
      byTag[tag] = byTag[tag] ?? {};
      byTag[tag][s] = (byTag[tag][s] ?? 0) + 1;
    }
  }

  return {
    total: targetsPage.total,
    counted: targetsPage.items.length,
    byStatus,
    byTag,
    truncated: targetsPage.truncated,
  };
}

// ---------- registration ----------

export function registerOutcomeTools(server: McpServer, client: DraftboardClient): void {
  server.registerTool(
    "find_top_paths",
    {
      title: "Find top warm-intro paths",
      description:
        "Find the best warm-introduction opportunities right now. Ranks saved targets by best path rank, then fetches each one's strongest connectors and returns the top intro opportunities (connector → target with shared-history `rankDetails`). Use `ownerIds` for paths through specific teammates, `tagNames`/`statuses`/`accountId`/`title` to scope, `connectorsPerTarget`+`includeRankDetails` for cold-email name-drops. To scope to one company (e.g. \"best intros to my OpenAI targets\"), resolve the company with `list_accounts` and pass its id as `accountId`. An opportunity may also carry `relationships` (how the connector and the target know each other — `current_colleague`, `former_colleague`, `university_classmate`) and `relationshipDetails` (the structured shared company / school / mutual-contact records behind `rankDetails`). BOTH KEYS ARE OMITTED WHEN THERE IS NOTHING TO REPORT, which is often: their absence means \"we hold no structured signal for this pair\", NOT \"these two have no relationship\" — never drop or downrank a connector for missing them, and keep reading `rankDetails`. EXPENSIVE: walks connections per target — always scope with filters; do not call with no narrowing on large lists. Returns a `telemetry` block describing coverage.",
      inputSchema: {
        tagNames: z.array(z.string()).optional().describe("Only consider targets with these tags"),
        accountId: z
          .string()
          .optional()
          .describe("Only targets at this company — an account id from `list_accounts`. Scopes 'best intros' to one company."),
        title: z
          .string()
          .optional()
          .describe("Only consider targets whose title/position contains this text (case-insensitive substring)"),
        ownerIds: z.array(z.string()).optional().describe("Only paths through these team members"),
        statuses: z
          .array(z.enum(["new", "completed", "stopped"]))
          .optional()
          .describe('Target statuses to include (default ["new"])'),
        minTargetMaxRank: z.number().min(0).max(100).optional().describe("Skip targets whose best path is weaker than this"),
        minRank: z.number().min(0).max(100).optional().describe("Drop connectors below this rank"),
        limit: z.number().int().positive().max(100).optional().describe("Max opportunities to return (default 20)"),
        maxTargetsScanned: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max targets to fetch connections for (default 25)"),
        connectorsPerTarget: z.number().int().positive().max(10).optional().describe("Top connectors per target (default 3)"),
        includeRankDetails: z.boolean().optional().describe("Include shared-history reasons (default true)"),
        includeRelationships: z
          .boolean()
          .optional()
          .describe(
            "Include `relationships` + `relationshipDetails` whenever the API returns any (default true). " +
              "They are omitted from an opportunity that has none — often, and not evidence " +
              "against that connector.",
          ),
      },
      annotations: READ_ONLY,
    },
    (args) => safeHandler(async () => jsonResult(await findTopPaths(client, args as FindTopPathsParams))),
  );

  server.registerTool(
    "check_if_connected",
    {
      title: "Check if already connected to people",
      description:
        "Given LinkedIn profile URLs, report whether the customer already has warm paths to each person. Looks each URL up directly (one request per person, any book size), then returns per-URL `{status, isTarget, targetId, hasPaths, pathsCount, topConnector, topRank, degree, directlyConnected}`. `status` is `target`, `not_a_target`, `import_pending`, or `lookup_failed`. On `import_pending` and `lookup_failed` the booleans are `null`, NOT false — the answer is unknown, so never tell the user they have no path on the strength of it; re-check instead. By default it imports only the URLs that are not targets yet; Draftboard processes an import batch asynchronously, so those usually come back `import_pending` on this call and resolve moments later. For a SINGLE person where you only need the id or a yes/no, `resolve_target` is one call instead of two.",
      inputSchema: {
        linkedinUrls: z
          .array(z.string().url())
          .min(1)
          .max(10)
          .describe(
            "LinkedIn profile URLs to check (max 10 per call — each costs up to three API reads and the account is limited to 50 reads/minute, so a full batch still leaves headroom; split larger lists across calls)",
          ),
        importIfMissing: z.boolean().optional().describe("Import URLs that are not yet targets (default true)"),
        tags: z.array(z.string()).optional().describe("Tags to apply to any imported targets"),
      },
      // Writes by default: imports any URLs that are not yet targets (importIfMissing defaults true).
      annotations: WRITE,
    },
    (args) => safeHandler(async () => jsonResult(await checkIfConnected(client, args as CheckIfConnectedParams))),
  );

  server.registerTool(
    "intro_status_overview",
    {
      title: "Intro status overview",
      description:
        "Summarize the customer's targets by status (new / completed / stopped), with an optional per-tag breakdown. Use to track progress across requested intros. Optionally scope to `tagNames`.",
      inputSchema: {
        tagNames: z.array(z.string()).optional().describe("Only summarize targets with these tags"),
      },
      annotations: READ_ONLY,
    },
    (args) => safeHandler(async () => jsonResult(await introStatusOverview(client, args as IntroStatusOverviewParams))),
  );
}
