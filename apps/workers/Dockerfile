# syntax=docker/dockerfile:1
#
# The Tablemate workers image (AAP 0.4.2, 0.5.6, 0.6.2, 0.7.1): the background job service that
# refreshes places and lodgings from OpenStreetMap, fetches and extracts menu prices, dispatches the
# automated calls, delivers notifications, expires data and erases accounts.
#
# Build it from the repository root, which is the build context every Tablemate image shares
# (.dockerignore):
#
#   docker build -f apps/workers/Dockerfile .
#
# Stages: base -> manifests -> {build, prod-deps} -> runtime. `runtime` is last, so a plain build
# without `--target` yields it. WORKDIR /app mirrors the repository layout, because this process
# resolves repository-relative paths on disk: apps/workers/src/queues.ts reads config/cities.json and
# apps/workers/src/menus/blocklist.ts reads config/crawl-blocklist.json through the nearest ancestor
# holding pnpm-workspace.yaml, so that marker and both configuration files belong in the image.
#
# Two things this image deliberately does not hold:
#   - Any credential. Settlement belongs to the API, the one process holding the payment secret
#     (AAP 0.3.2), so no Stripe variable appears anywhere here, and every other credential arrives at
#     runtime through the compose environment rather than through a build argument or an ENV
#     (AAP 0.11.2).
#   - Any proving artefact: no circuit build directory, proving key or circuit WASM (AAP 0.5.5).

# ---- base: Node 22.23.4 and the pnpm release the workspace pins ----
FROM node:22.23.4-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
# openssl: the Prisma query engine's debian-openssl-3.0.x and linux-arm64-openssl-3.0.x binary
# targets link libssl3 (AAP 0.4.1). ca-certificates: outbound TLS to Twilio, the language model,
# Overpass, the menu websites and SMTP.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- manifests: everything `pnpm install` reads, so the dependency layer is cached on those alone ----
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# `pnpm-workspace.yaml` patches four packages and `pnpm install` aborts with
# ERR_PNPM_PATCH_NOT_FOUND when those files are not beside it.
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

# ---- build: the workers dependency graph plus the root tooling, then the compiled workspace ----
FROM manifests AS build
# `--filter tablemate` selects the root package (TypeScript, tsx, Vitest) and `--filter
# "@tablemate/workers..."` the workers with every workspace they import. That closure walks the
# dev-dependency edge workers -> @tablemate/api, which is what the compile below needs: the workers
# tsconfig references ../api for the test-support types apps/workers/test/** imports, and that
# project references ../../packages/circuits in turn. apps/api and packages/circuits are therefore
# installed and compiled here, and both are gone again in the prod-deps stage. The Expo and React
# Native tree of apps/mobile stays out.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --filter tablemate --filter "@tablemate/workers..."
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/workers/ apps/workers/
COPY config/ config/
# The generated Prisma client into the hoisted node_modules/.prisma, which is a dev-time step
# (`pnpm --filter @tablemate/db generate`) that the runtime image would otherwise lack.
RUN pnpm --filter @tablemate/db generate
RUN pnpm exec tsc -b apps/workers/tsconfig.json

# ---- prod-deps: production dependencies alone, for the runtime image ----
# The four selected projects are the workers and the three workspace packages they import. Naming
# them one by one rather than filtering on "@tablemate/workers..." is what keeps this tree the
# workers' own: that closure also walks the workers' dev-dependency edge to @tablemate/api, and
# `--prod` prunes devDependencies of the installed projects without pruning the filter's selection,
# so the api's production tree (fastify, stripe, snarkjs, jose) would be installed with it.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter @tablemate/workers --filter @tablemate/shared --filter @tablemate/db --filter @tablemate/server-core

# ---- runtime: production dependencies, compiled output, the tooling the jobs shell out to and the
# committed configuration ----
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

