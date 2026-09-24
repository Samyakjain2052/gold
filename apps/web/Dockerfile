# Runtime image for the Next.js frontend.
#
# `/r/[slug]` is `force-dynamic` server-rendered per request (so one shop's page
# can never be cached and served for another), which rules out a purely static
# host. This runs the Next server itself.
#
# `NEXT_PUBLIC_*` values are inlined into the browser bundle at **build** time,
# and `next.config.ts` builds the CSP from two of them. The image is therefore
# environment-specific by construction: it cannot be built once and promoted
# between environments, and the build args below must name the environment it is
# being built for.

FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/

RUN npm ci --workspace apps/web --include-workspace-root

COPY packages/contracts/ packages/contracts/
COPY apps/web/ apps/web/

# Baked into the bundle and into the Content-Security-Policy.
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_AUTH_AUTHORITY
ARG NEXT_PUBLIC_AUTH_CLIENT_ID
ARG NEXT_PUBLIC_AUTH_SCOPES

ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_AUTH_AUTHORITY=$NEXT_PUBLIC_AUTH_AUTHORITY \
    NEXT_PUBLIC_AUTH_CLIENT_ID=$NEXT_PUBLIC_AUTH_CLIENT_ID \
    NEXT_PUBLIC_AUTH_SCOPES=$NEXT_PUBLIC_AUTH_SCOPES \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build --workspace apps/web

# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app

# NEXT_DIST_DIR matches `npm run build`, which writes to `.next-build` rather
# than `.next` so a verification build cannot clobber a running dev server's
# output. `next start` must be told the same directory.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    NEXT_DIST_DIR=.next-build

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/

RUN npm ci --workspace apps/web --include-workspace-root --omit=dev --ignore-scripts \
 && npm cache clean --force

COPY --from=build /app/apps/web/.next-build ./apps/web/.next-build
COPY --from=build /app/apps/web/next.config.ts ./apps/web/
COPY --from=build /app/packages/contracts ./packages/contracts

RUN chown -R node:node /app
USER node

EXPOSE 3000

WORKDIR /app/apps/web

# Exec form so node is PID 1 and receives SIGTERM directly.
CMD ["npx", "next", "start", "-p", "3000"]
