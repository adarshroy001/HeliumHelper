# One image for every process (ADR-0011). The command chooses which:
#   API (default)   node --enable-source-maps dist/main.js
#   worker          node --enable-source-maps dist/worker.js        (WORKER_QUEUES, HEALTHCHECK_PORT=3001)
#   migrations      node --enable-source-maps dist/migrate.js up    (a one-off task before each deploy)
#
# Build: docker build -t helium-backend .

ARG NODE_IMAGE=node:24-slim

# --- Dependencies and build ---------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --ignore-scripts: no dependency install scripts run (pnpm-workspace.yaml allows none), and the husky
# `prepare` hook is for developers' machines only.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# Production dependencies only, in a clean folder.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod --ignore-scripts

# --- Runtime -------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# CA bundle for TLS to DocumentDB (MONGO_TLS_CA_FILE=/app/certs/global-bundle.pem in AWS). The folder is made
# first: ADD would give it the file's read-only mode, and a folder needs execute permission to be entered.
RUN mkdir -p /app/certs
ADD --chown=node:node --chmod=444 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/global-bundle.pem

# The official image's unprivileged user.
USER node

EXPOSE 3000

# Liveness of whichever process runs: the API on 3000 by default, the worker sets HEALTHCHECK_PORT=3001.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.HEALTHCHECK_PORT ?? 3000}/health/live`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/main.js"]
