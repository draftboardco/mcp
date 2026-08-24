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
  // repeated field entirely, and that is the majority case in production.
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
    // The API omits both keys when empty (never `[]`), which is the majority of production ranks.
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
  it("matches by normalized linkedin url and reports paths", async () => {
    const importTargets = vi.fn(async () => ({ status: 200 }));
    const client = fakeClient({
      importTargets,
      listTargets: vi.fn(async () => ({
        status: 200,
        nextPage: 0,
        targets: [target("dave", { score: 70, connectionsNumber: 3, degree: "1st" })],
      })),
      getTargetConnections: vi.fn(async () => ({
        status: 200,
        nextPage: 0,
        connections: [connection("ed", 70)],
      })),
    });

    const out = await checkIfConnected(client, {
      // different casing / trailing slash / http vs https than the stored target
      linkedinUrls: ["http://LinkedIn.com/in/dave", "https://www.linkedin.com/in/nobody/"],
    });
    expect(importTargets).toHaveBeenCalled();
    const dave = out.results.find((r) => r.linkedinUrl.includes("dave"))!;
    expect(dave).toMatchObject({
      isTarget: true,
      hasPaths: true,
      pathsCount: 3,
      topConnector: "ed C",
      degree: "1st",
      directlyConnected: true,
    });
    const nobody = out.results.find((r) => r.linkedinUrl.includes("nobody"))!;
    expect(nobody).toMatchObject({ isTarget: false, hasPaths: false });
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
