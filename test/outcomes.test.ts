import { describe, expect, it, vi } from "vitest";
import type { DraftboardClient } from "../src/client.js";
import {
  checkIfConnected,
  findTopPaths,
  introStatusOverview,
} from "../src/tools/outcomes.js";

/** Build a fake client whose methods are vi.fn()s; cast to DraftboardClient for the functions. */
function fakeClient(overrides: Partial<Record<keyof DraftboardClient, unknown>>): DraftboardClient {
  return overrides as unknown as DraftboardClient;
}

// Current API shape: FLAT name fields, `score`, `connectionsNumber`, `scoreDetails`.
const target = (id: string, opts: Record<string, unknown> = {}) => ({
  id,
  firstName: id,
  lastName: "T",
  linkedinUrl: `https://www.linkedin.com/in/${id}/`,
  status: "new",
  position: { companyName: "Acme" },
  score: 50,
  connectionsNumber: 5,
  tags: ["q1"],
  ...opts,
});

const connection = (id: string, score: number, opts: Record<string, unknown> = {}) => ({
  id,
  firstName: id,
  lastName: "C",
  linkedinUrl: `https://linkedin.com/in/${id}`,
  position: { title: "VP" },
  score,
  scoreDetails: [`worked together (${score})`],
  owners: [{ id: "owner1", firstName: "Me", lastName: "", score: 90 }],
  // NOTE: no `relationships` / `relationshipDetails` keys by default — the API omits an empty
  // repeated field entirely — the key is simply not in the JSON.
  ...opts,
});

