# Tablemate web client: the Expo web export of apps/mobile, served by nginx (AAP 0.7.1, AAP 0.8.1).
# Both stages build from the repository root, so every COPY path below is repository-root relative and
# .dockerignore is what keeps secrets, host installs and proving artefacts out of the context.
FROM node:22.23.4-bookworm-slim AS build

# The root package.json pins pnpm 12.16.1 in `packageManager`; Corepack activates that same version.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate

# Deliberately no NODE_ENV=production: the export runs on the devDependencies the SDK 52 toolchain
# expects (babel-preset-expo), and `expo export` puts the bundle in production mode itself.
ENV CI=1 \
    EXPO_NO_TELEMETRY=1

WORKDIR /app

# Manifests first, so the install layer survives a change to the sources. Every workspace manifest is
# copied rather than only the two the filter installs: pnpm still resolves the whole workspace here and
# matches the lockfile's importer set against the projects on disk.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
# pnpm resolves every `patchedDependencies` entry of pnpm-workspace.yaml at install time, filtered or
# not, and fails with ERR_PNPM_PATCH_NOT_FOUND when the file is absent.
COPY patches/ patches/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY apps/venue-console/package.json apps/venue-console/
COPY apps/workers/package.json apps/workers/
COPY packages/circuits/package.json packages/circuits/
COPY packages/db/package.json packages/db/
COPY packages/server-core/package.json packages/server-core/
COPY packages/shared/package.json packages/shared/

# The trailing `...` adds the app's two workspace dependencies (@tablemate/shared and
# @tablemate/circuits) and nothing else, which keeps the API, worker and console graphs out of this
# image. The hoisted linker comes from pnpm-workspace.yaml, as Expo SDK 52's Metro requires.
#
# pnpm installs the workspace root's own devDependencies whatever the filter selects — the
# repository's test toolchain, which nothing here uses. The optional native addons among them
# (cpu-features, ssh2) cannot compile in a slim image and pnpm lets their install scripts fail, so
# this layer logs gyp errors that are expected and harmless.
RUN pnpm install --frozen-lockfile --filter @tablemate/mobile...

# Everything the bundle is built from. Both workspace packages publish their TypeScript source through
# the `tablemate-source` condition, so these sources are what Metro reads, and tsconfig.base.json is
# copied because apps/mobile/tsconfig.json extends it. `config/` is the issuer and registry JSON plus
# the `.eml` fixture that app/dev/zk-bench.tsx bundles as an asset; the proving artefacts themselves
# are served by the separate `artifacts` service and no image carries a proving key (AAP 0.5.5).
COPY tsconfig.base.json ./
COPY config/ config/
COPY packages/shared/ packages/shared/
COPY packages/circuits/src/ packages/circuits/src/
COPY packages/circuits/fixtures/ packages/circuits/fixtures/
COPY apps/mobile/ apps/mobile/

# Build-time client configuration, re-exported as ENV because Expo inlines `EXPO_PUBLIC_*` into the
# bundle. app.config.ts fails the export when either origin is missing or malformed, so the two origins
# carry the local stack's values and compose overrides them per environment.
ARG EXPO_PUBLIC_API_URL=http://localhost:3000
ARG EXPO_PUBLIC_WS_URL=ws://localhost:3000
# Optional: the app holds Stripe's publishable key and nothing else, and an empty value leaves the card
# screens reporting that payments are not configured. app.config.ts rejects a secret key here outright.
ARG EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=
# Optional, '0' or '1': '1' exposes the device proving benchmark, which the `bench` build profile alone
# sets.
ARG EXPO_PUBLIC_ZK_BENCH=0
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL \
    EXPO_PUBLIC_WS_URL=$EXPO_PUBLIC_WS_URL \
    EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=$EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY \
    EXPO_PUBLIC_ZK_BENCH=$EXPO_PUBLIC_ZK_BENCH

# Bundles the proving Worker to apps/mobile/public/prover.worker.js first, which `expo export` then
# copies into the export, and writes the app to apps/mobile/dist.
RUN pnpm --filter @tablemate/mobile export:web

FROM nginx:1.30.6-alpine AS serve

# The entrypoint renders the template copied below with envsubst, limited here to the origins
# infra/nginx/web.conf substitutes, so no other environment variable can reach the rendered config. The
# defaults keep that config valid when compose passes none, an unreplaced token being no origin at all;
# compose overrides them per environment. API_ORIGIN is the browser-facing API, ARTIFACTS_ORIGIN the
# proving artefacts and WEB_ORIGIN the web client's own origin.
ENV NGINX_ENVSUBST_FILTER='^(API_ORIGIN|ARTIFACTS_ORIGIN|WEB_ORIGIN)$' \
    API_ORIGIN=http://localhost:3000 \
    ARTIFACTS_ORIGIN=http://localhost:8070 \
    WEB_ORIGIN=http://localhost:8080

# Removed rather than left beside the rendered one: the stock config also listens on port 80, and which
# of the two answers a request would then be a matter of file order.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY infra/nginx/web.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/mobile/dist/ /usr/share/nginx/html/

EXPOSE 80

# busybox wget ships with the alpine image, and the entry document is what this image exists to serve,
# so a bundle that never landed fails the check. web.conf's /healthz stays available to compose.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

# The nginx image's own CMD starts its entrypoint and the server. This image holds only the export, the
# nginx template and the server: no Node runtime, no source and no secret.
