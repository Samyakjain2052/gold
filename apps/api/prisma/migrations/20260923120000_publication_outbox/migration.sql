-- The durable bridge between a committed rate and its Redis notification.
--
-- ## Why a table and not a direct publish
--
-- PostgreSQL's transaction atomicity does not extend to Redis. Publishing
-- inside the transaction risks an event for a write that then rolls back;
-- publishing after commit risks a committed rate that never reaches a
-- customer's open page, and an in-memory retry queue loses exactly that on the
-- restart it is supposed to protect against.
--
-- So the event is written **in the same transaction as the rate**. It commits
-- or it does not, together with `published_rates`. A separate publisher drains
-- committed rows to Redis and marks them delivered.
--
-- ## Delivery semantics: at-least-once
--
-- A publisher that dies between `PUBLISH` and `delivered_at` will re-publish on
-- the next pass. That is safe because a rate event is *state*, not a delta —
-- "this product is now X" — and the browser applies it per `product_key`,
-- last write wins. `published_rates` remains the source of truth; the event is
-- only a prompt to look, and a duplicate prompt changes nothing.
--
-- Ordering is by `id` (a single sequence), so a later rate for the same product
-- always carries a higher id than the one it supersedes.
--
-- ## Why not reuse `rate_update_events`
--
-- That table is the tenant-visible *change log*: what the rate was, what it
-- became, which direction, and why. It is read by people. Overloading it with
-- delivery bookkeeping would mix an audit record with a queue, and it lacks the
-- fields the wire event needs (display unit, source timestamp, freshness).
-- Both are written; they answer different questions.

CREATE TABLE "rate_publication_outbox" (
  "id"                 BIGSERIAL PRIMARY KEY,
  "tenant_id"          UUID         NOT NULL,
  "product_id"         UUID         NOT NULL,

  -- Denormalised so the publisher needs no join, and no tenant context, to
  -- build the wire payload. `product_key` is the public identifier the browser
  -- already keys rates by.
  "product_key"        TEXT         NOT NULL,
  "rate_display_paise" BIGINT       NOT NULL,
  "display_unit"       display_unit NOT NULL,

  -- The provider's own stamp, never our receipt time. Shown to customers.
  "source_timestamp"   TIMESTAMPTZ(3) NOT NULL,
  "freshness"          TEXT         NOT NULL,
  "trigger"            rate_trigger NOT NULL,

  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- NULL until a publisher has put it on Redis.
  "delivered_at"       TIMESTAMPTZ(3),
  "attempts"           INT          NOT NULL DEFAULT 0,
  "last_error"         TEXT,

  CONSTRAINT "fk_rate_publication_outbox_tenant"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "fk_rate_publication_outbox_product"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE,

  -- A rate of zero or less is never publishable; the pricing engine already
  -- refuses to produce one, and this stops a bug from getting past it.
  CONSTRAINT "chk_rate_publication_outbox_positive"
    CHECK ("rate_display_paise" > 0),
  CONSTRAINT "chk_rate_publication_outbox_freshness"
    CHECK ("freshness" IN ('fresh', 'stale'))
);

-- The publisher's only query: undelivered rows, oldest first. Partial, so the
-- index stays the size of the backlog rather than the size of all history.
CREATE INDEX "idx_rate_publication_outbox_pending"
  ON "rate_publication_outbox" ("id")
  WHERE "delivered_at" IS NULL;

