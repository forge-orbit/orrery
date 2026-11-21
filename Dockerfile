# syntax=docker/dockerfile:1
# One image serves the web app, the REST API and MCP. Postgres runs alongside it (compose.yaml).

ARG NODE_VERSION=26
ARG PNPM_VERSION=12.21.0

FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contract/package.json packages/contract/
COPY tests/e2e/package.json tests/e2e/

# Build the web app.
FROM base AS web
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter @orrery/web...
COPY packages/contract packages/contract
COPY apps/web apps/web
COPY assets/orrery-mark.svg assets/orrery-mark-dark.svg assets/
RUN pnpm --filter @orrery/web build

# Production dependencies for the server only. Node runs the TypeScript sources directly.
FROM base AS server
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm-store --filter @orrery/server...
COPY packages/contract packages/contract
COPY apps/server/src apps/server/src
COPY db/migrations db/migrations

FROM node:${NODE_VERSION}-slim
ARG ORRERY_VERSION=dev
LABEL org.opencontainers.image.title="Orrery" \
      org.opencontainers.image.description="Self-hosted project management for teams of humans and AI agents." \
      org.opencontainers.image.vendor="Forge Orbit" \
      org.opencontainers.image.source="https://github.com/forge-orbit/orrery" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production \
    ORRERY_VERSION=${ORRERY_VERSION} \
    PORT=8080 \
    WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY --from=server /app /app
COPY --from=web /app/apps/web/dist /app/apps/web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/server/src/main.ts"]
