// Bullion Rates Platform — Azure infrastructure.
//
// NOTHING HERE HAS BEEN PROVISIONED. This is the deployable definition; run it
// when you choose to. See infra/README.md for the exact commands and the
// prerequisites that must exist first (Entra External ID tenant, app
// registrations).
//
// Aligned with deployment-best-practices.md §1: Container Apps for the API,
// PostgreSQL Flexible Server, Azure Managed Redis, Key Vault, Blob Storage,
// ACR, and Log Analytics + Application Insights.
//
// Region defaults to centralindia — the product serves Indian jewellers, and
// every other workload in this subscription already lives there.

targetScope = 'resourceGroup'

@description('Short environment name. Kept granular per backend-standards.md §3.')
@allowed(['dev', 'staging', 'prod'])
param environment string = 'dev'

@description('Azure region. Indian data residency for an Indian product.')
param location string = 'centralindia'

@description('Base name for generated resource names.')
param app_name string = 'bullion'

@description('PostgreSQL administrator login. NOT the runtime role.')
param postgres_admin_login string = 'bullion_owner'

@secure()
@description('Administrator password. Pass at deploy time; never commit it.')
param postgres_admin_password string

@description('Object id of the operator or deployment principal granted Key Vault access.')
param key_vault_admin_object_id string

// Dev is deliberately the cheapest tier that still exercises the real services;
// production sizes up. Sizing per deployment-best-practices.md §11.
var is_production = environment == 'prod'
var suffix = uniqueString(resourceGroup().id, app_name, environment)
var prefix = '${app_name}-${environment}'

// Generated names are anchored on `suffix`, which uniqueString() guarantees is
// exactly 13 characters. The variable part is truncated around it, so every
// name provably satisfies its service's minimum and maximum length even if a
// very short app_name is supplied.
var name_stem = toLower(replace('${app_name}${environment}', '-', ''))

// Storage: lowercase alphanumeric, 3-24 chars → 13..24 here.
var storage_name = '${take(name_stem, 11)}${suffix}'
// ACR: alphanumeric, 5-50 chars → 16..50 here.
var acr_name = '${take(name_stem, 20)}acr${suffix}'
// Key Vault: 3-24 chars → 14..24 here.
var key_vault_name = '${take(name_stem, 10)}-${suffix}'

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

resource log_analytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: is_production ? 90 : 30
  }
}

resource app_insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: log_analytics.id
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg'
  location: location
  sku: {
    // Burstable for dev (~$15-25/mo); General Purpose for production.
    name: is_production ? 'Standard_D2ds_v5' : 'Standard_B1ms'
    tier: is_production ? 'GeneralPurpose' : 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgres_admin_login
    administratorLoginPassword: postgres_admin_password
    storage: { storageSizeGB: is_production ? 128 : 32 }
    backup: {
      backupRetentionDays: is_production ? 30 : 7
      geoRedundantBackup: is_production ? 'Enabled' : 'Disabled'
    }
    highAvailability: { mode: is_production ? 'ZoneRedundant' : 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource postgres_database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'bullion'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// TLS is not optional: database-best-practices.md requires encryption in
// transit, and config.ts refuses to boot in production without sslmode=require.
resource postgres_require_tls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
}

// Azure Managed Redis, not Azure Cache for Redis. The latter is retiring and
// the control plane now refuses to create one at all:
//   "Azure Cache for Redis is retiring, create Azure Managed Redis instead."
// Balanced B0 is also cheaper than the Basic C0 it replaces (~$12/mo vs ~$16).
resource redis 'Microsoft.Cache/redisEnterprise@2025-04-01' = {
  name: '${prefix}-redis'
  location: location
  sku: {
    name: is_production ? 'Balanced_B1' : 'Balanced_B0'
  }
  properties: {
    minimumTlsVersion: '1.2'
  }
}

resource redis_db 'Microsoft.Cache/redisEnterprise/databases@2025-04-01' = {
  parent: redis
  name: 'default'
  properties: {
    // Encrypted admits TLS connections only, matching config.ts, which refuses
    // a REDIS_URL that is not rediss:// in production.
    clientProtocol: 'Encrypted'
    port: 10000
    // EnterpriseCluster presents one endpoint and the ordinary non-clustered
    // Redis API, so the node client connects without cluster awareness.
    clusteringPolicy: 'EnterpriseCluster'
    // Rate-limit counters and the published-rate cache are both reconstructible,
    // but silently evicting a key under pressure would let a client past its
    // limit. Fail loudly instead and size the cache deliberately.
    evictionPolicy: 'NoEviction'
  }
}

// ---------------------------------------------------------------------------
// Storage — tenant logos
// ---------------------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storage_name
  location: location
  sku: { name: is_production ? 'Standard_ZRS' : 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource blob_service 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    // Soft delete and versioning per deployment-best-practices.md §7 — a
    // mis-uploaded or deleted logo is recoverable.
    deleteRetentionPolicy: { enabled: true, days: 30 }
    isVersioningEnabled: true
  }
}

resource logo_container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob_service
  name: 'tenant-logos'
  properties: {
    // Never 'Blob' or 'Container': logos are served through the app/CDN, not by
    // anonymous enumeration of the account.
    publicAccess: 'None'
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

resource key_vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: key_vault_name
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: is_production ? 90 : 7
    enablePurgeProtection: is_production ? true : null
  }
}

// ---------------------------------------------------------------------------
// Container registry and apps
// ---------------------------------------------------------------------------

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acr_name
  location: location
  sku: { name: 'Basic' }
  properties: {
    // Managed identity pulls images; no admin user, no stored credentials.
    adminUserEnabled: false
  }
}

resource container_env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: log_analytics.properties.customerId
        sharedKey: log_analytics.listKeys().primarySharedKey
      }
    }
  }
}

resource api_identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-api-identity'
  location: location
}

// ---------------------------------------------------------------------------
// Role assignments — managed identity, never stored credentials
// ---------------------------------------------------------------------------

var key_vault_secrets_user = '4633458b-17de-408a-b874-0445c86b69e6'
var acr_pull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var blob_contributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var key_vault_admin = '00482a5a-887f-4fb3-b363-3b7fe8e74483'

resource api_kv_access 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: key_vault
  name: guid(key_vault.id, api_identity.id, key_vault_secrets_user)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', key_vault_secrets_user)
    principalId: api_identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource operator_kv_access 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: key_vault
  name: guid(key_vault.id, key_vault_admin_object_id, key_vault_admin)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', key_vault_admin)
    principalId: key_vault_admin_object_id
  }
}

resource api_acr_pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, api_identity.id, acr_pull)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acr_pull)
    principalId: api_identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource api_blob_access 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, api_identity.id, blob_contributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blob_contributor)
    principalId: api_identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Outputs — consumed by the deploy workflow. No secrets are emitted.
// ---------------------------------------------------------------------------

output resource_group string = resourceGroup().name
output location string = location
output postgres_fqdn string = postgres.properties.fullyQualifiedDomainName
output postgres_database string = postgres_database.name
output redis_host string = redis.properties.hostName
output redis_port int = redis_db.properties.port
output storage_account string = storage.name
output logo_container string = logo_container.name
output key_vault_name string = key_vault.name
output key_vault_uri string = key_vault.properties.vaultUri
output registry_login_server string = registry.properties.loginServer
output container_environment_id string = container_env.id
output api_identity_id string = api_identity.id
output api_identity_client_id string = api_identity.properties.clientId
output app_insights_connection_string string = app_insights.properties.ConnectionString
output directory_tenant_id string = subscription().tenantId
