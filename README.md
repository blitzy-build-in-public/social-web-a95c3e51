# Tablemate

Tablemate is a working name, to be replaced before launch.

Tablemate is a mobile-first social network for travelers, with a web client of equal capability: two
people staying in the same city arrange an in-person meetup at a partner venue. Trust comes from
verified presence rather than identity disclosure — the device proves a real lodging booking with a
zero-knowledge proof of an electronic booking confirmation, the venue witnesses the meeting with its
rotating six-digit code, and both sides place a small refundable card hold (5, 10 or 20 USD) as a
commitment lock. The headline metric is meetup completion rate: meetups with both attendees checked
in divided by meetups with both deposits locked. This branch is a pilot over five launch cities —
Lisbon, Mexico City, Medellín, Chiang Mai and Canggu — built as container images and a local
`docker compose` stack.

## Workspace layout

A pnpm workspace: each entry below carries its own `package.json` and `tsconfig.json`, and shared
contracts live in one package so no route or payload shape is declared twice.

| Path                   | Package                    | Role                                                                                                                               |
| ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`          | `@tablemate/mobile`        | Expo SDK 52 app for iOS, Android and web; generates itinerary proofs on the device; operator dashboard at `/ops` (web only)        |
| `apps/api`             | `@tablemate/api`           | Fastify 5 REST and WebSocket API: proof verification, Stripe holds and webhooks, the settlement worker, the voice relay            |
| `apps/workers`         | `@tablemate/workers`       | BullMQ jobs: place and lodging refresh, menu ingestion, FX, call dispatch and results, data expiry, account erasure, notifications |
| `apps/venue-console`   | `@tablemate/venue-console` | Vite single-page app: the venue check-in code at `/venue` and lodging statistics at `/lodging`                                     |
| `packages/shared`      | `@tablemate/shared`        | Zod schemas for every route, frame and payload, plus error codes, enums, copy, tier field lists and UI tokens                      |
| `packages/db`          | `@tablemate/db`            | Prisma 6 schema, migrations (PostgreSQL 16 with PostGIS), spatial helpers, seed and fixture guard                                  |
| `packages/server-core` | `@tablemate/server-core`   | Scoped environment schemas, logger, clock, field encryption, `LlmAdapter` with spend metering, Twilio client, queues, city time    |
| `packages/circuits`    | `@tablemate/circuits`      | Circom 2.1 circuit and registry builder, the client-safe input generator, the trusted-setup and native-build scripts               |
| `config/`              | —                          | Launch cities and their bounding boxes, issuer records and generated registries, crawl blocklist, per-city seed fixtures           |
| `infra/`               | —                          | nginx templates for the web client, the venue console and the proving artefacts; the k6 load profile                               |
| `scripts/`             | —                          | Repository secret scan, end-to-end orchestration, line-count check                                                                 |
| `tests/system/`        | —                          | Cross-application suites: account deletion, phone fallback, lodging verification, caps and isolation, seed                         |
| `docs/`                | —                          | Architecture, API index, proofs and performance measurements, privacy, legal review, operations, acceptance evidence               |

## Prerequisites

- **Node.js 22.23.4** (`.nvmrc`; the root manifest pins it under `engines`) and **pnpm 12.16.1**
  activated through Corepack (`corepack enable`), which reads the root `packageManager` field.
- **Docker with Compose v2** for the local stack. The default services need no third-party
  credential.
- **For the circuit build:** Rust 1.99.1, Circom 2.1.9 (`cargo install --locked` from tag `v2.1.9`)
  and the `powersOfTau28_hez_final_22.ptau` Phase 1 file, which `setup.sh` downloads and the
  repository never commits.
- **For native builds:** Xcode 16.4 (macOS), Android SDK 35 with NDK 26.1.10909125 and JDK 17,
  EAS CLI 27.4.1 and Maestro 2.12.1.
- **For the test suite:** Docker is the only service dependency — Vitest starts its own
  PostgreSQL/PostGIS, Redis and `stripe-mock` containers. The OCR and page-fetch paths of the
  workers additionally need Tesseract 5 with the `tessdata_best` models for `eng`, `por`, `spa`,
  `tha` and `ind`, Poppler's `pdftoppm`, and Playwright's Chromium.

## Setup

1. `corepack enable && pnpm install` — exact pins, with `pnpm-lock.yaml` committed; never edit the
   lockfile by hand.
2. `cp .env.example .env` and replace every `<PLACEHOLDER>` with a generated value, e.g.
   `openssl rand -base64 32` for `FIELD_ENCRYPTION_KEY` (exactly 32 bytes, base64) and
   `openssl rand -hex 32` for `JWT_SECRET`, `EMAIL_LOOKUP_PEPPER`, `ANALYTICS_SALT` and
   `EXPERIMENT_SALT`. `NULLIFIER_SALT` is a decimal field element: use `1` for a stack that verifies
   the committed circuit fixtures. No third-party credential is required for the default stack.
3. `pnpm circuits:build` — compiles the circuit and runs the development trusted setup into the
   git-ignored `packages/circuits/build/`. The API mounts the verification key from that directory,
   so it must exist before the stack starts.
4. `docker compose up --build` — API at `http://localhost:3000/v1/health` (health returns the
   database and Redis checks), web client at `http://localhost:8080`, venue console at
   `http://localhost:8090`, proving artefacts at `http://localhost:8070`, Mailpit at
   `http://localhost:8025`.