CREATE INDEX "idx_rate_publication_outbox_tenant_created"
  ON "rate_publication_outbox" ("tenant_id", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Same policy as every other tenant-owned table. Writes happen inside the
-- recompute transaction, which already runs under the tenant's context, so the
-- outbox is protected exactly as `published_rates` is.

ALTER TABLE "rate_publication_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_publication_outbox" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "rate_publication_outbox"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "rate_publication_outbox" TO bullion_app;
    GRANT USAGE, SELECT ON SEQUENCE "rate_publication_outbox_id_seq" TO bullion_app;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cross-tenant resolvers
-- ---------------------------------------------------------------------------
-- Three operations are inherently cross-tenant: deciding whose rates a market
-- quote affects, reading the pending outbox, and marking rows delivered. One
-- gold tick moves every gold-selling tenant, so there is no single tenant
-- context under which "all affected tenants" is a legal answer.
--
-- Rather than give the application BYPASSRLS, these follow the pattern already
-- established by `resolve_public_link` and `resolve_tenant_membership`:
-- SECURITY DEFINER functions with a pinned `search_path` and a deliberately
-- narrow return shape. The application role gains three specific answers, not
-- the ability to read tenant data at will.
--
-- The recompute itself then runs per tenant, inside that tenant's context, with
-- RLS fully enforced. Nothing in this pipeline writes a tenant row outside its
-- own context.

-- Tenants that sell this metal and have an active rule for it: the set a quote
-- for that metal can move. Returns ids only.
CREATE OR REPLACE FUNCTION tenants_affected_by_metal(p_metal_code TEXT)
RETURNS TABLE (tenant_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT r.tenant_id
    FROM tenant_pricing_rules r
    JOIN products p        ON p.id = r.product_id
    JOIN tenant_products tp ON tp.tenant_id = r.tenant_id AND tp.product_id = r.product_id
    JOIN tenants t          ON t.id = r.tenant_id
   WHERE r.is_active
     AND p.is_active
     AND tp.is_enabled
     AND t.status = 'active'
     AND p.metal_code = p_metal_code;
$$;

-- The publisher's read. Ordered by id so a superseding rate never overtakes the
-- rate it replaces.
CREATE OR REPLACE FUNCTION pending_rate_publications(p_limit INT)
RETURNS TABLE (
  id                 BIGINT,
  tenant_id          UUID,
  product_key        TEXT,
  rate_display_paise BIGINT,
  display_unit       TEXT,
  source_timestamp   TIMESTAMPTZ,
  freshness          TEXT,
  attempts           INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.tenant_id, o.product_key, o.rate_display_paise,
         o.display_unit::TEXT, o.source_timestamp, o.freshness, o.attempts
    FROM rate_publication_outbox o
   WHERE o.delivered_at IS NULL
   ORDER BY o.id
   LIMIT GREATEST(1, LEAST(p_limit, 5000));
$$;

CREATE OR REPLACE FUNCTION mark_rate_publications_delivered(p_ids BIGINT[])
RETURNS INT
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH updated AS (
    UPDATE rate_publication_outbox
       SET delivered_at = now()
     WHERE id = ANY(p_ids)
       AND delivered_at IS NULL
    RETURNING 1
  )
  SELECT COALESCE(COUNT(*), 0)::INT FROM updated;
$$;

-- Records a failed delivery so a poison row is visible rather than retried
-- silently forever.
CREATE OR REPLACE FUNCTION record_rate_publication_failure(p_ids BIGINT[], p_error TEXT)
RETURNS INT
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH updated AS (
    UPDATE rate_publication_outbox
       SET attempts = attempts + 1,
           last_error = left(p_error, 500)
     WHERE id = ANY(p_ids)
       AND delivered_at IS NULL
    RETURNING 1
  )
  SELECT COALESCE(COUNT(*), 0)::INT FROM updated;
$$;

-- EXECUTE is revoked from PUBLIC first: a SECURITY DEFINER function granted to
-- PUBLIC is a privilege escalation waiting to be found.
REVOKE EXECUTE ON FUNCTION tenants_affected_by_metal(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pending_rate_publications(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_rate_publications_delivered(BIGINT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_rate_publication_failure(BIGINT[], TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_app') THEN
    GRANT EXECUTE ON FUNCTION tenants_affected_by_metal(TEXT) TO bullion_app;
    GRANT EXECUTE ON FUNCTION pending_rate_publications(INT) TO bullion_app;
    GRANT EXECUTE ON FUNCTION mark_rate_publications_delivered(BIGINT[]) TO bullion_app;
    GRANT EXECUTE ON FUNCTION record_rate_publication_failure(BIGINT[], TEXT) TO bullion_app;
  END IF;
END;
$$;
