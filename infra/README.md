# Infrastructure

> **The dev environment is provisioned.** `bullion-dev-rg` in `centralindia`
> holds PostgreSQL, Managed Redis, Key Vault, Storage, ACR, a Container Apps
> environment, Log Analytics and App Insights. Migrations are applied and the
> roles exist. The Container App itself is **not** created — the API refuses to
> start in production until a licensed market-data provider is configured, so
> there is nothing yet to run. See *Remaining blockers* at the end.

Target: `centralindia` — the product serves Indian jewellers, and every other
workload in this subscription already lives there.

> **Redis note.** Azure Cache for Redis is retiring and the control plane now
> refuses to create one (`"Azure Cache for Redis is retiring, create Azure
> Managed Redis instead"`), so this template uses **Azure Managed Redis**
> (`Microsoft.Cache/redisEnterprise`). Balanced B0 is also cheaper than the
> Basic C0 it replaces, ~$12/mo against ~$16.

---

## What it creates

| Resource | Dev SKU | Prod SKU | ~Dev cost/mo |
|---|---|---|---|
| PostgreSQL Flexible Server | B1ms Burstable | D2ds_v5 GeneralPurpose, ZoneRedundant | $15–25 |
| Azure Managed Redis | Balanced B0 | Balanced B1 | ~$12 |
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

1. **Create the runtime roles.** The application must connect as a
   non-superuser, non-owner role, or PostgreSQL RLS silently does nothing and
   every tenant-isolation guarantee evaporates.

   Generate the passwords here and pass them in. The script defaults them to
   the local development value so the Docker entrypoint can run unattended, so
   running it bare against Azure would give production a role whose password is
   literally `devpassword`:

   ```bash
   APP_PASSWORD=$(openssl rand -base64 32)
   MAINTENANCE_PASSWORD=$(openssl rand -base64 32)

   psql "$ADMIN_URL" \
     -v ON_ERROR_STOP=1 \
     -v app_password="$APP_PASSWORD" \
     -v maintenance_password="$MAINTENANCE_PASSWORD" \
     -v db_name=bullion \
     -f apps/api/prisma/init/00_app_role.sql
   ```

   Store both immediately — they are not recoverable from the server:

   ```bash
   az keyvault secret set --vault-name <kv> --name database-url \
     --value "postgresql://bullion_app:$APP_PASSWORD@<host>/bullion?sslmode=require"
   az keyvault secret set --vault-name <kv> --name maintenance-database-url \
     --value "postgresql://bullion_maintenance:$MAINTENANCE_PASSWORD@<host>/bullion?sslmode=require"
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

---

## The provisioned dev environment

Read back from Azure, not transcribed by hand.

| Thing | Value |
|---|---|
| Resource group | `bullion-dev-rg` (`centralindia`) |
| PostgreSQL | `bullion-dev-pg.postgres.database.azure.com`, database `bullion` |
| Redis | `bullion-dev-redis.centralindia.redis.azure.net:10000` (TLS only) |
| Container registry | `bulliondevacr5qzxpei4m7s22.azurecr.io` |
| Key Vault | `bulliondev-5qzxpei4m7s22` |
| Container Apps env | `bullion-dev-env` |
| Managed identity | `bullion-dev-api-identity` |

Key Vault holds `database-url`, `maintenance-database-url` and `redis-url`.
The database passwords exist only there — they were generated at role-creation
time and never written to disk.

### Entra External ID

| Setting | Value |
|---|---|
| Tenant | `bullionshops.onmicrosoft.com` |
| `AUTH_DIRECTORY_ID` | `f02e7b26-7b99-45ff-9696-d45c70cdb6c2` |
| `AUTH_ISSUER` | `https://f02e7b26-7b99-45ff-9696-d45c70cdb6c2.ciamlogin.com/f02e7b26-7b99-45ff-9696-d45c70cdb6c2/v2.0` |
| `AUTH_AUDIENCE` | `api://bullion-rates` |
| `AUTH_ALLOWED_CLIENT_IDS` | `46ab7716-17fc-42c9-8a81-2667c2650c29` (bullion-web) |
| `AUTH_JWT_ALGORITHMS` | `RS256` |

The issuer uses the **tenant-GUID** subdomain, which is what tokens carry;
asking the `bullionshops.` host returns the same issuer but a different
`jwks_uri`. Leave `AUTH_JWKS_URL` unset so it is derived from the issuer and the
two cannot drift apart.

`bullion-web` is a public client with PKCE and no secret. Its only redirect URI
is `http://localhost:3000/auth/callback`; add the real one when the frontend
exists.

### Verified on the live server

```
bullion_owner        rolsuper=f  rolbypassrls=t
bullion_app          rolsuper=f  rolbypassrls=f
bullion_maintenance  rolsuper=f  rolbypassrls=t   grants: idempotency_keys only

RLS enabled AND forced on 10/10 tenant tables
bullion_app with no tenant context sees 0 tenants
```

The middle line is the one that matters: the application role cannot bypass
RLS on the real server, and a context-less session genuinely sees nothing.

## Remaining blockers

1. **No market-data provider is licensed.** `MARKET_DATA_PROVIDER=mock` is
   refused in production and every real provider is blocked pending written
   redistribution confirmation, so the API still exits `78` on start. This is
   the only thing standing between the current state and a running service.
2. **No frontend.** `apps/` contains only `api`, so there is nothing for a
   shopkeeper or customer to open.
3. **The Container App is not created.** Deliberate: there is no point starting
   a revision that cannot pass its own configuration check. `cd.yml` creates and
   updates it once (1) is resolved.