5. Venue and lodging console secrets for the seeded fixtures are written to the git-ignored
   `.local/fixture-secrets.json`, which is how a demo opens either console.
6. Grant an operator account: `pnpm --filter @tablemate/api grant-operator <email>`.

## Commands

Run from the repository root. `pnpm lint` is the full static gate: ESLint, a Prettier check and the
secret scan over the working tree.

| Command                                                   | What it does                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                              | Generates the Prisma client, builds every workspace with `tsc -b`, and builds the venue console                                                                            |
| `pnpm typecheck`                                          | Type-checks every workspace, the Expo app and the venue console                                                                                                            |
| `pnpm lint`                                               | ESLint, `prettier --check` and the secret scan (`scripts/check-secrets.ts`)                                                                                                |
| `pnpm format` / `pnpm format:check`                       | Writes / checks Prettier formatting                                                                                                                                        |
| `pnpm test`                                               | Runs the `unit` and `integration` Vitest projects; integration uses real PostgreSQL/PostGIS and Redis, with `stripe-mock` behind the stateful proxy                        |
| `pnpm test:stripe`                                        | Reruns the integration project with `STRIPE_MODE=test` and the operator's `sk_test_` keys                                                                                  |
| `pnpm test:e2e`                                           | `scripts/e2e.ts`: starts the compose stack, runs the Playwright web suite and, where a device is attached, the Maestro flows; picks the Stripe mode from the keys it finds |
| `pnpm perf`                                               | Starts the stack and runs the k6 50 requests-per-second profile against a seeded database                                                                                  |
| `pnpm loc`                                                | Counts delivered lines against the per-area budgets; fails at 100,000 lines or more                                                                                        |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:deploy` | Generate the Prisma client / apply migrations in development / apply migrations for a deployment                                                                           |
| `pnpm db:seed`                                            | Loads the five cities, fixture venues, lodgings and places, and writes the console secrets to `.local/`                                                                    |
| `pnpm circuits:compile` / `pnpm circuits:setup`           | Compiles the circuit (with the constraint-size check) / runs the Phase 2 trusted setup                                                                                     |
| `pnpm circuits:build`                                     | `circuits:compile` then `circuits:setup`                                                                                                                                   |
| `pnpm circuits:registry`                                  | Rebuilds `config/registry/{production,test}.json` from `config/issuers/` and the city aliases                                                                              |
| `pnpm circuits:samples`                                   | Checks user-supplied issuer emails in `packages/circuits/samples/` and reports pass or fail per file                                                                       |
| `pnpm circuits:fixtures`                                  | Regenerates the DKIM-signed test emails from a key pair it discards afterwards                                                                                             |
| `pnpm circuits:native`                                    | Builds the native prover libraries for `tablemate-prover`                                                                                                                  |
| `pnpm circuits:smoke`                                     | The native integration smoke check: builds the benchmark app and proves on a device or simulator                                                                           |

Workspace-scoped commands the documents reference:

| Command                                               | What it does                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm --filter @tablemate/api bench:verify`           | Measures server proof-verification latency against the p95 target               |
| `pnpm --filter @tablemate/api grant-operator <email>` | Grants the operator role to an account                                          |
| `pnpm --filter @tablemate/workers eval:menus`         | Runs the menu-extraction evaluation over the labeled fixture set                |
| `pnpm --filter @tablemate/mobile export:web`          | Produces the web export served by the `web` compose service                     |
| `maestro test apps/mobile/e2e/maestro/zk-bench.yaml`  | Runs the on-device proving benchmark that also serves as the native smoke check |

## Run modes

