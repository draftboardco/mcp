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

const connection = (id: string, score: number) => ({
  id,
  firstName: id,
  lastName: "C",
  linkedinUrl: `https://linkedin.com/in/${id}`,
  position: { title: "VP" },
  score,
  scoreDetails: [`worked together (${score})`],
  owners: [{ id: "owner1", firstName: "Me", lastName: "", score: 90 }],
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
