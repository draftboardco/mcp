/**
 * Response shapes for the Draftboard Integration API, matching the authoritative current
 * DTOs in `api-gateway/src/intro/integration.dto.ts`: name fields are FLAT (firstName,
 * lastName, linkedinUrl), targets carry `score` + `connectionsNumber`, connections carry
 * `score` + `scoreDetails` + `owners`. Older/idealized docs nested these under `profile` and
 * used `maxRank`/`rank`/`rankDetails`; the optional aliases below keep the tools tolerant of
 * either form. All fields are optional so a shape drift never crashes a tool.
 *
 * Repeated fields (`relationships`, `relationshipDetails`) are ABSENT when empty — the API omits
 * an empty array rather than sending `[]` — so every reader must default them with `?? []`.
 */

export interface Profile {
  firstName?: string;
  lastName?: string;
  linkedinUrl?: string;
}

export interface Position {
  title?: string;
  companyName?: string;
  companyLinkedinUrl?: string;
}

/** A person with flat name fields (current API) or a nested `profile` (legacy/tolerant). */
export interface Person extends Profile {
  profile?: Profile;
}

export interface Member extends Person {
  id?: string;
  /** Relationship strength (0-100) between this team member and the connector. */
  score?: number;
}

export interface IntegrationTarget extends Person {
  id: string;
  status?: string; // new | completed | stopped
  position?: Position;
  headline?: string;
  /** Relationship/best-path score to this target, 0-100. (`maxRank` = legacy alias.) */
  score?: number;
  maxRank?: number;
  /** Number of available connections/paths. (`pathsCount` = legacy alias.) */
  connectionsNumber?: number;
  pathsCount?: number;
  /** "1st" (directly connected) or "2nd" (reachable via one connector); absent if no path. */
  degree?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * How a connector and a target know each other, as data. The API emits only these three values.
 *
 * Kept as a documented union rather than the type of `relationships` itself: the wire field stays
 * `string[]` so an unknown future value can never break a tool.
 */
export type RelationshipKind = "current_colleague" | "former_colleague" | "university_classmate";

/** A shared employer. Both overlap dates absent = same company but never at the same time (or `loose`). */
export interface RelationshipEmployment {
  company?: string;
  department?: string;
  location?: string;
  /** ISO `yyyy-MM-dd`. Present ⇒ the two were there at the same time. */
  overlapStartDate?: string;
  /** ISO `yyyy-MM-dd`. Absent while the overlap is ongoing. */
  overlapEndDate?: string;
  /** Low-confidence same-org affiliation; when true the overlap window is omitted on purpose. */
  loose?: boolean;
  unit?: string;
}

/** A shared school. Dates are ISO `yyyy-MM-dd`; both absent when the window is unknown. */
export interface RelationshipEducation {
  school?: string;
  overlapStartDate?: string;
  overlapEndDate?: string;
}

/** Shared contacts: how many people both the connector and the target know. */
export interface RelationshipMutualConnections {
  count?: number;
}

/**
 * One structured relationship signal between the connector and the target — the machine-readable
 * half of `scoreDetails`. Exactly ONE of `employment` / `education` / `mutualConnections` is set
 * per record; `score` is that record's contribution to the relationship score.
 */
export interface RelationshipDetail {
  employment?: RelationshipEmployment;
  education?: RelationshipEducation;
  mutualConnections?: RelationshipMutualConnections;
  score?: number;
}

export interface IntegrationConnection extends Person {
  id: string;
  position?: Position;
  headline?: string;
  /** Relationship strength of this connector to the target, 0-100. (`rank` = legacy alias.) */
  score?: number;
  rank?: number;
  /** Reasons for the score — shared history. (`rankDetails` = legacy alias.) */
  scoreDetails?: string[];
  rankDetails?: string[];
  /**
   * Connector↔target relationship taxonomy — zero or more `RelationshipKind` values.
   *
   * ABSENT WHEN EMPTY: an empty repeated field is omitted on the wire, so the key is simply not
   * there — it is never `[]`. Always read it as `c.relationships ?? []`. Present when we hold that
   * signal for the pair, omitted when we do not — so absence means "no structured signal for this
   * pair", NOT "these two have no relationship". Promote on the signal, never demote on its
   * absence. `scoreDetails` carries the human-readable summary.
   */
  relationships?: string[];
  /**
   * The structured facts behind `scoreDetails` — one record per shared company / school /
   * mutual-contact signal. Same absence semantics as `relationships` (absent when empty).
   * INDEPENDENT of `relationships`, not a parallel view of it: a
   * mutual-contacts-only signal produces a record here and no `relationships` entry. Never derive
   * or index-align one from the other, or from `scoreDetails`.
   */
  relationshipDetails?: RelationshipDetail[];
  owners?: Member[];
  connectorId?: string;
}

/**
 * A supporter / connector as returned by `GET /supporters` (and as the `connector` on
 * `GET /connectors/{id}/intros`).
 */
export interface IntegrationSupporter extends Person {
  id: string;
  position?: Position;
  headline?: string;
  /** Relationship strength (0-100) between your team and this supporter. */
  score?: number;
  /**
   * Your personal rating on the product's star scale: 1..5 where HIGHER IS BETTER
   * (5 = ★★★★★ "ask anytime", 1 = ★ "do not ask"). Absent when unreviewed. There is no
   * `rating: 0` — clearing a rating stays `{"tier": 0}`. Note `rating: 1` also HIDES the
   * connector, so default listings normally omit it (ask for it with the rating filter).
   */
  rating?: number;
  /**
   * The same setting spelled as the raw wire number: 1..5 where LOWER IS BETTER
   * (tier 1 = "ask anytime" … tier 5 = "do not ask"). Absent when unreviewed. Never written in
   * stars — the star glyphs belong to `rating`.
   */
  tier?: number;
  createdAt?: string;
}

export interface IntegrationTag {
  id: string;
  title: string;
  type?: string; // "manual" (user-created) | "automatic" (system batch/date marker). No "icp" today.
}

export interface MeResponse {
  status?: number;
  errors?: string[];
  customer?: {
    id?: string;
    /** Customer/company name. */
    name?: string;
    /** The API-key owner (current API). `profile` is a legacy/tolerant alias. */
    user?: Person;
    profile?: Profile;
    /** The caller's own customer_profile_id — usable as an `ownerIds` value. */
    customerProfileId?: string;
    /** Team roster — each member's `id` is a customer_profile_id you can pass as `ownerIds`. */
    teamMembers?: Member[];
  };
}

export interface PaginatedResponse {
  status?: number;
  errors?: string[];
  count?: number;
  nextPage?: number;
}

export interface TargetsResponse extends PaginatedResponse {
  targets: IntegrationTarget[];
}

export interface ConnectionsResponse extends PaginatedResponse {
  connections: IntegrationConnection[];
}

export interface TagsResponse extends PaginatedResponse {
  tags: IntegrationTag[];
}

export interface SupportersResponse extends PaginatedResponse {
  supporters: IntegrationSupporter[];
}

export type TargetStatus = "new" | "completed" | "stopped";
export type TagType = "manual" | "automatic";
