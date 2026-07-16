/**
 * Response shapes for the Draftboard Integration API, matching the authoritative current
 * DTOs in `api-gateway/src/intro/integration.dto.ts`: name fields are FLAT (firstName,
 * lastName, linkedinUrl), targets carry `score` + `connectionsNumber`, connections carry
 * `score` + `scoreDetails` + `owners`. Older/idealized docs nested these under `profile` and
 * used `maxRank`/`rank`/`rankDetails`; the optional aliases below keep the tools tolerant of
 * either form. All fields are optional so a shape drift never crashes a tool.
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
  owners?: Member[];
  connectorId?: string;
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

export type TargetStatus = "new" | "completed" | "stopped";
export type TagType = "manual" | "automatic";
