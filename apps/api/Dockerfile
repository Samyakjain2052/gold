# Runtime image for the bullion rates API.
#
# Multi-stage so the toolchain that compiles TypeScript and generates the Prisma
# client never reaches the shipped image. The final stage carries production
# dependencies, the compiled `dist/`, and the generated client — nothing else.
#
# Debian slim rather than Alpine: Prisma ships glibc-linked engine binaries, and
# the musl variants are a recurring source of "works locally, segfaults in the
# cluster". The image is larger; the failure mode it avoids is worse.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Manifests first, so the dependency layer is cached until they actually change.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/

RUN npm ci --workspace apps/api --include-workspace-root

COPY tsconfig.base.json ./
COPY apps/api/ apps/api/

# Generates into node_modules/.prisma/client. Copied forward explicitly below,
# because the runtime stage reinstalls node_modules from scratch.
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

RUN npm run build --workspace apps/api

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app

# openssl is a Prisma runtime requirement, not a build-only one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/

# --ignore-scripts: no postinstall from a transitive dependency runs in the
# image we ship. The one generation step we do want was done in stage 1 and is
# copied in below.
RUN npm ci --workspace apps/api --include-workspace-root \
      --omit=dev --ignore-scripts \
 && npm cache clean --force

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/apps/api/dist ./apps/api/dist

# Schema and migrations travel with the image so the deployed artefact and the
# migrations applied to it are always the same commit.
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

# node:22-slim ships an unprivileged `node` user; a compromised process should
# not be root inside the container.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# Readiness, not liveness: Container Apps should withhold traffic until
# PostgreSQL and Redis are actually reachable. A container that is alive but
# cannot reach its database must not be sent requests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api

# Exec form, so node is PID 1 and receives SIGTERM directly. Wrapping it in npm
# would swallow the signal and turn every deploy into a 30-second kill wait,
# dropping in-flight SSE connections.
CMD ["node", "dist/index.js"]
