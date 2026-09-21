-- Stage 7: optimistic concurrency, richer audit facts, transactional idempotency.
--
-- Additive only. No existing column is dropped or retyped, and every new column
-- carries a default so existing rows remain valid.

-- ---------------------------------------------------------------------------
-- 1. Optimistic concurrency on pricing rules
-- ---------------------------------------------------------------------------
-- Without a version, two shopkeepers editing the same rule produce a lost
-- update: the second write silently discards the first, and both see success.
-- A monotonic counter lets an update say "I read version N" and be rejected if
-- the row has moved on.

ALTER TABLE "tenant_pricing_rules"
  ADD COLUMN "version"    INTEGER NOT NULL DEFAULT 1,
  -- Who last changed it. Populated from the authenticated context, never from
  -- a request body.
  ADD COLUMN "updated_by" UUID;

ALTER TABLE "tenant_pricing_rules"
  ADD CONSTRAINT "fk_tenant_pricing_rules_updated_by"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "tenant_pricing_rules"
  ADD CONSTRAINT "chk_tenant_pricing_rules_version_positive"
  CHECK ("version" > 0);

-- ---------------------------------------------------------------------------
-- 2. Audit: actor classification
-- ---------------------------------------------------------------------------
-- `actor_user_id` alone does not say *how* someone was acting. A platform
-- operator and a shop owner are different kinds of actor with different
-- authority, and an audit trail that cannot distinguish them cannot answer
-- "who was allowed to do this?" after the fact.

ALTER TABLE "audit_logs"
  -- 'authenticated' | 'platform_admin' | 'system'
  ADD COLUMN "actor_type" TEXT,
  -- The tenant role held AT THE TIME of the action. Roles change; the audit
  -- record must not silently re-interpret history through today's role.
  ADD COLUMN "actor_role" TEXT;

-- Audit rows are written only for committed mutations, so an entity reference
-- is always present in practice; indexed for "what happened to this rule?".
CREATE INDEX "idx_audit_logs_entity"
  ON "audit_logs" ("tenant_id", "entity_type", "entity_id", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- 3. Idempotency — deliberately in PostgreSQL, not Redis
-- ---------------------------------------------------------------------------
-- `api-standards.md` §6 specifies Redis-backed idempotency keys. That is right
-- for ordinary POSTs, but it cannot hold here: a Redis key cannot participate
-- in a PostgreSQL transaction, so a crash between "mutation committed" and
-- "idempotency key stored" would let a retry execute the mutation twice and
-- write a second audit record.
--
-- Stage 7 requires that a mutation, its audit row, and the record that the
-- request was already handled all commit or all roll back together. Only a
-- table in the same database can do that. Redis remains the store for rate
-- limiting, where approximate state is acceptable.
--
-- Trade-off accepted: rows must be expired by a scheduled job rather than by a
-- TTL. `idx_idempotency_keys_created_at` supports that sweep.

CREATE TABLE "idempotency_keys" (
  "tenant_id"           UUID        NOT NULL,
  "idempotency_key"     TEXT        NOT NULL,
  -- Hash of method + path + canonical body. A replay carrying the same key but
  -- a DIFFERENT payload is a client bug, not a retry, and must not silently
  -- return the first response.
  "request_fingerprint" TEXT        NOT NULL,
  "response_status"     INTEGER     NOT NULL,
  "response_body"       JSONB       NOT NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "pk_idempotency_keys" PRIMARY KEY ("tenant_id", "idempotency_key"),
  CONSTRAINT "chk_idempotency_keys_key_length"
    CHECK (char_length("idempotency_key") BETWEEN 8 AND 200)
);

CREATE INDEX "idx_idempotency_keys_created_at"
  ON "idempotency_keys" ("created_at");

-- Same tenant isolation as every other tenant-owned table. Without this, one
-- tenant could probe another's idempotency keys and read stored responses.
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "idempotency_keys"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_app') THEN
    GRANT SELECT, INSERT, DELETE ON "idempotency_keys" TO bullion_app;
    -- No UPDATE: a stored response is immutable. Replacing one would let a
    -- later request rewrite what an earlier caller was told.
    GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_pricing_rules" TO bullion_app;
  END IF;
END;
$$;
