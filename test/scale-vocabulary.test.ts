import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DraftboardClient } from "../src/client.js";
import { registerThinTools } from "../src/tools/thin.js";
import { registerExtendedTools } from "../src/tools/extended.js";
import { registerProspectingTools } from "../src/tools/prospecting.js";
import { registerOutcomeTools } from "../src/tools/outcomes.js";

/**
 * REGRESSION GUARD for the rating/tier/preferred vocabulary.
 *
 * The scale has drifted twice already because it lives in prose (the app pins its own copy in
 * `goToGrade.test.ts` for the same reason). This suite reads the REAL registered tool
 * descriptions, the REAL zod schemas and the REAL README — it never restates the mapping in its
 * own literal, because a copy of the mapping proves nothing about the strings the model reads.
 *
 * What it pins:
 *  1. Every "N = <meaning>" claim, wherever it is written, agrees with every other one, and the
 *     endpoints agree with the zod bounds that actually validate the argument.
 *  2. The direction of each scale (rating: higher is better; tier: lower is better).
 *  3. ★ glyphs belong to `rating` alone, and their count matches the number they sit next to.
 *  4. `preferred` / `excluded` are never called a star.
 *  5. Docs hygiene: no coverage percentages, no backfill/pipeline history, no derivation formula
 *     between `rating` and `tier` in any customer-visible string.
 */

// ---------------------------------------------------------------- surfaces

