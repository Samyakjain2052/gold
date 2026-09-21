# ADR-0001: Next.js on Static Web Apps + Express on Container Apps

- **Status:** Proposed
- **Date:** 2026-09-20
- **Deciders:** Samyak Jain

## Context

The brief offered "Next.js server APIs OR a dedicated Node.js/TypeScript backend," preferring a modular
monolith. The product needs three things a rendering layer cannot provide:

1. A **persistent outbound market-data feed** held open independently of any user request.
2. **Long-lived server→client connections** to every open customer page.
3. A **single leader-elected poller**, so provider call volume is independent of replica count.

The team's `deployment-best-practices.md` §1 puts frontends on Azure Static Web Apps and backend APIs on
Container Apps. `api-standards.md` §11 states: *"Never use serverless for persistent DB/TCP connections
without an external pooler."*

## Decision

**Next.js (App Router) on Static Web Apps for rendering only. Express + TypeScript on Container Apps owns all
state, all persistent connections, and all pricing.**

The web tier holds no pricing logic, no provider credentials, and no database access.

## Rationale

Next.js server code on Static Web Apps executes on managed Azure Functions. Functions are request-scoped and
scale to zero — they cannot hold an SSE connection open for a customer whose phone sits on a counter all day,
and they cannot host a poller that must tick whether or not anyone is browsing. Putting the market feed there
would mean either polling per request (wasteful and rate-limit fatal) or a separate service anyway.

Container Apps with `minReplicas: 1` holds connections, supports the Redis leader lock, and keeps the
PostgreSQL connection pool warm.

The split also satisfies the brief's hardest security requirement structurally rather than by convention:
**the browser cannot compute a trusted price because it has no pricing code and no market data key.** It
receives already-computed rates.

A modular monolith — modules under `apps/api/src/modules/*`, one process, one deployable — was chosen over
microservices. There is no scaling axis here that differs between pricing and tenancy.

## Consequences

**Positive.** Persistent connections work. Provider calls stay constant regardless of traffic. Pricing secrets
never enter a browser bundle. Both tiers follow existing team deployment patterns. Either tier scales
independently.

**Negative.** Two deployables instead of one, so two CI paths and a CORS configuration. Shared types need a
`packages/contracts` workspace to prevent drift. Container Apps at `minReplicas: 1` costs ~$15–30/mo where SWA
alone would be free.

**Accepted.** The cost is roughly one month of market-data subscription, and the alternative does not work.

## Alternatives

**Next.js API routes only** — rejected: cannot hold SSE or the poller.

**Next.js on Container Apps (`output: "standalone"`)** — one deployable, keeps SSE. Rejected as it forgoes SWA's
free tier, free PR previews, and managed CDN, and mixes rendering with connection-holding in one scaling unit.
Reconsider if the two-deployable overhead proves worse than expected.

**NestJS instead of Express** — both are permitted by `backend-standards.md` §2. Express chosen for a smaller
surface at this size; NestJS's DI and module system would earn their weight on a larger team.
