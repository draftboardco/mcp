import { describe, expect, it, vi } from "vitest";
import { DraftboardApiError, DraftboardClient } from "../src/client.js";
import { fetchAllPages } from "../src/pagination.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DraftboardClient.buildQuery", () => {
  const client = new DraftboardClient({ apiKey: "k", fetchImpl: vi.fn() });

  it("serializes arrays as repeated keys and skips empties", () => {
    const qs = client.buildQuery({
      tagNames: ["a", "b"],
      statuses: ["new"],
      pageNumber: 2,
      skip: undefined,
      empty: "",
    });
    expect(qs).toBe("?tagNames=a&tagNames=b&statuses=new&pageNumber=2");
  });

  it("returns empty string for no query", () => {
    expect(client.buildQuery()).toBe("");
    expect(client.buildQuery({})).toBe("");
  });

  it("serializes nested objects as bracket notation and keeps boolean false", () => {
    const qs = client.buildQuery({
      filters: { query: "ann", preferred: false, blank: "" },
      paging: { pageNumber: 1, resultPerPage: 20 },
    });
    expect(qs).toBe(
      "?filters%5Bquery%5D=ann&filters%5Bpreferred%5D=false&paging%5BpageNumber%5D=1&paging%5BresultPerPage%5D=20",
    );
  });
});

describe("DraftboardClient extended methods", () => {
  function mock() {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 200 }));
    return { fetchImpl, client: new DraftboardClient({ apiKey: "k", fetchImpl }) };
  }

  it("toggles connector preferred with POST (enable) / DELETE (disable)", async () => {
    const { fetchImpl, client } = mock();
    await client.setConnectorPreferred("c1", true);
    await client.setConnectorPreferred("c1", false);
    expect(fetchImpl.mock.calls[0][1].method).toBe("POST");
    expect(fetchImpl.mock.calls[0][0]).toContain("/connectors/c1/prefer");
    expect(fetchImpl.mock.calls[1][1].method).toBe("DELETE");
  });

  it("sends a body only for declined intro status", async () => {
    const { fetchImpl, client } = mock();
    await client.setIntroStatus("i1", "requested");
    await client.setIntroStatus("i1", "declined", { reasonId: "prospect_declined" });
    expect(fetchImpl.mock.calls[0][0]).toContain("/intros/i1/requested");
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
    expect(fetchImpl.mock.calls[1][0]).toContain("/intros/i1/declined");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ reasonId: "prospect_declined" });
  });

  it("builds nested supporters query from flat params", async () => {
    const { fetchImpl, client } = mock();
    await client.getSupporters({ preferred: true, pageNumber: 2 });
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain("/supporters?");
    expect(decodeURIComponent(url)).toContain("filters[preferred]=true");
    expect(decodeURIComponent(url)).toContain("paging[pageNumber]=2");
  });
});

describe("DraftboardClient.request", () => {
  it("sends Bearer auth and parses JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 200, customer: { id: "c1" } }));
    const client = new DraftboardClient({ apiKey: "secret", fetchImpl });
    const me = await client.getMe();
    expect(me.customer?.id).toBe("c1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://intros.draftboard.com/api/v1/integration/me");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("maps 401 to a friendly, key-free error", async () => {
    // Fresh Response per call — a Response body can only be read once.
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "nope" }, 401));
    const client = new DraftboardClient({ apiKey: "secret", fetchImpl });
    await expect(client.getMe()).rejects.toMatchObject({
      name: "DraftboardApiError",
      status: 401,
    });
    await expect(client.getMe()).rejects.toThrow(/Unauthorized/);
  });

  it("never includes the api key in error output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = new DraftboardClient({ apiKey: "super-secret-key", fetchImpl });
    try {
      await client.listTargets();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DraftboardApiError);
      expect(JSON.stringify(err)).not.toContain("super-secret-key");
    }
  });

  it("encodes path params and array query in connections", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 200, connections: [] }));
    const client = new DraftboardClient({ apiKey: "k", fetchImpl });
    await client.getTargetConnections("a b/c", { ownerIds: ["o1", "o2"] });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/targets/a%20b%2Fc/connections");
    expect(url).toContain("ownerIds=o1&ownerIds=o2");
  });
});

describe("fetchAllPages", () => {
  it("loops until nextPage is 0", async () => {
    const pages = [
      { count: 3, nextPage: 2, items: [{ id: "1" }, { id: "2" }] },
      { count: 3, nextPage: 0, items: [{ id: "3" }] },
    ];
    const fetchPage = vi.fn(async (n: number) => pages[n - 1]);
    const result = await fetchAllPages(fetchPage, (r) => r.items);
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("does not mark truncated when the final page lands exactly on the cap", async () => {
    // 4 items across 2 pages of 2; maxItems=4; last page has nextPage=0 → complete, not truncated.
    const pages = [
      { count: 4, nextPage: 2, items: [{ id: "1" }, { id: "2" }] },
      { count: 4, nextPage: 0, items: [{ id: "3" }, { id: "4" }] },
    ];
    const fetchPage = vi.fn(async (n: number) => pages[n - 1]);
    const result = await fetchAllPages(fetchPage, (r) => r.items, { maxItems: 4 });
    expect(result.items).toHaveLength(4);
    expect(result.truncated).toBe(false);
  });

  it("stops at maxItems and marks truncated", async () => {
    const fetchPage = vi.fn(async (n: number) => ({
      count: 100,
      nextPage: n + 1,
      items: [{ id: `${n}a` }, { id: `${n}b` }],
    }));
    const result = await fetchAllPages(fetchPage, (r) => r.items, { maxItems: 3 });
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(result.truncated).toBe(true);
  });
});