interface Surface {
  where: string;
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

function registeredTools(): Record<string, AnyTool> {
  const client = {} as unknown as DraftboardClient;
  const server = new McpServer({ name: "test", version: "0" });
  registerThinTools(server, client);
  registerExtendedTools(server, client);
  registerProspectingTools(server, client);
  registerOutcomeTools(server, client);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools;
}

const TOOLS = registeredTools();

/** Every model-visible string: tool titles, tool descriptions, and every argument description. */
function toolSurfaces(): Surface[] {
  const out: Surface[] = [];
  for (const [name, tool] of Object.entries(TOOLS)) {
    if (tool.title) out.push({ where: `${name}.title`, text: String(tool.title) });
    if (tool.description) out.push({ where: `${name}.description`, text: String(tool.description) });
    for (const [arg, schema] of Object.entries(tool.inputSchema?.shape ?? {})) {
      const description = (schema as AnyTool)?.description;
      if (description) out.push({ where: `${name}.${arg}`, text: String(description) });
    }
  }
  return out;
}

const README = fileURLToPath(new URL("../README.md", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function srcFiles(dir = SRC_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

const MODEL_SURFACES: Surface[] = [
  ...toolSurfaces(),
  { where: "README.md", text: readFileSync(README, "utf8") },
];

/** Everything a customer can read in this published repo: the shipped source plus the README. */
const PUBLISHED_SURFACES: Surface[] = [
  ...srcFiles().map((f) => ({ where: f.slice(SRC_DIR.length + 1), text: readFileSync(f, "utf8") })),
  { where: "README.md", text: readFileSync(README, "utf8") },
];

// ---------------------------------------------------------------- zod bounds (executable truth)

function bounds(tool: string, arg: string): { min: number; max: number } {
  const shape = TOOLS[tool].inputSchema.shape[arg];
  const inner = shape._def.innerType ?? shape;
  const numeric = inner._def.typeName === "ZodArray" ? inner._def.type : inner;
  const checks: { kind: string; value: number }[] = numeric._def.checks ?? [];
  const min = checks.find((c) => c.kind === "min")?.value;
  const max = checks.find((c) => c.kind === "max")?.value;
  expect(min, `${tool}.${arg} has no min bound`).toBeTypeOf("number");
  expect(max, `${tool}.${arg} has no max bound`).toBeTypeOf("number");
  return { min: min as number, max: max as number };
}

const RATING = bounds("set_connector_tier", "rating");
const TIER = bounds("set_connector_tier", "tier");

// ---------------------------------------------------------------- claim parsing

/** The meanings the scale is anchored to. Each must land on exactly one number, everywhere. */
const MEANINGS: { key: string; re: RegExp }[] = [
  { key: "ask anytime", re: /ask anytime/i },
  { key: "do not ask", re: /don['’]t ask|do not ask/i },
  { key: "clear", re: /clear/i },
];

interface Claim {
  scale: "rating" | "tier";
  n: number;
  meaning: string;
  where: string;
}

/**
 * Which scale governs a position: the nearest scale word written before it. An argument's own
 * description need not repeat its name, so the argument being documented is the fallback.
 */
function argScale(where: string): "rating" | "tier" | null {
  if (/\.ratings?$/.test(where)) return "rating";
  if (/\.tiers?$/.test(where)) return "tier";
  return null;
}

function governingScale(text: string, at: number, where = ""): "rating" | "tier" | null {
  const before = text.slice(0, at);
  const rating = Math.max(before.lastIndexOf("rating"), before.lastIndexOf("Rating"));
  const tier = Math.max(before.lastIndexOf("tier"), before.lastIndexOf("Tier"));
  if (rating < 0 && tier < 0) return argScale(where);
  return rating > tier ? "rating" : "tier";
}

/** Pull every "N = <meaning>" claim out of a surface, tagged with the scale that governs it. */
function claimsIn(s: Surface): Claim[] {
  const out: Claim[] = [];
  for (const m of s.text.matchAll(/(\d)\s*=\s*/g)) {
    const window = s.text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const hit = MEANINGS.map((x) => ({ ...x, at: window.search(x.re) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    if (!hit) continue;
    const scale = governingScale(s.text, m.index, s.where);
    expect(scale, `${s.where}: "${m[0]}${window.slice(0, 30)}…" names a number without naming its scale`).not.toBeNull();
    out.push({ scale: scale as "rating" | "tier", n: Number(m[1]), meaning: hit.key, where: s.where });
  }
  return out;
}

const CLAIMS = MODEL_SURFACES.flatMap(claimsIn);

/** The single number every surface agrees this meaning has, on this scale. */
function agreedNumber(scale: "rating" | "tier", meaning: string): number {
  const hits = CLAIMS.filter((c) => c.scale === scale && c.meaning === meaning);
  expect(hits.length, `nothing documents ${scale} "${meaning}" any more`).toBeGreaterThan(0);
  const numbers = [...new Set(hits.map((c) => c.n))];
  expect(
    numbers,
    `${scale} "${meaning}" is documented as ${numbers.join(" and ")} in: ${hits.map((h) => `${h.where}=${h.n}`).join(", ")}`,
  ).toHaveLength(1);
  return numbers[0];
}

// ---------------------------------------------------------------- the guards

describe("the documented scale agrees with itself and with the schema", () => {
  it("every surface anchors the rating on the same numbers", () => {
    // Fails the moment one description drifts away from the others.
    agreedNumber("rating", "ask anytime");
    agreedNumber("rating", "do not ask");
  });

  it("the best/worst rating are the bounds zod actually enforces", () => {
    expect(agreedNumber("rating", "ask anytime")).toBe(RATING.max);
    expect(agreedNumber("rating", "do not ask")).toBe(RATING.min);
  });

  it("the rating reads HIGHER IS BETTER", () => {
    expect(agreedNumber("rating", "ask anytime")).toBeGreaterThan(agreedNumber("rating", "do not ask"));
  });

  it("the tier reads LOWER IS BETTER, and its ends match the schema", () => {
    const best = agreedNumber("tier", "ask anytime");
    const worst = agreedNumber("tier", "do not ask");
    const clear = agreedNumber("tier", "clear");
    expect(best).toBeLessThan(worst);
    expect(worst).toBe(TIER.max);
    expect(clear).toBe(TIER.min);
    expect(best).toBeGreaterThan(clear);
  });

  it("the rating filter accepts exactly the rating scale", () => {
    expect(bounds("list_supporters", "ratings")).toEqual(RATING);
  });
});

describe("★ belongs to the rating and to nothing else", () => {
  it("every ★ run sits on the rating scale, with as many glyphs as the number it labels", () => {
    let seen = 0;
    for (const s of MODEL_SURFACES) {
      for (const m of s.text.matchAll(/★+/g)) {
        seen += 1;
        const lookback = s.text.slice(Math.max(0, m.index - 40), m.index);
        const digits = lookback.match(/\d/g);
        expect(digits, `${s.where}: "${m[0]}" is not attached to any number`).not.toBeNull();
        const n = Number((digits as string[])[digits!.length - 1]);
        expect(n, `${s.where}: "${m[0]}" (${m[0].length} glyphs) labels ${n}`).toBe(m[0].length);
        expect(governingScale(s.text, m.index, s.where), `${s.where}: ★ used on a non-rating scale`).toBe("rating");
      }
    }
    expect(seen, "the star glyphs vanished — the rating is the thing that carries them").toBeGreaterThan(0);
  });

  it("the legacy preferred/excluded surfaces are never called a star", () => {
    const legacy = MODEL_SURFACES.filter(
      (s) => s.where.startsWith("set_connector_preferred") || s.where.startsWith("set_connector_excluded") || s.where === "list_supporters.preferred",
    );
    expect(legacy.length, "the legacy tools disappeared — they must keep working").toBeGreaterThan(0);
    for (const s of legacy) {
      expect(s.text, `${s.where} calls the preferred flag a star`).not.toMatch(/star/i);
      expect(s.text, `${s.where} puts ★ on the preferred flag`).not.toMatch(/★/);
    }
  });
});

describe("set and search stay separable", () => {
  it("both legacy toggles are still registered", () => {
    expect(Object.keys(TOOLS)).toEqual(
      expect.arrayContaining(["set_connector_tier", "list_supporters", "set_connector_preferred", "set_connector_excluded"]),
    );
  });

  it("the rating tool says it sets and points at the search tool", () => {
    const d = String(TOOLS.set_connector_tier.description);
    expect(d).toMatch(/\bSET\b/);
    expect(d).toMatch(/list_supporters/);
  });

  it("the supporters tool says it searches and points at the set tool", () => {
    const d = String(TOOLS.list_supporters.description);
    expect(d).toMatch(/SEARCH/);
    expect(d).toMatch(/set_connector_tier/);
  });

  it("states that setting a rating does not write the preferred flag", () => {
    const d = String(TOOLS.set_connector_preferred.description);
    expect(d).toMatch(/does not write the `preferred` column/i);
  });

  it("states that the excluded sync runs one way", () => {
    const d = String(TOOLS.set_connector_excluded.description);
    expect(d).toMatch(/ONE WAY/i);
    expect(d).toMatch(/does NOT clear a `rating: 1`/i);
  });
});

describe("customer-facing docs state the contract, not the kitchen", () => {
  const BANNED: { name: string; re: RegExp }[] = [
    { name: "a coverage percentage", re: /\d+(\.\d+)?\s*%/ },
    { name: "the word backfill", re: /backfill/i },
    { name: "a rating/tier derivation formula", re: /\b6\s*[-–—−]\s*(tier|rating)\b|\b(tier|rating)\s*=\s*6\b/i },
    { name: "a 'counts the other way round' derivation", re: /counts? (the )?other way|counting DOWN/i },
    // Widened after a FALSE GREEN: the original pattern had no "common case" alternative, so it
    // passed while that exact phrase sat in two of the surfaces it scans. Frequency claims about
    // coverage are banned in every synonym, not just the two we happened to write first.
    {
      name: "a frequency claim about coverage",
      re: /\bmajority\b|\b(the )?common case\b|most (connections|relationships|ranks|scored|opportunities|intros)|\b(usually|typically|often|rarely|seldom|sparse[rl]?y?) (empty|absent|omitted|present|populated)\b|far more often|\bsparser\b/i,
    },
    { name: "our scoring pipeline's history", re: /before \w+ 20\d\d|predate|no backfill/i },
  ];

  it.each(BANNED)("no model-visible string leaks $name", ({ name, re }) => {
    const bad = MODEL_SURFACES.filter((s) => re.test(s.text)).map(
      (s) => `${s.where}: "${s.text.match(re)?.[0]}"`,
    );
    expect(bad, `${name} leaked into: ${bad.join(" | ")}`).toEqual([]);
  });

  it.each(BANNED)("no published source file leaks $name", ({ name, re }) => {
    const bad = PUBLISHED_SURFACES.filter((s) => re.test(s.text)).map(
      (s) => `${s.where}: "${s.text.match(re)?.[0]}"`,
    );
    expect(bad, `${name} leaked into: ${bad.join(" | ")}`).toEqual([]);
  });

  it("keeps the behavioural instruction the hygiene rule must not take with it", () => {
    const connections = String(TOOLS.get_target_connections.description);
    expect(connections).toMatch(/relationships \?\? \[\]/);
    expect(connections).toMatch(/NEVER demote on its absence/i);
    expect(connections).toMatch(/scoreDetails/);
  });
});