The four posture variables below are read per process and validated at startup, so a process refuses
to start rather than run on a value it cannot honour. Their defaults need no external credential.

| Variable         | Values                                  | Default | Effect                                                                                                                                        |
| ---------------- | --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`        | `test`, `demo`, `staging`, `production` | `demo`  | Selects the posture; fixtures load only in `test` and `demo`, and the test-only switches are refused in every other mode                      |
| `STRIPE_MODE`    | `mock`, `test`, `live`                  | `mock`  | `mock` reaches `stripe-mock` through the stateful proxy and needs no key; `test` takes `sk_test_` keys; `live` is accepted only in production |
| `TELEPHONY_MODE` | `off`, `simulator`, `twilio`            | `off`   | `off` dials nothing and leaves every call task queued; `simulator` drives the scripted answerer; `twilio` places real calls                   |
| `LLM_PROVIDER`   | `fake`, `openai`                        | `fake`  | `fake` needs no credential, so the stack and the automated suite run no model                                                                 |

Rules that hold in every mode: the `workers` process receives no Stripe variable, only the API holds
a Stripe secret, calls outside production reach only numbers in `CALL_ALLOWLIST`, and Stripe runs in
test mode outside production. Confirming a card in the UI needs `STRIPE_MODE=test` with test-mode
keys and a matching publishable key in the web build.

Default compose services: `postgres`, `redis`, `mailpit`, `migrate`, `api`, `workers`, `web`,
`venue-console`, `artifacts`, `stripe-mock` and `stripe-proxy`. Published ports bind the loopback
interface and come from the per-clone `API_PORT`, `WEB_PORT`, `VENUE_CONSOLE_PORT`, `ARTIFACTS_PORT`,
`POSTGRES_PORT`, `REDIS_PORT`, `MAILPIT_SMTP_PORT` and `MAILPIT_HTTP_PORT` variables, so side-by-side
checkouts take separate blocks. Three profiles are never started by a plain `docker compose up`:

| Profile       | Service      | What it adds                                                                        |
| ------------- | ------------ | ----------------------------------------------------------------------------------- |
| `test`        | `voice-sim`  | The scripted telephony simulator, which plays Twilio's part for the automated suite |
| `stripe-test` | `stripe-cli` | Forwards test-mode Stripe webhooks to `POST /v1/webhooks/stripe`                    |
| `perf`        | `k6`         | The 50 requests-per-second load profile                                             |

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the process and workspace split, security and
  failure isolation, the idempotency rules behind money and background work, and the pinned version
  table (resolved 2026-11-04).
- [`docs/api/README.md`](docs/api/README.md) and
  [`docs/api/openapi.json`](docs/api/openapi.json) — API conventions, the route index with the
  routes this pilot adds, and the generated OpenAPI document.
- [`docs/zk-proofs.md`](docs/zk-proofs.md) and
  [`docs/zk-performance.md`](docs/zk-performance.md) — the circuit, the registry, issuer status and
  the trusted setup; the measured proving and verification times with their pass or fail.
- [`docs/privacy.md`](docs/privacy.md) — the data inventory: what is collected, encrypted, retained
  and erased.
- [`docs/legal-review.md`](docs/legal-review.md) — the items that must not reach production before
  counsel has reviewed them.
- [`docs/operations.md`](docs/operations.md) — the operator runbook for builds, the stacks, the
  queues and the limits.
- [`docs/platform-notes.md`](docs/platform-notes.md) — platform targets and every deviation from
  the capability list, each with the fallback the request permits.
- [`docs/acceptance.md`](docs/acceptance.md) — the result of every success criterion, constraint
  check and item awaiting input from outside the run.
- [`docs/performance.md`](docs/performance.md), [`docs/accessibility.md`](docs/accessibility.md),
  [`docs/menu-extraction.md`](docs/menu-extraction.md) and [`docs/voice-agent.md`](docs/voice-agent.md)
  — the measured results behind the API load targets, the WCAG 2.1 AA checks of the core flows, menu
  extraction accuracy, and the voice-agent scripts with their simulator and staging call results.

## Status

Pilot scope: five launch cities, container images and a local `docker compose` stack, and no
production infrastructure. Booking.com and Airbnb itinerary issuers await real sample confirmation
emails, so they are listed as unsupported until samples pass `pnpm circuits:samples`. App-store
submission is out of scope — this branch produces development and internal builds only — and the
Table Credit, forfeit and production-call mechanics stay blocked until the legal review in
`docs/legal-review.md` concludes.
