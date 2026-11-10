# syntax=docker/dockerfile:1
#
# The Tablemate API image (AAP 0.4.2, 0.6.2, 0.7.1). Build it from the repository root, which is the
# build context every Tablemate image shares (.dockerignore):
#
#   docker build -f apps/api/Dockerfile --target runtime .
#   docker build -f apps/api/Dockerfile --target test-support .
#
# Stages: base -> manifests -> {build -> test-support, prod-deps, runtime}. `runtime` is last, so a
# plain build without `--target` yields it. WORKDIR /app mirrors the repository layout, so the
# repo-relative paths the code resolves (config/..., packages/circuits/build/...) are identical on
# the host and in the container.

# ---- base: Node 22.23.4 and the pnpm release the workspace pins ----
FROM node:22.23.4-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
# openssl: the Prisma query engine's debian-openssl-3.0.x and linux-arm64-openssl-3.0.x binary
# targets link libssl3 (AAP 0.4.1). ca-certificates: outbound TLS to Stripe, the language model,
# Overpass and the menu websites.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- manifests: everything `pnpm install` reads, so the dependency layer is cached on those alone ----
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# `pnpm-workspace.yaml` patches four packages and `pnpm install` aborts with ERR_PNPM_PATCH_NOT_FOUND
# when those files are not beside it.
COPY patches/ patches/
# All eight workspace manifests, so the frozen lockfile matches every importer it records.
COPY apps/api/package.json apps/api/
COPY apps/workers/package.json apps/workers/
COPY apps/mobile/package.json apps/mobile/
COPY apps/venue-console/package.json apps/venue-console/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/server-core/package.json packages/server-core/
COPY packages/circuits/package.json packages/circuits/

# ---- build: the api's dependency graph plus the root tooling, then the compiled workspace ----
FROM manifests AS build
# `--filter tablemate` selects the root package (TypeScript, tsx, Vitest) and `--filter
# "@tablemate/api..."` the api with every workspace it imports (shared, db, server-core, circuits).
# The Expo and React Native tree of apps/mobile and the Playwright tree of apps/workers stay out.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --filter tablemate --filter "@tablemate/api..."
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY config/ config/
# The generated Prisma client into the hoisted node_modules/.prisma, which is a dev-time step
# (`pnpm --filter @tablemate/db generate`) that the runtime image would otherwise lack.
RUN pnpm --filter @tablemate/db generate
RUN pnpm exec tsc -b apps/api/tsconfig.json

# ---- test-support: the full workspace with dev dependencies, for tooling rather than serving ----
# Compose runs `migrate` (`pnpm db:deploy && pnpm db:seed`), `stripe-proxy` and `voice-sim` on this
# target; compose supplies each service's command, so the stage sets none of its own.
FROM build AS test-support
ENV NODE_ENV=development

# ---- prod-deps: production dependencies alone, for the runtime image ----
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "@tablemate/api..."

# ---- runtime: production dependencies, compiled output and the committed configuration ----
# The API verifies itinerary proofs and never produces one: this image holds no proving key, no
# circuit compiler output and no proving code path, and the compose `api` service bind-mounts the
# verification key and the artefact manifest alone (AAP 0.5.5, 0.12.2). Every COPY below names an
# explicit source path, and each compiled output is copied without any test harness.
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Manifests and production node_modules; the workspace packages are symlinked under
# node_modules/@tablemate/, so the copies below must land at those same paths.
COPY --from=prod-deps /app/ /app/
# Three production dependencies ship demo-circuit fixtures of their own test suites, one of them a
# complete set: a constraint system, its key and the generator that turns inputs into an instance of
# it. Snarkjs loads those packages' libraries and never their test directories, so the directories
# go, and a scan of the serving image then finds no proving material at all - ours or a dependency's.
RUN rm -rf /app/node_modules/circom_runtime/test /app/node_modules/r1csfile/test /app/node_modules/wasmcurves/test
# The generated Prisma client and its query-engine library; the prisma CLI is a dev dependency and
# is deliberately absent here.
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
# Compiled workspace output.
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/server-core/dist /app/packages/server-core/dist
COPY --from=build /app/packages/db/dist /app/packages/db/dist
# Only the library build of packages/circuits: its registry builder is what the API imports, and
# nothing of its build and setup tooling belongs in a serving image.
COPY --from=build /app/packages/circuits/dist/src /app/packages/circuits/dist/src
# Only the server build of the api and its operator scripts, never its test harness. dist/scripts
# lets an operator run `node apps/api/dist/scripts/grant-operator.js` and the measuring mode of
# bench-verify inside this container (AAP 0.5.5).
COPY --from=build /app/apps/api/dist/src /app/apps/api/dist/src
COPY --from=build /app/apps/api/dist/scripts /app/apps/api/dist/scripts
# The configuration the API reads from disk at startup: the workspace marker that locates the
# repository root, the launch cities, the issuer key records and the committed registries. The
# fixtures are seed-only and stay out.
COPY --from=build /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=build /app/config/cities.json /app/config/cities.json
COPY --from=build /app/config/issuers /app/config/issuers
COPY --from=build /app/config/registry /app/config/registry
# The directory the compose bind mounts of the verification key and the artefact manifest need to
# exist; nothing is ever copied into it.
RUN mkdir -p /app/packages/circuits/build && chown node:node /app/packages/circuits/build
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "apps/api/dist/src/main.js"]
