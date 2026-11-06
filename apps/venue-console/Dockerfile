# Tablemate venue console: the Vite build of apps/venue-console, served by nginx (AAP 0.7.1, 0.8.1).
# Both stages build from the repository root, so every COPY path below is repository-root relative.
FROM node:22.23.4-bookworm-slim AS build

# The root package.json pins pnpm 12.16.1 in `packageManager`; Corepack activates the same version.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate

WORKDIR /app

# Manifests first, so the install layer survives a change to the sources.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
# pnpm resolves every `patchedDependencies` entry of pnpm-workspace.yaml at install time, filtered or
# not, and fails with ERR_PNPM_PATCH_NOT_FOUND when the file is absent.
COPY patches/ patches/
COPY packages/shared/package.json packages/shared/
COPY apps/venue-console/package.json apps/venue-console/

# The trailing `...` adds the workspace's own dependency (@tablemate/shared) and nothing else, which
# keeps Prisma, sharp, Playwright and the Expo toolchain out of this image.
RUN pnpm install --frozen-lockfile --filter @tablemate/venue-console...

# tsconfig.base.json is copied because apps/venue-console/tsconfig.json extends it, and the Vite build
# fails on an extends target that is not there.
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/venue-console/ apps/venue-console/

# Deliberately no default: vite.config.ts fails the build when VITE_API_URL is missing or malformed.
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

RUN pnpm --filter @tablemate/venue-console build

FROM nginx:1.30.6-alpine AS serve

# The entrypoint's envsubst replaces only variables that are defined, so this default keeps the CSP
# `connect-src` valid when compose passes no API_ORIGIN; compose overrides it per environment.
ENV API_ORIGIN=http://localhost:3000

COPY infra/nginx/venue-console.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/venue-console/dist/ /usr/share/nginx/html/

EXPOSE 80

# busybox wget ships with the alpine image; /venue also exercises the SPA fallback.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1/venue || exit 1
