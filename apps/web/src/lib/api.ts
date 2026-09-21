/**
 * The only place this app talks to the API.
 *
 * Centralised so three rules hold everywhere rather than per call site: errors
 * arrive as typed `ApiError`s carrying the server's problem document, no
 * request is allowed to hang forever, and the access token is attached in
 * exactly one function.
 *
 * There is no second backend here. Next.js route handlers are deliberately not
 * used as a proxy — `ARCHITECTURE.md` §3 is explicit that Express owns all
 * state, and a proxy layer would be a second place for tenant logic to drift.
 */
import type {
  AuditEntry,
  Envelope,
  PricingRule,
  ProblemDocument,
  PublicRate,
  PublicShop,
  RatesMeta,
  SessionSummary,
  UpdatePricingRule,
} from "@bullion/contracts";

/**
 * An error carrying the server's decision.
 *
 * `status` is kept so the UI can distinguish the cases a shopkeeper needs told
 * apart — a stale version (409) reads very differently from a validation
 * failure (422) — without parsing message strings.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDocument | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field-level messages from a 422, for rendering beside the inputs. */
  get field_errors(): ReadonlyMap<string, string> {
    const map = new Map<string, string>();
    for (const detail of this.problem?.errors ?? []) {
      if (detail.field !== undefined) map.set(detail.field, detail.message);
    }
    return map;
  }

  /** True when the write lost a concurrency race and must be re-read. */
  get is_conflict(): boolean {
    return this.status === 409;
  }

  get is_unauthenticated(): boolean {
    return this.status === 401;
  }
}

export function api_base_url(): string {
  const base = process.env["NEXT_PUBLIC_API_BASE_URL"];
  if (base === undefined || base === "") {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is not configured");
  }
  return base.replace(/\/+$/, "");
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly token?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Next.js fetch cache hint, for server components. */
  readonly cache?: RequestCache;
  readonly timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Perform one API call and unwrap the `{data, meta}` envelope.
 *
 * A non-2xx response always throws. Returning a partially-filled object on
 * failure is how a page ends up rendering "₹0.00" for a rate it never received.
 */
export async function api_request<T, M = undefined>(
  path: string,
  options: RequestOptions = {},
): Promise<Envelope<T, M>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  );

  // An external signal (React unmount) and the timeout must both be able to
  // cancel the request.
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetch(`${api_base_url()}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.token == null ? {} : { Authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      signal: controller.signal,
    });

    if (!response.ok) throw await to_api_error(response);

    return (await response.json()) as Envelope<T, M>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(0, null, "The request timed out");
    }
    // A network failure carries no status; 0 distinguishes "never reached the
    // server" from any decision the server made.
    throw new ApiError(0, null, "Could not reach the server");
  } finally {
    clearTimeout(timeout);
  }
}

async function to_api_error(response: Response): Promise<ApiError> {
  let problem: ProblemDocument | null = null;
  try {
    problem = (await response.json()) as ProblemDocument;
  } catch {
    // An error body that is not JSON tells us nothing; the status still does.
  }

  return new ApiError(
    response.status,
    problem,
    problem?.detail ?? problem?.title ?? `Request failed (${response.status})`,
  );
}

// ---------------------------------------------------------------------------
// Public endpoints — no token, ever
// ---------------------------------------------------------------------------

export async function fetch_public_shop(
  slug: string,
  init: Pick<RequestOptions, "signal" | "cache"> = {},
): Promise<PublicShop> {
  const { data } = await api_request<PublicShop>(
    `/api/v1/public/shops/${encodeURIComponent(slug)}`,
    init,
  );
  return data;
}

export async function fetch_public_rates(
  slug: string,
  init: Pick<RequestOptions, "signal" | "cache"> = {},
): Promise<{ rates: PublicRate[]; meta: RatesMeta }> {
  const { data, meta } = await api_request<PublicRate[], RatesMeta>(
    `/api/v1/public/shops/${encodeURIComponent(slug)}/rates`,
    // Never cached: the rate is the page, and a cached one would contradict the
    // freshness the payload itself reports.
    { ...init, cache: "no-store" },
  );
  return { rates: data, meta };
}

/** The SSE endpoint for a shop. `EventSource` opens this; fetch does not. */
export function public_stream_url(slug: string): string {
  return `${api_base_url()}/api/v1/public/shops/${encodeURIComponent(slug)}/stream`;
}

// ---------------------------------------------------------------------------
// Authenticated endpoints
// ---------------------------------------------------------------------------

export async function fetch_session(token: string): Promise<SessionSummary> {
  const { data } = await api_request<SessionSummary>("/api/v1/me", { token });
  return data;
}

export async function fetch_pricing_rules(token: string): Promise<PricingRule[]> {
  const { data } = await api_request<PricingRule[]>("/api/v1/pricing-rules", { token });
  return data;
}

/**
 * Replace a rule's pricing block.
 *
 * `If-Match` carries the version the shopkeeper was looking at. Without it the
 * API answers `428`; with a stale one it answers `409`. Both are surfaced to
 * the user rather than retried, because a silent retry would overwrite whatever
 * the other session just saved.
 */
export async function update_pricing_rule(
  token: string,
  rule_id: string,
  version: number,
  body: UpdatePricingRule,
): Promise<PricingRule> {
  const { data } = await api_request<PricingRule>(
    `/api/v1/pricing-rules/${encodeURIComponent(rule_id)}`,
    {
      method: "PATCH",
      token,
      body,
      headers: {
        "If-Match": String(version),
        // A retried save must not apply twice. The key is per attempt, so a
        // genuine second edit gets its own and is not mistaken for a replay.
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );
  return data;
}

export async function fetch_audit_log(
  token: string,
  limit = 10,
): Promise<AuditEntry[]> {
  const { data } = await api_request<AuditEntry[]>(
    `/api/v1/audit-logs?limit=${String(limit)}`,
    { token },
  );
  return data;
}
