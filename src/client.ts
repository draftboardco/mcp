import type {
  ConnectionsResponse,
  MeResponse,
  TagsResponse,
  TargetsResponse,
} from "./types.js";

export interface DraftboardClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_BASE_URL = "https://intros.draftboard.com/api/v1/integration";

/**
 * A query value can be a scalar, an array (serialized as repeated keys), or a nested object
 * (serialized as bracket notation, e.g. `paging[pageNumber]=1`).
 */
type QueryValue = string | number | boolean | string[] | NestedQuery | undefined | null;
interface NestedQuery {
  [key: string]: QueryValue;
}
export type Query = Record<string, QueryValue>;

/** Error that never leaks the API key. */
export class DraftboardApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "DraftboardApiError";
  }
}

export class DraftboardClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DraftboardClientOptions) {
    if (!opts.apiKey) {
      throw new Error("DRAFTBOARD_API_KEY is required");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("global fetch is unavailable; Node 20+ is required");
    }
  }

  /**
   * Build a query string. Arrays → repeated keys (`tagNames=a&tagNames=b`); nested objects →
   * bracket notation (`paging[pageNumber]=1`); empty strings / null / undefined are dropped.
   */
  buildQuery(query?: Query): string {
    if (!query) return "";
    const params = new URLSearchParams();
    const append = (key: string, value: unknown): void => {
      if (value === undefined || value === null || value === "") return;
      if (Array.isArray(value)) {
        for (const item of value) append(key, item);
      } else if (typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          append(`${key}[${k}]`, v);
        }
      } else {
        params.append(key, String(value));
      }
    };
    for (const [key, value] of Object.entries(query)) append(key, value);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${this.buildQuery(opts.query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      // Read the body under the same timeout — a hung body still aborts.
      text = await res.text();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new DraftboardApiError(
          `Request to ${method} ${path} timed out after ${this.timeoutMs}ms`,
        );
      }
      // Never include the URL's auth header; the message here is network-level only.
      const message = err instanceof Error ? err.message : String(err);
      throw new DraftboardApiError(`Network error calling ${method} ${path}: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new DraftboardApiError(friendlyStatus(res.status, path), res.status, truncate(text));
    }

    // A successful write may return 204 / an empty body — that's success, not invalid JSON.
    if (text.trim() === "") {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DraftboardApiError(
        `Invalid JSON from ${method} ${path}`,
        res.status,
        truncate(text),
      );
    }
  }

  // ---- thin endpoint methods (1:1 with the API) ----

  getMe(): Promise<MeResponse> {
    return this.request<MeResponse>("GET", "/me");
  }

  listTags(query?: Query): Promise<TagsResponse> {
    return this.request<TagsResponse>("GET", "/tags", { query });
  }

  listTargets(query?: Query): Promise<TargetsResponse> {
    return this.request<TargetsResponse>("GET", "/targets", { query });
  }

  importTargets(body: { linkedinUrls: string[]; tags?: string[] }): Promise<unknown> {
    return this.request<unknown>("POST", "/targets/import", { body });
  }

  getTargetConnections(targetId: string, query?: Query): Promise<ConnectionsResponse> {
    const encoded = encodeURIComponent(targetId);
    return this.request<ConnectionsResponse>("GET", `/targets/${encoded}/connections`, { query });
  }

  // ---- accounts ----

  getAccounts(query?: Query): Promise<unknown> {
    return this.request<unknown>("GET", "/accounts", { query });
  }

  // ---- prospecting: account search + pool (BETA) ----

  /**
   * BETA. Start a search for people with the given titles at the given companies. Returns a
   * campaignId; discovered people surface asynchronously in the pool.
   */
  searchAccounts(body: { companies: string[]; titles: string[]; name?: string }): Promise<unknown> {
    return this.request<unknown>("POST", "/search/accounts", { body });
  }

  /** List pool prospects (potential prospects awaiting confirm/reject). */
  listPool(query?: Query): Promise<unknown> {
    return this.request<unknown>("GET", "/pool", { query });
  }

  /** Confirm pool prospects into saved targets (capacity-checked, idempotent). */
  confirmPool(body: { ids: string[] }): Promise<unknown> {
    return this.request<unknown>("POST", "/pool/confirm", { body });
  }

  /** Reject (soft-delete) pending pool prospects. Idempotent. */
  rejectPool(body: { ids: string[] }): Promise<unknown> {
    return this.request<unknown>("POST", "/pool/reject", { body });
  }

  // ---- target management (writes) ----

  /** Archive (soft-delete) a target. Not reversible via the public API. */
  archiveTarget(targetId: string): Promise<unknown> {
    return this.request<unknown>("DELETE", `/targets/${encodeURIComponent(targetId)}`);
  }

  /** Attach tags (by id and/or name) to one or many targets. */
  attachTagsToTargets(body: {
    targetIds: string[];
    tagIds?: string[];
    tagNames?: string[];
  }): Promise<unknown> {
    return this.request<unknown>("POST", "/targets/tags", { body });
  }

  // ---- supporters ----

  getSupporters(params?: {
    query?: string;
    preferred?: boolean;
    pageNumber?: number;
    resultPerPage?: number;
  }): Promise<unknown> {
    const query: Query = {
      filters: { query: params?.query, preferred: params?.preferred },
      paging: { pageNumber: params?.pageNumber, resultPerPage: params?.resultPerPage },
    };
    return this.request<unknown>("GET", "/supporters", { query });
  }

  importSupporters(body: { linkedinUrls: string[] }): Promise<unknown> {
    return this.request<unknown>("POST", "/supporters/import", { body });
  }

  // ---- connectors (preferred / excluded toggles, connector-first intros) ----

  setConnectorPreferred(connectorId: string, enabled: boolean): Promise<unknown> {
    const path = `/connectors/${encodeURIComponent(connectorId)}/prefer`;
    return this.request<unknown>(enabled ? "POST" : "DELETE", path);
  }

  setConnectorExcluded(connectorId: string, enabled: boolean): Promise<unknown> {
    const path = `/connectors/${encodeURIComponent(connectorId)}/exclude`;
    return this.request<unknown>(enabled ? "POST" : "DELETE", path);
  }

  getConnectorIntros(
    connectorId: string,
    params?: { pageNumber?: number; resultPerPage?: number },
  ): Promise<unknown> {
    const query: Query = {
      paging: { pageNumber: params?.pageNumber, resultPerPage: params?.resultPerPage },
    };
    return this.request<unknown>(
      "GET",
      `/connectors/${encodeURIComponent(connectorId)}/intros`,
      { query },
    );
  }

  // ---- intro lifecycle (writes) ----

  setIntroStatus(
    introId: string,
    status: "requested" | "completed" | "declined",
    body?: { reasonId?: string; customReason?: string },
  ): Promise<unknown> {
    const path = `/intros/${encodeURIComponent(introId)}/${status}`;
    return this.request<unknown>("POST", path, {
      body: status === "declined" ? (body ?? {}) : undefined,
    });
  }
}

function friendlyStatus(status: number, path: string): string {
  switch (status) {
    case 401:
      return "Unauthorized (401): the DRAFTBOARD_API_KEY is missing, invalid, or expired.";
    case 403:
      return "Forbidden (403): this API key lacks access to that resource.";
    case 404:
      return `Not found (404): ${path}.`;
    case 429:
      return "Rate limited (429): too many requests — slow down and retry shortly.";
    default:
      if (status >= 500) return `Draftboard server error (${status}) on ${path}.`;
      return `Request to ${path} failed with HTTP ${status}.`;
  }
}

function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