# OCR and PDF tooling (AAP 0.4.2, 0.5.6), pinned exactly. Tesseract 5.3.0 is a Debian bookworm
# package and Poppler 22.12.0 comes from bookworm-security, which the bookworm image's
# debian.sources already lists; both versions are published for amd64 and arm64. The native Tesseract
# CLI replaces tesseract.js, whose Node 22 path aborts on a tessdata_best model (AAP 0.3.1), and
# pdftoppm rasterizes the image-only PDFs that have no text layer to extract.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr=5.3.0-2 \
      poppler-utils=22.12.0-2+deb12u3 \
 && rm -rf /var/lib/apt/lists/*

# The tessdata_best 4.1.0 models for the five menu languages (AAP 0.4.2, 0.5.6). Every file is pinned
# by the SHA-256 of the published 4.1.0 artefact and verified as it lands, so a corpus that changed
# upstream cannot silently change what OCR reads. Tesseract 5 takes TESSDATA_PREFIX as the data
# directory itself and apps/workers/src/menus/ocr.ts relies on that variable, so nothing in the
# application sets it. Debian's own tesseract-ocr-eng and tesseract-ocr-osd packages stay installed
# and unused, because tesseract-ocr depends on them.
#
# The first URL is the published location; the second serves the same tag through the jsDelivr CDN,
# which is what a network that cannot reach raw.githubusercontent.com falls back to. Both are the
# same artefact, and the pinned hash decides, never the host.
ARG TESSDATA_URL=https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0
ARG TESSDATA_MIRROR_URL=https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_best@4.1.0
ARG TESSDATA_ENG_SHA256=8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba
ARG TESSDATA_POR_SHA256=711de9dbb8052067bd42f16b9119967f30bada80d57e2ef24f65d09f531adb04
ARG TESSDATA_SPA_SHA256=e2c1ffdad8b30f26c45d4017a9183d3a7f9aa69e59918be4f88b126fac99ab2c
ARG TESSDATA_THA_SHA256=ee8adab6dc69eb8df3d3c8307ae8295471b7bd7d86a06d9267aa8f479b064eac
ARG TESSDATA_IND_SHA256=1f6596041ffb4cd5094e5f98764db43cfde04edb8f02b988f90ebc1353ac73b8
ENV TESSDATA_PREFIX=/opt/tessdata_best
RUN set -eu; \
    mkdir -p "$TESSDATA_PREFIX"; \
    fetch() { \
      node -e 'const { writeFileSync } = require("node:fs"); fetch(process.argv[1], { signal: AbortSignal.timeout(300000) }).then(async (response) => { if (!response.ok) throw new Error("HTTP " + response.status); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length === 0) throw new Error("empty body"); writeFileSync(process.argv[2], bytes); }).catch((error) => { console.error("  " + process.argv[1] + ": " + error.message); process.exit(1); });' "$1" "$2"; \
    }; \
    model() { \
      lang="$1"; sum="$2"; target="$TESSDATA_PREFIX/$lang.traineddata"; verified=no; \
      for url in "$TESSDATA_URL/$lang.traineddata" "$TESSDATA_MIRROR_URL/$lang.traineddata"; do \
        if fetch "$url" "$target" && echo "$sum  $target" | sha256sum -c - >/dev/null 2>&1; then verified=yes; break; fi; \
      done; \
      test "$verified" = yes || { echo "$lang.traineddata: no source produced the pinned artefact" >&2; exit 1; }; \
      echo "$lang.traineddata verified"; \
    }; \
    model eng "$TESSDATA_ENG_SHA256"; \
    model por "$TESSDATA_POR_SHA256"; \
    model spa "$TESSDATA_SPA_SHA256"; \
    model tha "$TESSDATA_THA_SHA256"; \
    model ind "$TESSDATA_IND_SHA256"; \
    ls -l "$TESSDATA_PREFIX"

# Manifests and production node_modules; the workspace packages are symlinked under
# node_modules/@tablemate/, so the copies below must land at those same paths.
COPY --from=prod-deps /app/ /app/
# The generated Prisma client and its query-engine library; the prisma CLI is a dev dependency and is
# deliberately absent here.
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma

# Chromium for the menu pipeline (AAP 0.4.2: `playwright install --with-deps chromium`). The browser
# lives outside the dependency tree, at PLAYWRIGHT_BROWSERS_PATH, and `--with-deps` installs the
# Debian libraries and fonts it links. Only Chromium is installed - no Firefox and no WebKit -
# because no other code path launches a browser. The installer needs the apt lists, which go
# afterwards, and the browser tree is made readable for the unprivileged user the image runs as.
#
# A Chrome-for-Testing build has one download host in playwright-core, so a network that fails to
# reach cdn.playwright.dev once fails the whole build; the bounded retry loop absorbs that, and each
# attempt downloads afresh rather than resuming a partial archive.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eu; \
    apt-get update; \
    installed=no; \
    for attempt in 1 2 3 4 5; do \
      if node /app/node_modules/playwright/cli.js install --with-deps chromium; then installed=yes; break; fi; \
      echo "playwright install chromium: attempt $attempt failed, retrying" >&2; \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    test "$installed" = yes; \
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

# Compiled workspace output: the three packages this process imports.
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/server-core/dist /app/packages/server-core/dist
COPY --from=build /app/packages/db/dist /app/packages/db/dist
# Only the server build of the workers: dist/src, which is what package.json `exports` and the start
# script point at. dist/test and dist/eval are compiled in the build stage and read the fixtures the
# host serves, so neither belongs in a serving image.
COPY --from=build /app/apps/workers/dist/src /app/apps/workers/dist/src
# The workspace marker that locates the repository root, and the two configuration files read from
# it. config/fixtures is seed-only, and config/issuers and config/registry belong to the proof
# system, which this process never touches.
COPY --from=build /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=build /app/config/cities.json /app/config/cities.json
COPY --from=build /app/config/crawl-blocklist.json /app/config/crawl-blocklist.json

# The one place this process writes: PDF rasterization and OCR stage their files under os.tmpdir()
# (apps/workers/src/menus/{pdf-text,ocr}.ts). TMPDIR points at a directory the unprivileged user owns
# rather than at the shared /tmp.
ENV TMPDIR=/tmp/tablemate
RUN mkdir -p /tmp/tablemate && chown node:node /tmp/tablemate

# No EXPOSE and no HEALTHCHECK: this process serves no port and no service waits on it. Its liveness
# is the process itself plus the structured JSON lines it writes (AAP 0.7.2 keeps monitoring to logs
# and to the API's health endpoint).
USER node
CMD ["node", "--enable-source-maps", "apps/workers/dist/src/main.js"]
