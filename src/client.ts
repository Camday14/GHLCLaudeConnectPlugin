/**
 * Minimal GoHighLevel (LeadConnector) API v2 client.
 * - Bearer auth with a Private Integration Token
 * - Serialized rate limiting (default ~8 req/s, well under GHL's 100 req / 10 s burst limit)
 * - Retries with exponential backoff on 429 / 5xx / network errors (honours Retry-After)
 */

export const DEFAULT_BASE_URL = "https://services.leadconnectorhq.com";
export const API_VERSION = "2021-07-28";

export type Query = Record<string, string | number | boolean | undefined | null | Array<string | number>>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Return the raw Response instead of parsed JSON (for binary downloads). */
  raw?: boolean;
  /** Override the API version header for endpoints that need a different one. */
  version?: string;
}

export interface GhlClientOptions {
  apiKey: string;
  locationId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Minimum gap between request starts, in ms. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class GhlError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public body: unknown,
  ) {
    super(`GHL API ${method} ${path} failed with ${status}: ${summarizeBody(body)}`);
    this.name = "GhlError";
  }
}

function summarizeBody(body: unknown): string {
  if (body == null) return "(no body)";
  if (typeof body === "string") return body.slice(0, 500);
  const b = body as Record<string, unknown>;
  const msg = b.message ?? b.error ?? b.msg;
  if (msg) return Array.isArray(msg) ? msg.join("; ") : String(msg);
  return JSON.stringify(body).slice(0, 500);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GhlClient {
  readonly locationId: string;
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private minIntervalMs: number;
  private maxRetries: number;
  private sleep: (ms: number) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(opts: GhlClientOptions) {
    if (!opts.apiKey) throw new Error("GHL_API_KEY is not set. Create a Private Integration Token in GHL (Settings → Private Integrations).");
    if (!opts.locationId) throw new Error("GHL_LOCATION_ID is not set. Find it in GHL under Settings → Business Profile (Location ID).");
    this.apiKey = opts.apiKey;
    this.locationId = opts.locationId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? 125;
    this.maxRetries = opts.maxRetries ?? 4;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Wait for our turn under the rate limiter. */
  private async throttle(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = Date.now();
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  buildUrl(path: string, query?: Query): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
        else url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Version: opts.version ?? API_VERSION,
      Accept: opts.raw ? "*/*" : "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let attempt = 0;
    for (;;) {
      await this.throttle();
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body });
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        await this.sleep(this.backoff(attempt++));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt);
          attempt++;
          await this.sleep(delay);
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* keep text */
        }
        throw new GhlError(res.status, method, path, parsed);
      }

      if (opts.raw) return res as unknown as T;
      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
  }

  private backoff(attempt: number): number {
    return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }

  get<T = any>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }
  post<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("POST", path, { body, query });
  }
  put<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("PUT", path, { body, query });
  }
  delete<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("DELETE", path, { body, query });
  }
}
