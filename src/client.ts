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

/** A query value can be a scalar or an array (serialized as repeated keys). */
type QueryValue = string | number | boolean | string[] | undefined | null;
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

  /** Build a query string with repeated keys for array values. */
  buildQuery(query?: Query): string {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null && item !== "") {
            params.append(key, String(item));
          }
        }
      } else if (value !== "") {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  private async request<T>(
    method: "GET" | "POST",
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
