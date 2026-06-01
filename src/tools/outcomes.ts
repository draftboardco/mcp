import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DraftboardClient } from "../client.js";
import { fetchAllPages } from "../pagination.js";
import {
  connectionRank,
  connectionRankDetails,
  fullName,
  linkedin,
  normalizeLinkedinUrl,
  targetMaxRank,
  targetPathsCount,
} from "../normalize.js";
import type { IntegrationTarget } from "../types.js";
import { jsonResult, safeHandler } from "./util.js";

const TARGETS_FETCH_CAP = 200;

// ---------- find_top_paths ----------

export interface FindTopPathsParams {
  tagNames?: string[];
  ownerIds?: string[];
  statuses?: string[];
  minTargetMaxRank?: number;
  minRank?: number;
  limit?: number;
  maxTargetsScanned?: number;
  connectorsPerTarget?: number;
  includeRankDetails?: boolean;
}

export async function findTopPaths(client: DraftboardClient, p: FindTopPathsParams) {
  const statuses = p.statuses ?? ["new"];
  const connectorsPerTarget = p.connectorsPerTarget ?? 3;
  const maxTargetsScanned = p.maxTargetsScanned ?? 25;
  const minRank = p.minRank ?? 0;

  const targetsPage = await fetchAllPages(
    (pageNumber) =>
      client.listTargets({ tagNames: p.tagNames, statuses, pageNumber, resultPerPage: 50 }),
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

export interface CheckIfConnectedParams {
  linkedinUrls: string[];
  importIfMissing?: boolean;
  tags?: string[];
}

export async function checkIfConnected(client: DraftboardClient, p: CheckIfConnectedParams) {
  const warnings: string[] = [];
  if (p.importIfMissing !== false) {
    try {
      await client.importTargets({ linkedinUrls: p.linkedinUrls, tags: p.tags });
    } catch (err) {
      warnings.push(`Import step failed (continuing with existing targets): ${(err as Error).message}`);
    }
  }

  const targetsPage = await fetchAllPages(
    (pageNumber) => client.listTargets({ pageNumber, resultPerPage: 100 }),
    (r) => r.targets ?? [],
    { maxItems: 1000, maxPages: 20 },
  );

  const byUrl = new Map<string, IntegrationTarget>();
  for (const t of targetsPage.items) {
    const key = normalizeLinkedinUrl(linkedin(t));
    if (key) byUrl.set(key, t);
  }

  const results = [];
  for (const url of p.linkedinUrls) {
    const t = byUrl.get(normalizeLinkedinUrl(url));
    if (!t) {
      results.push({
        linkedinUrl: url,
        isTarget: false,
        hasPaths: false,
        note: "Not found as a target yet. Import/enrichment may still be in progress — re-check shortly.",
      });
      continue;
    }
    const pathsCount = targetPathsCount(t);
    let topConnector: string | undefined;
    let topRank = targetMaxRank(t);
    try {
      const resp = await client.getTargetConnections(t.id, { pageNumber: 1, resultPerPage: 5 });
      const conns = (resp.connections ?? []).sort((a, b) => connectionRank(b) - connectionRank(a));
      if (conns[0]) {
        topConnector = fullName(conns[0]);
        topRank = connectionRank(conns[0]);
      }
    } catch (err) {
      warnings.push(`Could not fetch connections for ${url}: ${(err as Error).message}`);
    }
    results.push({
      linkedinUrl: url,
      isTarget: true,
      targetId: t.id,
      // "1st" degree = directly connected already.
      degree: t.degree,
      directlyConnected: t.degree === "1st",
      hasPaths: pathsCount > 0,
      pathsCount,
      topConnector,
      topRank,
    });
  }

  return {
    results,
    telemetry: { checked: p.linkedinUrls.length, targetsScanned: targetsPage.items.length, truncated: targetsPage.truncated },
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
        "Find the best warm-introduction opportunities right now. Ranks saved targets by best path rank, then fetches each one's strongest connectors and returns the top intro opportunities (connector → target with shared-history `rankDetails`). Use `ownerIds` for paths through specific teammates, `tagNames`/`statuses` to scope, `connectorsPerTarget`+`includeRankDetails` for cold-email name-drops. EXPENSIVE: walks connections per target — always scope with filters; do not call with no narrowing on large lists. Returns a `telemetry` block describing coverage.",
      inputSchema: {
        tagNames: z.array(z.string()).optional().describe("Only consider targets with these tags"),
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
      },
    },
    (args) => safeHandler(async () => jsonResult(await findTopPaths(client, args as FindTopPathsParams))),
  );

  server.registerTool(
    "check_if_connected",
    {
      title: "Check if already connected to people",
      description:
        "Given LinkedIn profile URLs, report whether the customer already has warm paths to each person. By default imports any that are not yet targets, then returns per-URL `{hasPaths, pathsCount, topConnector, topRank}`. Newly imported people may need enrichment before paths appear.",
      inputSchema: {
        linkedinUrls: z.array(z.string().url()).min(1).describe("LinkedIn profile URLs to check"),
        importIfMissing: z.boolean().optional().describe("Import URLs that are not yet targets (default true)"),
        tags: z.array(z.string()).optional().describe("Tags to apply to any imported targets"),
      },
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
    },
    (args) => safeHandler(async () => jsonResult(await introStatusOverview(client, args as IntroStatusOverviewParams))),
  );
}
