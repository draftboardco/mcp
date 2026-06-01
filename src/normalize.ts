import type { IntegrationConnection, IntegrationTarget, Person } from "./types.js";

/**
 * Tolerant field readers. The current API uses FLAT name fields and `score`/`connectionsNumber`/
 * `scoreDetails`; older docs nested under `profile` and used `maxRank`/`rank`/`rankDetails`. Each
 * reader accepts either form so the tools work regardless.
 */

export function targetMaxRank(t: IntegrationTarget): number {
  return numberOr(t.score ?? t.maxRank, 0);
}

export function targetPathsCount(t: IntegrationTarget): number {
  return numberOr(t.connectionsNumber ?? t.pathsCount, 0);
}

export function connectionRank(c: IntegrationConnection): number {
  return numberOr(c.score ?? c.rank, 0);
}

export function connectionRankDetails(c: IntegrationConnection): string[] {
  return c.scoreDetails ?? c.rankDetails ?? [];
}

/** Full name from flat fields (current) or a nested `profile` (legacy). */
export function fullName(p?: Person): string {
  if (!p) return "";
  const first = p.firstName ?? p.profile?.firstName ?? "";
  const last = p.lastName ?? p.profile?.lastName ?? "";
  return `${first} ${last}`.trim();
}

/** LinkedIn URL from flat field (current) or nested `profile` (legacy). */
export function linkedin(p?: Person): string | undefined {
  if (!p) return undefined;
  return p.linkedinUrl ?? p.profile?.linkedinUrl;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize a LinkedIn profile URL for equality comparison:
 * lowercase host, strip protocol/`www.`/query/hash and trailing slash.
 */
export function normalizeLinkedinUrl(url?: string): string {
  if (!url) return "";
  let u = url.trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.split("?")[0].split("#")[0];
  return u.replace(/\/+$/, "");
}
