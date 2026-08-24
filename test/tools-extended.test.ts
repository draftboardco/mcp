import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DraftboardClient } from "../src/client.js";
import { registerExtendedTools } from "../src/tools/extended.js";

/**
 * Drive the REGISTERED tool, not the client, so the schema is exercised too: a key the
 * zod shape does not declare is stripped silently, which is exactly the failure this
 * suite exists to catch.
 */
function listSupporters() {
  const calls: Record<string, unknown>[] = [];
  const client = {
    getSupporters: async (p: Record<string, unknown>) => {
      calls.push(p);
      return { supporters: [], count: 0 };
    },
  } as unknown as DraftboardClient;

  const server = new McpServer({ name: "test", version: "0" });
  registerExtendedTools(server, client);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (server as any)._registeredTools["list_supporters"].handler;
  return { calls, call: (args: Record<string, unknown>) => handler(args, {}) };
}

describe("list_supporters — the rating filter accepts both spellings", () => {
  // The HTTP API spells this filter `filters[rating][]` (singular); the MCP arg is `ratings`
  // for symmetry with the existing `tiers`. A model that read the public API docs will pass
  // the singular. Without the alias zod drops it and the call returns an UNFILTERED list —
  // a silent wrong answer, not an error.
  it("accepts the wire spelling `rating`", async () => {
    const { calls, call } = listSupporters();
    await call({ rating: [1] });
    expect(calls[0].ratings).toEqual([1]);
  });

  it("accepts the MCP spelling `ratings`", async () => {
    const { calls, call } = listSupporters();
    await call({ ratings: [5] });
    expect(calls[0].ratings).toEqual([5]);
  });

  it("unions both spellings and de-duplicates", async () => {
    const { calls, call } = listSupporters();
    await call({ ratings: [5], rating: [5, 1] });
    expect([...(calls[0].ratings as number[])].sort()).toEqual([1, 5]);
  });

  it("passes no rating filter when neither is given", async () => {
    const { calls, call } = listSupporters();
    await call({ query: "dana" });
    expect(calls[0].ratings).toBeUndefined();
  });
});
