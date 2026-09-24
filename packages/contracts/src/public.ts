/**
 * The public customer wire contract.
 *
 * `ARCHITECTURE.md` §4: "`packages/contracts` is the single source of truth for
 * request/response shapes. The frontend imports the same [types]." These are
 * declared here and imported by both sides, so a field renamed on the server is
 * a compile error in the browser rather than an `undefined` on a customer's
 * phone.
 *
 * ## Money on the wire
 *
 * Every amount is a **string of integer paise**, never a number. `14081393` is
 * ₹140,813.93. JSON numbers are IEEE-754 doubles, and routing exact integer
 * money through one is how a rounding error gets introduced at the last
 * possible moment, after all the care taken to avoid it in the engine.
 *
 * The browser formats these for display and does no arithmetic on them. It in
 * particular never computes `rate - market_rate` to recover the shop's
 * adjustment: `shop_adjustment` is the authored value, and deriving it would
 * reintroduce the exact bug ADR-0005 exists to prevent.
 */

/** How old a quote is, relative to the configured freshness policy. */
export type Freshness = "fresh" | "stale" | "expired";

export interface PublicContact {
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
}

export interface PublicShop {
  /** The slug, not the tenant UUID. The only identifier a visitor receives. */
  readonly slug: string;
  readonly display_name: string;
  readonly tagline: string | null;
  readonly logo_url: string | null;
  readonly accent_color: string | null;
  readonly contact: PublicContact;
}

export interface PublicRate {
  /** Stable, non-identifying product key such as `GOLD_916`. */
  readonly product_key: string;
  readonly label: string;
  readonly metal: string;
  readonly display_unit: string;
  /** Authoritative customer rate, in paise of `display_unit`. */
  readonly rate: string;
  /**
   * The breakdown, present only when the shop chose to publish it. `null` means
   * withheld — not zero, and not "compute it yourself".
   */
  readonly market_rate: string | null;
  readonly shop_adjustment: string | null;
  readonly rounding: string | null;
  /** The provider's own stamp, never our receipt time. */
  readonly source_timestamp: string;
  readonly freshness: Freshness;
}

/** A rate change pushed over SSE, with the tenant id stripped by the route. */
export interface PublicRateEvent {
  readonly type: "rate_update";
  readonly product_key: string;
  readonly rate_display_paise: string;
  readonly display_unit: string;
  readonly source_timestamp: string;
  readonly freshness: Freshness;
  readonly emitted_at: string;
}

/** First frame on the SSE stream, so the client knows the socket is live. */
export interface StreamReadyEvent {
  readonly slug: string;
  /** True when rates are simulated. Impossible in production. */
  readonly simulated: boolean;
}

export interface RatesMeta {
  readonly count: number;
  readonly simulated: boolean;
  readonly served_at: string;
}

/** The session summary backing the dashboard. Carries no tenant UUID. */
export interface SessionSummary {
  readonly user: { readonly role: "owner" | "manager" | "staff" };
  readonly tenant: {
    readonly display_name: string;
    readonly tagline: string | null;
    readonly accent_color: string | null;
    readonly status: string;
    /** null until a customer link has been issued. */
    readonly public_slug: string | null;
  };
}

/** The `{data, meta}` success envelope used by every endpoint. */
export interface Envelope<T, M = undefined> {
  readonly data: T;
  readonly meta: M;
}

/** RFC 9457 problem document — the shape of every error response. */
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly request_id: string;
  readonly errors?: readonly { readonly field?: string; readonly message: string }[];
}

// ---------------------------------------------------------------------------
// Shopkeeper pricing configuration
// ---------------------------------------------------------------------------

export type RoundingMode = "half_up" | "half_even" | "up" | "down";
export type AdjustmentKind = "absolute" | "percentage";

/**
 * A configured pricing rule, as the API returns it.
 *
 * `adjustment_rupees_per_gram` and `adjustment_bps` are mutually exclusive: the
 * kind decides which is populated and the other is null. Neither is ever
 * derived from a published rate.
 *
 * `version` drives optimistic concurrency. The UI must quote it back in
 * `If-Match` on every write, or the API answers `428`.
 */
export interface PricingRule {
  readonly id: string;
  readonly product_id: string;
  readonly product_label: string;
  readonly metal: string;
  readonly purity: { readonly num: number; readonly den: number };
  readonly adjustment_kind: AdjustmentKind;
  /** Decimal rupees as a string, e.g. "50.00". Absolute rules only. */
  readonly adjustment_rupees_per_gram: string | null;
  /** Basis points. Percentage rules only. */
  readonly adjustment_bps: number | null;
  readonly rounding_step_paise: number;
  readonly rounding_mode: RoundingMode;
  readonly component_precision_paise: number;
  readonly is_active: boolean;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The whole pricing block is replaced on update; partial patches are refused. */
export type UpdatePricingRule =
  | {
      readonly adjustment_kind: "absolute";
      readonly adjustment_rupees_per_gram: string;
      readonly rounding_step_paise: number;
      readonly rounding_mode: RoundingMode;
      readonly component_precision_paise: number;
    }
  | {
      readonly adjustment_kind: "percentage";
      readonly adjustment_bps: number;
      readonly rounding_step_paise: number;
      readonly rounding_mode: RoundingMode;
      readonly component_precision_paise: number;
    };

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly created_at: string;
  readonly actor_role: string | null;
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/**
 * Creating a shop for a signed-in shopkeeper.
 *
 * Carries no tenant, user or role: identity comes from the verified token and
 * ownership is decided by the server. The API rejects any of them outright.
 */
export interface OnboardingRequest {
  readonly shop_name: string;
  /** Optional. Derived from the name when absent. */
  readonly slug?: string;
}

export interface OnboardingResult {
  readonly slug: string;
  readonly display_name: string;
  /** Products enabled with a zero adjustment, ready for the shop to price. */
  readonly products: number;
}