describe("findTopPaths", () => {
  it("ranks opportunities by connector rank and reports telemetry", async () => {
    const client = fakeClient({
      listTargets: vi.fn(async () => ({
        status: 200,
        count: 2,
        nextPage: 0,
        targets: [target("low", { score: 30 }), target("high", { score: 90 })],
      })),
      getTargetConnections: vi.fn(async (id: string) => ({
        status: 200,
        count: 2,
        nextPage: 0,
        connections:
          id === "high"
            ? [connection("alice", 80), connection("bob", 40)]
            : [connection("carol", 20)],
      })),
    });

    const out = await findTopPaths(client, { connectorsPerTarget: 2 });
    // Highest-rank target scanned first; opportunities sorted by rank desc.
    expect(out.opportunities[0]).toMatchObject({ connector: "alice C", rank: 80 });
    expect(out.opportunities.map((o) => o.rank)).toEqual([80, 40, 20]);
    expect(out.telemetry.targetsMatched).toBe(2);
    expect(out.telemetry.targetsScanned).toBe(2);
    expect(out.telemetry.connectionsFetched).toBe(3);
    expect(out.telemetry.truncated).toBe(false);
    // rankDetails included by default
    expect((out.opportunities[0] as Record<string, unknown>).rankDetails).toBeDefined();
  });

  it("defaults to status 'new' and tolerates the legacy nested/maxRank/rank shape", async () => {
    const listTargets = vi.fn(async () => ({
      status: 200,
      count: 1,
      nextPage: 0,
      // legacy shape: nested profile + maxRank/pathsCount
      targets: [{ id: "x", profile: { firstName: "Xavier", lastName: "Y" }, maxRank: 50, pathsCount: 2, status: "new" }],
    }));
    const client = fakeClient({
      listTargets,
      getTargetConnections: vi.fn(async () => ({
        status: 200,
        nextPage: 0,
        // legacy connection shape: nested profile + rank/rankDetails
        connections: [{ id: "z", profile: { firstName: "Zoe", lastName: "Q" }, rank: 65, rankDetails: ["x"] }],
      })),
    });
    const out = await findTopPaths(client, {});
    expect(listTargets).toHaveBeenCalledWith(expect.objectContaining({ statuses: ["new"] }));
    expect(out.opportunities[0].rank).toBe(65);
    expect(out.opportunities[0].connector).toBe("Zoe Q");
    expect(out.opportunities[0].target).toBe("Xavier Y");
  });

  it("preserves relationships and relationshipDetails on the opportunity", async () => {
    // find_top_paths hand-builds each opportunity, so anything not explicitly copied is DROPPED.
    const client = fakeClient({
      listTargets: vi.fn(async () => ({
        status: 200,
        count: 1,
        nextPage: 0,
        targets: [target("acme")],
      })),
      getTargetConnections: vi.fn(async () => ({
        status: 200,
        nextPage: 0,
        connections: [
          connection("alice", 80, {
            relationships: ["current_colleague", "university_classmate"],
            relationshipDetails: [
              {
                employment: {
                  company: "Apalon",
                  department: "Engineering",
                  location: "Minsk",
                  overlapStartDate: "2019-03-01",
                  overlapEndDate: "2021-06-30",
                  loose: false,
                  unit: "Mobile",
                },
                score: 40,
              },
              { education: { school: "BSU", overlapStartDate: "2012-09-01" }, score: 20 },
              { mutualConnections: { count: 7 }, score: 10 },
            ],
          }),
        ],
      })),
    });

    const out = await findTopPaths(client, {});
    const opp = out.opportunities[0] as Record<string, unknown>;
    expect(opp.relationships).toEqual(["current_colleague", "university_classmate"]);
    const details = opp.relationshipDetails as Record<string, unknown>[];
    expect(details).toHaveLength(3);
    expect(details[0]).toEqual({
      employment: {
        company: "Apalon",
        department: "Engineering",
        location: "Minsk",
        overlapStartDate: "2019-03-01",
        overlapEndDate: "2021-06-30",
        loose: false,
        unit: "Mobile",
      },
      score: 40,
    });
    // A mutual-connections signal has no `relationships` counterpart — the two are independent.
    expect(details[2]).toEqual({ mutualConnections: { count: 7 }, score: 10 });
  });

  it("handles connections where the relationship keys are absent, without emitting undefined", async () => {
    // The API omits both keys when empty (never `[]`) — the key is not in the JSON at all.
    const client = fakeClient({
      listTargets: vi.fn(async () => ({ status: 200, count: 1, nextPage: 0, targets: [target("acme")] })),
      getTargetConnections: vi.fn(async () => ({
        status: 200,
        nextPage: 0,
        connections: [connection("bob", 55)],
      })),
    });

    const out = await findTopPaths(client, {});
    const opp = out.opportunities[0] as Record<string, unknown>;
    expect(opp.rank).toBe(55);
    // Absent in → absent out: no key, and never a literal `undefined` in the JSON payload.
    expect("relationships" in opp).toBe(false);
    expect("relationshipDetails" in opp).toBe(false);
    expect(JSON.stringify(out)).not.toContain("undefined");
  });

  it("drops the relationship fields when includeRelationships is false", async () => {
    const client = fakeClient({
      listTargets: vi.fn(async () => ({ status: 200, count: 1, nextPage: 0, targets: [target("acme")] })),
      getTargetConnections: vi.fn(async () => ({
        status: 200,
        nextPage: 0,
        connections: [connection("alice", 80, { relationships: ["former_colleague"] })],
      })),
    });

    const out = await findTopPaths(client, { includeRelationships: false });
    expect("relationships" in (out.opportunities[0] as Record<string, unknown>)).toBe(false);
  });

  it("scopes to a company by forwarding accountId to listTargets", async () => {
    const listTargets = vi.fn(async () => ({ status: 200, count: 0, nextPage: 0, targets: [] }));
    const getTargetConnections = vi.fn();
    const client = fakeClient({ listTargets, getTargetConnections });
    await findTopPaths(client, { accountId: "acc1" });
    expect(listTargets).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc1" }));
    // no targets at that company → no connection walk
    expect(getTargetConnections).not.toHaveBeenCalled();
  });
});

