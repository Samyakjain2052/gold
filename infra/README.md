# Infrastructure

> **Nothing here has been provisioned.** `main.bicep` is the deployable
> definition; it compiles cleanly (`az bicep build`, zero warnings) and creates
> nothing until you run it.

Target: `centralindia` — the product serves Indian jewellers, and every other
workload in this subscription already lives there.

---

## What it creates

| Resource | Dev SKU | Prod SKU | ~Dev cost/mo |
|---|---|---|---|
| PostgreSQL Flexible Server | B1ms Burstable | D2ds_v5 GeneralPurpose, ZoneRedundant | $15–25 |
| Azure Cache for Redis | Basic C0 | Standard C1 | ~$16 |
| Storage (logos) | Standard_LRS | Standard_ZRS | ~$2 |
| Key Vault | Standard, RBAC | + purge protection | ~$1 |
| Container Registry | Basic | Basic | ~$5 |
| Container Apps environment | — | — | per-app |
| Log Analytics + App Insights | 30-day retention | 90-day | ~$2 |

**≈ $40–50/month for dev.** Production roughly triples with HA and the larger
database tier.

Security posture baked in rather than configured afterwards: TLS enforced on
PostgreSQL and Redis, no non-SSL Redis port, blob public access disabled, ACR
admin user disabled, Key Vault on RBAC with soft delete, and every cross-service
permission granted to a **user-assigned managed identity** — no stored
credentials anywhere.

---

## Prerequisites (in order)

### 1. An Entra External ID tenant

This does **not** exist yet, and the API will not start in production without
it. Your current directory (`samyakjain9761gmail.onmicrosoft.com`) is a
*workforce* tenant: putting jewellery shopkeepers in it would make each one a
directory user, which is the wrong licensing and lifecycle model for external
customers.

External ID is a separate tenant type, created from the portal:

```
Azure portal → Microsoft Entra ID → Overview → Manage tenants → Create
  → choose "External"          ← not "Workforce"
  → region: Asia Pacific / India
  → domain: e.g. bullionshops.onmicrosoft.com
```

Free up to 50,000 monthly active users.

### 2. App registrations

Two, in the **External ID** tenant:

| Registration | Purpose | Notes |
|---|---|---|
| `bullion-api` | This API | Expose an API → Application ID URI, e.g. `api://bullion-rates`. That URI becomes `AUTH_AUDIENCE`. |
| `bullion-web` | The Next.js app | Public client, PKCE, **no client secret**. Its client id becomes `AUTH_ALLOWED_CLIENT_IDS`. |

Then a user flow (sign-up and sign-in) with email + password, and optionally
social providers.

### 3. Read the real values back

Never hand-write these — read them from the tenant so a typo cannot silently
point verification at the wrong directory:

```bash
TENANT=<your-external-id-tenant-guid>
curl -s "https://<subdomain>.ciamlogin.com/$TENANT/v2.0/.well-known/openid-configuration" \
  | jq '{issuer, jwks_uri, id_token_signing_alg_values_supported}'
```

Map the output to configuration:

| Discovery field | Environment variable |
|---|---|
| `issuer` | `AUTH_ISSUER` |
| `jwks_uri` | `AUTH_JWKS_URL` (or leave blank — it is derived from the issuer) |
| `id_token_signing_alg_values_supported` | `AUTH_JWT_ALGORITHMS` |
| tenant GUID | `AUTH_DIRECTORY_ID` |
| API Application ID URI | `AUTH_AUDIENCE` |
| web app client id | `AUTH_ALLOWED_CLIENT_IDS` |

---

## Deploying

```bash
# 1. Resource group
az group create --name bullion-dev-rg --location centralindia

# 2. Preview — changes nothing
az deployment group what-if \
  --resource-group bullion-dev-rg \
  --template-file infra/main.bicep \
  --parameters environment=dev \
               key_vault_admin_object_id="$(az ad signed-in-user show --query id -o tsv)" \
               postgres_admin_password="$(openssl rand -base64 24)"

# 3. Deploy (same command, `create` instead of `what-if`)
az deployment group create --resource-group bullion-dev-rg ... 
```

