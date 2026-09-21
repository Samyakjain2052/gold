/**
 * Identifying which database constraint a Prisma error came from.
 *
 * Prisma reports every unique violation as `P2002`, so mapping that code
 * wholesale to a single HTTP status is wrong: "an active rule already exists"
 * and "that email is taken" are different conflicts with different messages,
 * and a third, unanticipated constraint would be silently reported as one of
 * them. Callers must name the constraint they are prepared to handle and let
 * everything else surface as an unexpected failure.
 *
 * The shape below was read from the running driver rather than assumed — the
 * `@prisma/adapter-pg` driver adapter nests the constraint under
 * `meta.driverAdapterError.cause.constraint.index`, which is not where the
 * classic engine puts it. Both are handled.
 */

/** Prisma's code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = "P2002";

/** Constraint names this application maps to specific responses. */
export const CONSTRAINTS = {
  /** One active pricing rule per tenant per product. */
  active_pricing_rule: "uq_tenant_pricing_rules_active",
  /** One stored response per (tenant, idempotency key). */
  idempotency_key: "pk_idempotency_keys",
} as const;

export function is_unique_violation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * The name of the violated unique constraint, or `null`.
 *
 * Returns `null` rather than throwing for any error it does not recognise, so
 * a caller's `=== CONSTRAINTS.x` check simply fails and the original error
 * propagates untouched.
 */
export function unique_constraint_name(error: unknown): string | null {
  if (!is_unique_violation(error)) return null;

  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return null;

  // Driver-adapter shape (@prisma/adapter-pg), verified against the running
  // database: meta.driverAdapterError.cause.constraint.index
  const adapter = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapter === "object" && adapter !== null) {
    const cause = (adapter as { cause?: unknown }).cause;
    if (typeof cause === "object" && cause !== null) {
      const constraint = (cause as { constraint?: unknown }).constraint;
      if (typeof constraint === "object" && constraint !== null) {
        const index = (constraint as { index?: unknown }).index;
        if (typeof index === "string") return index;
      }
      // Some adapter versions report the constraint as a bare string.
      if (typeof constraint === "string") return constraint;
    }
  }

  // Classic engine shape: meta.target, either a string or a field list.
  const target = (meta as { target?: unknown }).target;
  if (typeof target === "string") return target;
  if (Array.isArray(target) && target.every((t) => typeof t === "string")) {
    return target.join(",");
  }

  return null;
}

/** Whether `error` is a unique violation of exactly `constraint`. */
export function violates_constraint(error: unknown, constraint: string): boolean {
  return unique_constraint_name(error) === constraint;
}