describe("checkIfConnected", () => {
  /** Fails the test if the page walk ever comes back. */
  const forbiddenListTargets = () =>
    vi.fn(async () => {
      throw new Error("checkIfConnected must not page the target list");
    });

  const dave = () => target("dave", { score: 70, connectionsNumber: 3, degree: "1st" });

  it("resolves each url directly and never pages the target list", async () => {
    const listTargets = forbiddenListTargets();
    const resolveTarget = vi.fn(async (url: string) => (url.includes("dave") ? dave() : null));
    const client = fakeClient({
      listTargets,
      resolveTarget,
      getTargetConnections: vi.fn(async () => ({
        status: 200,
        nextPage: 0,
        connections: [connection("ed", 70)],
      })),
    });

    const out = await checkIfConnected(client, {
      // casing / trailing slash / http-vs-https are the server's problem now: it matches on the
      // vanity slug. We pass the URL through untouched.
      linkedinUrls: ["http://LinkedIn.com/in/dave", "https://www.linkedin.com/in/nobody/"],
      importIfMissing: false,
    });

    expect(listTargets).not.toHaveBeenCalled();
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    expect(out.results.find((r) => r.linkedinUrl.includes("dave"))).toMatchObject({
      isTarget: true,
      targetId: "dave",
      hasPaths: true,
      pathsCount: 3,
      topConnector: "ed C",
      topRank: 70,
      degree: "1st",
      directlyConnected: true,
    });
    expect(out.results.find((r) => r.linkedinUrl.includes("nobody"))).toMatchObject({
      isTarget: false,
      hasPaths: false,
    });
    expect(out.telemetry).toMatchObject({ checked: 2, resolved: 1 });
  });

  it("finds a target the old 1000-item page walk would have missed", async () => {
    // The regression this replaces: `list_targets` returns the head of a huge book and the
    // wanted person is not in it, so the tool used to answer `isTarget: false`.
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => target("buried", { connectionsNumber: 0 })),
      getTargetConnections: vi.fn(async () => ({ status: 200, nextPage: 0, connections: [] })),
    });

    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/buried/"],
      importIfMissing: false,
    });
    expect(out.results[0]).toMatchObject({ isTarget: true, targetId: "buried", hasPaths: false });
    expect(out.warnings).toBeUndefined();
  });

  it("skips the connections call when the target reports zero paths", async () => {
    const getTargetConnections = vi.fn();
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => target("fresh", { connectionsNumber: 0, score: 0 })),
      getTargetConnections,
    });
    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/fresh/"],
      importIfMissing: false,
    });
    expect(getTargetConnections).not.toHaveBeenCalled();
    expect(out.results[0]).toMatchObject({ isTarget: true, hasPaths: false, pathsCount: 0 });
  });

  it("still fetches connections when the target carries no path-count field at all", async () => {
    // An absent count reads as 0 — trusting that would silently drop real connectors.
    const noCount = { id: "old", firstName: "Old", lastName: "T", status: "new" };
    const getTargetConnections = vi.fn(async () => ({
      status: 200,
      nextPage: 0,
      connections: [connection("ed", 70)],
    }));
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => noCount),
      getTargetConnections,
    });
    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/old/"],
      importIfMissing: false,
    });
    expect(getTargetConnections).toHaveBeenCalledTimes(1);
    expect(out.results[0]).toMatchObject({ isTarget: true, topConnector: "ed C", topRank: 70 });
  });

  it("treats a miss as a normal answer, not a warning", async () => {
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => null),
      getTargetConnections: vi.fn(),
    });
    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/nobody/"],
      importIfMissing: false,
    });
    expect(out.results[0].isTarget).toBe(false);
    expect(out.warnings).toBeUndefined();
  });

  it("imports only the urls that are not targets yet, and hands back the new id", async () => {
    const importTargets = vi.fn(async () => ({ status: 200 }));
    // First pass: dave exists, newbie does not. After the import, newbie resolves.
    const seen = new Set<string>();
    const resolveTarget = vi.fn(async (url: string) => {
      if (url.includes("dave")) return dave();
      if (seen.has(url)) return target("newbie", { connectionsNumber: 0 });
      seen.add(url);
      return null;
    });
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget,
      importTargets,
      getTargetConnections: vi.fn(async () => ({ status: 200, nextPage: 0, connections: [] })),
    });

    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/dave/", "https://www.linkedin.com/in/newbie/"],
      tags: ["q1"],
    });

    expect(importTargets).toHaveBeenCalledTimes(1);
    expect(importTargets).toHaveBeenCalledWith({
      linkedinUrls: ["https://www.linkedin.com/in/newbie/"],
      tags: ["q1"],
    });
    expect(out.results.find((r) => r.linkedinUrl.includes("newbie"))).toMatchObject({
      isTarget: true,
      targetId: "newbie",
      hasPaths: false,
    });
    expect(out.telemetry).toMatchObject({ checked: 2, importRequested: 1, importPending: 0 });
  });

  it("does not call import when every url already resolves", async () => {
    const importTargets = vi.fn(async () => ({ status: 200 }));
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => dave()),
      importTargets,
      getTargetConnections: vi.fn(async () => ({ status: 200, nextPage: 0, connections: [] })),
    });
    await checkIfConnected(client, { linkedinUrls: ["https://www.linkedin.com/in/dave/"] });
    expect(importTargets).not.toHaveBeenCalled();
  });

  it("turns a lookup failure into a warning and never imports over it", async () => {
    const importTargets = vi.fn(async () => ({ status: 200 }));
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => {
        throw new Error("boom");
      }),
      importTargets,
      getTargetConnections: vi.fn(),
    });

    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/flaky/"],
    });
    // A failed lookup must NOT read as a definitive "no" — that is a wrong answer, not a slow one.
    expect(out.results[0]).toMatchObject({ status: "lookup_failed", isTarget: null, hasPaths: null });
    expect(out.warnings?.[0]).toContain("boom");
    // It is also not evidence the person is missing, so it must not be imported.
    expect(importTargets).not.toHaveBeenCalled();
  });

  it("re-checks after an import that reports an error — a partial import still saved people", async () => {
    const importTargets = vi.fn(async () => {
      throw new Error("partial failure");
    });
    const seen = new Set<string>();
    const resolveTarget = vi.fn(async (url: string) => {
      if (seen.has(url)) return target("saved-anyway", { connectionsNumber: 0 });
      seen.add(url);
      return null;
    });
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget,
      importTargets,
      getTargetConnections: vi.fn(),
    });

    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/newbie/"],
    });
    expect(out.results[0]).toMatchObject({ status: "target", targetId: "saved-anyway" });
    // The error is still surfaced, but it does not erase what actually landed.
    expect(out.warnings?.[0]).toContain("partial failure");
    expect(out.telemetry).toMatchObject({ importRequested: 1, importPending: 0 });
  });

  it("reports import_pending — not 'not a target' — while the async import lands", async () => {
    // intro-svc processes an import batch fire-and-forget, so the row usually is not there yet.
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => null),
      importTargets: vi.fn(async () => ({ status: 200 })),
      getTargetConnections: vi.fn(),
    });
    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/brand-new/"],
    });
    expect(out.results[0]).toMatchObject({
      status: "import_pending",
      isTarget: null,
      hasPaths: null,
    });
    expect(out.telemetry).toMatchObject({ importRequested: 1, importPending: 1 });
  });

  it("does not present one connections page as the total path count", async () => {
    const noCount = { id: "old", firstName: "Old", lastName: "T", status: "new" };
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => noCount),
      // No `count`, and there IS another page — 5 rows are not the total.
      getTargetConnections: vi.fn(async () => ({
        status: 200,
        nextPage: 2,
        connections: [connection("ed", 70)],
      })),
    });
    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/old/"],
      importIfMissing: false,
    });
    // Seeing a connector proves a path exists; the exact count stays unknown rather than wrong.
    expect(out.results[0]).toMatchObject({ hasPaths: true, topConnector: "ed C" });
    expect(out.results[0]).not.toHaveProperty("pathsCount", 1);
  });

  it("takes the path count from the connections page when the target reports none", async () => {
    const noCount = { id: "old", firstName: "Old", lastName: "T", status: "new" };
    const client = fakeClient({
      listTargets: forbiddenListTargets(),
      resolveTarget: vi.fn(async () => noCount),
      getTargetConnections: vi.fn(async () => ({
        status: 200,
        count: 12,
        nextPage: 0,
        connections: [connection("ed", 70)],
      })),
    });
    const out = await checkIfConnected(client, {
      linkedinUrls: ["https://www.linkedin.com/in/old/"],
      importIfMissing: false,
    });
    // Never "hasPaths: false" next to a topConnector.
    expect(out.results[0]).toMatchObject({
      hasPaths: true,
      pathsCount: 12,
      topConnector: "ed C",
    });
  });
});

describe("introStatusOverview", () => {
  it("aggregates by status and tag", async () => {
    const client = fakeClient({
      listTargets: vi.fn(async () => ({
        status: 200,
        count: 3,
        nextPage: 0,
        targets: [
          target("a", { status: "new", tags: ["q1"] }),
          target("b", { status: "completed", tags: ["q1", "vip"] }),
          target("c", { status: "new", tags: ["vip"] }),
        ],
      })),
    });
    const out = await introStatusOverview(client, {});
    expect(out.byStatus).toEqual({ new: 2, completed: 1 });
    expect(out.byTag.q1).toEqual({ new: 1, completed: 1 });
    expect(out.byTag.vip).toEqual({ completed: 1, new: 1 });
    expect(out.total).toBe(3);
  });
});