Run `what-if` first every time. It is free, and it prints exactly what would
change.

### After the first deploy

1. **Create the runtime role.** The application must connect as a
   non-superuser, non-owner role, or PostgreSQL RLS silently does nothing and
   every tenant-isolation guarantee evaporates:

   ```bash
   psql "$ADMIN_URL" -f apps/api/prisma/init/00_app_role.sql
   ```

2. **Store secrets in Key Vault**, never in app settings:

   ```bash
   az keyvault secret set --vault-name <kv> --name database-url --value "..."
   az keyvault secret set --vault-name <kv> --name redis-url    --value "..."
   ```

   Container Apps references them as
   `keyvaultref:<uri>,identityref:<identity-id>`. Omit the version from the URI
   so rotation is picked up without a redeploy.

3. **Run migrations as a discrete step**, never at app startup
   (`deployment-best-practices.md` §7):

   ```bash
   DATABASE_MIGRATION_URL="$ADMIN_URL" npm run db:migrate --workspace apps/api
   ```

---

## Scheduled maintenance: idempotency-key cleanup

`idempotency_keys` lives in PostgreSQL deliberately (see
[docs/pricing-api.md](../docs/pricing-api.md) §4), which means it has no TTL and
must be swept.

The sweep is a **one-off process from the same image** —
`backend-standards.md` §1: "Admin tasks (migrations, scripts) run as one-off
processes with same codebase and config." No in-process timer competes with
request handling, and no second worker architecture is introduced.

Production schedules it as an **Azure Container Apps Job** on a cron trigger,
which `api-standards.md` §11 nominates for exactly this shape of work
("peripheral tasks … cleanup jobs as serverless"):

```bash
az containerapp job create \
  --name bullion-idempotency-cleanup \
  --resource-group bullion-dev-rg \
  --environment "$CONTAINER_ENV" \
  --trigger-type Schedule \
  --cron-expression "0 * * * *" \
  --replica-timeout 600 \
  --replica-retry-limit 1 \
  --image "$ACR/bullion-api:$TAG" \
  --command "npm" --args "run,maintenance:purge-idempotency" \
  --user-assigned "$API_IDENTITY" \
  --secrets "maintenance-db-url=keyvaultref:$KV_URI/secrets/maintenance-database-url,identityref:$API_IDENTITY" \
  --env-vars "DATABASE_MAINTENANCE_URL=secretref:maintenance-db-url" \
             "IDEMPOTENCY_RETENTION_HOURS=48"
```

Hourly is comfortable: retention is 48 hours, so even a day of missed runs loses
nothing. Overlapping runs are safe by design.

**`--replica-retry-limit 1`** matters. The job exits non-zero on failure and
`78` on misconfiguration, so a scheduler alert on repeated failures is the
signal that cleanup has stopped. A job that silently succeeds while deleting
nothing is the failure mode this design is built to avoid — which is why
`DATABASE_MAINTENANCE_URL` has no fallback.

The job is **not** created by `main.bicep`, for the same reason the Container
App is not: it needs an image to exist first. Create it from CI after the first
image push.

### The maintenance credential

`DATABASE_MAINTENANCE_URL` connects as `bullion_maintenance`: `BYPASSRLS`, but
granted `SELECT, DELETE` on `idempotency_keys` and nothing else. Store it in Key
Vault and reference it by managed identity. It is never given to the API.

---

## Why no Container App resource here

The app itself is deployed by CI, which needs an image to exist first. This
template creates the *environment*, registry and identity; the workflow creates
and updates the app with `az containerapp create/update` and a commit-SHA tag,
so rollback is a traffic switch rather than a rebuild.

Production runs `minReplicas: 1` — Container Apps scaling to zero would drop the
SSE connections and the leader-elected market poller.
