-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('pending', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "tenant_role" AS ENUM ('owner', 'manager', 'staff');

-- CreateEnum
CREATE TYPE "market_source" AS ENUM ('ibja', 'spot', 'mcx', 'mock');

-- CreateEnum
CREATE TYPE "adjustment_kind" AS ENUM ('absolute', 'percentage');

-- CreateEnum
CREATE TYPE "rounding_mode" AS ENUM ('half_up', 'half_even', 'ceil', 'floor');

-- CreateEnum
CREATE TYPE "display_unit" AS ENUM ('per_gram', 'per_10_gram', 'per_kilogram');

-- CreateEnum
CREATE TYPE "purity_basis" AS ENUM ('market_convention', 'fine_ratio');

-- CreateEnum
CREATE TYPE "rate_direction" AS ENUM ('up', 'down', 'unchanged');

-- CreateEnum
CREATE TYPE "rate_trigger" AS ENUM ('market_tick', 'rule_change', 'manual_recompute');

-- CreateEnum
CREATE TYPE "provider_status" AS ENUM ('healthy', 'degraded', 'down');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'pending',
    "suspended_at" TIMESTAMPTZ(3),
    "suspended_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "supabase_user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_users" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "tenant_role" NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_users_pkey" PRIMARY KEY ("tenant_id","user_id")
);

-- CreateTable
CREATE TABLE "platform_admins" (
    "user_id" UUID NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "customer_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_branding" (
    "tenant_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "logo_blob_path" TEXT,
    "logo_content_type" TEXT,
    "logo_updated_at" TIMESTAMPTZ(3),
    "accent_color" TEXT,
    "tagline" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_branding_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "tenant_contacts" (
    "tenant_id" UUID NOT NULL,
    "phone_e164" TEXT,
    "whatsapp_e164" TEXT,
    "public_email" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "show_phone" BOOLEAN NOT NULL DEFAULT true,
    "show_whatsapp" BOOLEAN NOT NULL DEFAULT true,
    "show_address" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_contacts_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "metals" (
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "reference_purity_num" INTEGER NOT NULL,
    "reference_purity_den" INTEGER NOT NULL,
    "conventional_display_unit" "display_unit" NOT NULL,

    CONSTRAINT "metals_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "metal_code" TEXT NOT NULL,
    "purity_num" INTEGER NOT NULL,
    "purity_den" INTEGER NOT NULL,
    "purity_basis" "purity_basis" NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_products" (
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "display_unit" "display_unit" NOT NULL,
    "show_base_rate" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_products_pkey" PRIMARY KEY ("tenant_id","product_id")
);

-- CreateTable
CREATE TABLE "market_rates" (
    "id" BIGSERIAL NOT NULL,
    "source" "market_source" NOT NULL,
    "provider_name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "bid_per_gram" BIGINT,
    "ask_per_gram" BIGINT,
    "mid_per_gram" BIGINT NOT NULL,
    "purity_num" INTEGER NOT NULL,
    "purity_den" INTEGER NOT NULL,
    "provider_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_payload" JSONB,

    CONSTRAINT "market_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_health_events" (
    "id" BIGSERIAL NOT NULL,
    "provider_name" TEXT NOT NULL,
    "status" "provider_status" NOT NULL,
    "latency_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_health_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_pricing_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "adjustment_kind" "adjustment_kind" NOT NULL DEFAULT 'absolute',
    "adjustment_value" BIGINT NOT NULL DEFAULT 0,
    "adjustment_bps" INTEGER NOT NULL DEFAULT 0,
    "rounding_step_paise" INTEGER NOT NULL DEFAULT 100,
    "rounding_mode" "rounding_mode" NOT NULL DEFAULT 'half_up',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_rates" (
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "rate_display_paise" BIGINT NOT NULL,
    "base_display_paise" BIGINT NOT NULL,
    "adjustment_display_paise" BIGINT NOT NULL,
    "display_unit" "display_unit" NOT NULL,
    "rate_per_gram" BIGINT NOT NULL,
    "source_market_rate_id" BIGINT,
    "pricing_rule_id" UUID,
    "provider_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_rates_pkey" PRIMARY KEY ("tenant_id","product_id")
);

-- CreateTable
CREATE TABLE "rate_update_events" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "old_rate_paise" BIGINT,
    "new_rate_paise" BIGINT NOT NULL,
    "direction" "rate_direction" NOT NULL,
    "trigger" "rate_trigger" NOT NULL,
    "market_rate_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_update_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_tenants_status" ON "tenants"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_supabase_user_id" ON "users"("supabase_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_tenant_users_user_id" ON "tenant_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_tenant_users_user_id" ON "tenant_users"("user_id");

-- CreateIndex
CREATE INDEX "idx_customer_links_tenant_id" ON "customer_links"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_products_metal_code" ON "products"("metal_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_products_metal_purity" ON "products"("metal_code", "purity_num", "purity_den");

-- CreateIndex
CREATE INDEX "idx_tenant_products_product_id" ON "tenant_products"("product_id");

-- CreateIndex
CREATE INDEX "idx_market_rates_symbol_provider_ts" ON "market_rates"("symbol", "provider_timestamp" DESC);

-- CreateIndex
CREATE INDEX "idx_market_rates_ingested_at" ON "market_rates"("ingested_at");

-- CreateIndex
CREATE INDEX "idx_provider_health_provider_created" ON "provider_health_events"("provider_name", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_tenant_pricing_rules_tenant_product" ON "tenant_pricing_rules"("tenant_id", "product_id");

-- CreateIndex
CREATE INDEX "idx_published_rates_product_id" ON "published_rates"("product_id");

-- CreateIndex
CREATE INDEX "idx_rate_update_events_tenant_created" ON "rate_update_events"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_logs_tenant_created" ON "audit_logs"("tenant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_links" ADD CONSTRAINT "customer_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_links" ADD CONSTRAINT "customer_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_contacts" ADD CONSTRAINT "tenant_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_metal_code_fkey" FOREIGN KEY ("metal_code") REFERENCES "metals"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_products" ADD CONSTRAINT "tenant_products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_products" ADD CONSTRAINT "tenant_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_pricing_rules" ADD CONSTRAINT "tenant_pricing_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_pricing_rules" ADD CONSTRAINT "tenant_pricing_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_pricing_rules" ADD CONSTRAINT "tenant_pricing_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_rates" ADD CONSTRAINT "published_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_rates" ADD CONSTRAINT "published_rates_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_rates" ADD CONSTRAINT "published_rates_source_market_rate_id_fkey" FOREIGN KEY ("source_market_rate_id") REFERENCES "market_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_rates" ADD CONSTRAINT "published_rates_pricing_rule_id_fkey" FOREIGN KEY ("pricing_rule_id") REFERENCES "tenant_pricing_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_update_events" ADD CONSTRAINT "rate_update_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_update_events" ADD CONSTRAINT "rate_update_events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_update_events" ADD CONSTRAINT "rate_update_events_market_rate_id_fkey" FOREIGN KEY ("market_rate_id") REFERENCES "market_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
