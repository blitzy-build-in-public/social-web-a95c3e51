# Operations

The operator runbook: the commands that build and run what the other documents describe, the inputs
each one takes, and the locks and limits that govern them.

## Circuit build and trusted setup (packages/circuits/scripts)

`packages/circuits/scripts/compile.sh` and `packages/circuits/scripts/setup.sh` produce the proving
artefacts the clients download and the `api` verifies proofs against. Both are invoked with `bash`,
both write only inside the git-ignored `packages/circuits/build/` and the `docs/zk-proofs.md` marker
blocks, and both print their contract when called with `--help`, or with an argument they do not take.

| Command                 | What it does                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm circuits:compile` | Runs `bash scripts/compile.sh`: compiles `circuits/tablemate_itinerary.circom` with circom 2.1.9 into the R1CS, the symbols and the wasm witness generator, then records the constraint count and the public-signal shape. Several minutes on a loaded host.                                          |
| `pnpm circuits:setup`   | Runs `bash scripts/setup.sh`: verifies the phase 1 file, fetches it if it is absent, then runs `snarkjs groth16 setup`, two contributions, one beacon, `zkey verify` and the verification-key export, and writes the manifest. It needs the compile's R1CS and wasm first, and takes tens of minutes. |
| `pnpm circuits:build`   | `pnpm circuits:compile && pnpm circuits:setup`, the whole pipeline in one command.                                                                                                                                                                                                                    |

The ceremony this runs is a development ceremony for this environment: one script makes both
contributions and the beacon is public. The multi-party production ceremony belongs to launch
preparation and is out of scope (AAP 0.7.2).

### Environment knobs

All of them are optional, and `bash scripts/<script>.sh --help` prints the same list.

| Knob                    | Read by    | Default                                                                     | Effect                                                                                                                                                                                                                                                         | Validated by                                                                                                                                 |
| ----------------------- | ---------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PTAU_PATH`             | `setup.sh` | `build/ptau/powersOfTau28_hez_final_22.ptau`                                | The phase 1 file. An existing file at that path is used as it stands and skips the download, which is the fast path for a fresh checkout.                                                                                                                      | `setup.sh`: the byte size first, then the BLAKE2b-512                                                                                        |
| `PTAU_URL`              | `setup.sh` | `https://circom.info/powersOfTau28_hez_final_22.ptau`                       | The URL the phase 1 file is downloaded from when it is absent.                                                                                                                                                                                                 | —                                                                                                                                            |
| `PTAU_MIRROR`           | `setup.sh` | `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_22.ptau` | The URL tried only once `PTAU_URL` has failed.                                                                                                                                                                                                                 | —                                                                                                                                            |
| `BEACON_HASH`           | `setup.sh` | 32 fresh random bytes                                                       | The beacon's entropy. A supplied value reproduces an earlier ceremony, a beacon being public by definition.                                                                                                                                                    | `setup.sh`: 64 hex characters, before any download or ceremony step                                                                          |
| `CIRCUITS_NODE_HEAP_MB` | both       | 8192 in `compile.sh`, 16384 in `setup.sh`                                   | Node's heap in MB for the R1CS parse and for the ceremony, which need well over node's default.                                                                                                                                                                | both scripts: a positive integer, rejected before the multi-minute compile in `compile.sh` and before the phase 1 verification in `setup.sh` |
| `TMPDIR`                | both       | `/tmp`                                                                      | Where the docs-block content temp file is created, and in `setup.sh` also the transcript and step-output files. Each script's `write_doc_block` creates its own temp next to the document instead, so the document's rename stays atomic whatever `TMPDIR` is. | —                                                                                                                                            |

### Fresh-checkout fast path

The phase 1 file `powersOfTau28_hez_final_22.ptau` is exactly 4,831,921,304 bytes and has BLAKE2b-512

```
0d64f63dba1a6f11139df765cb690da69d9b2f469a1ddd0de5e4aa628abb28f787f04c6a5fb84a235ec5ea7f41d0548746653ecab0559add658a83502d1cb21b
```

which `b2sum <file>` prints. Without a copy on the host, `setup.sh` downloads it from `PTAU_URL` and
falls back to `PTAU_MIRROR`; with the host's verified copy already present, pointing `PTAU_PATH` at it
skips the download entirely:

```bash
PTAU_PATH=/path/to/powersOfTau28_hez_final_22.ptau pnpm circuits:setup
```

Keep that copy outside the repository: `.gitignore` excludes `*.ptau`, and the same file is reused by
every later ceremony on the host.

A file supplied this way is checked the same way and is never deleted when it fails; a file the run
downloaded itself is removed, so the next run fetches it again.

### Outputs

| Path                                                                          | Written by   | Contents                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/circuits/build/tablemate_itinerary.r1cs`                            | `compile.sh` | The constraint system circom emits, and the input to the ceremony.                                                                                                                                                                                                                                   |
| `packages/circuits/build/tablemate_itinerary.sym`                             | `compile.sh` | The symbol file the circuit tests load with `recompile: false`.                                                                                                                                                                                                                                      |
| `packages/circuits/build/tablemate_itinerary.wasm`, `tablemate_itinerary_js/` | `compile.sh` | The wasm witness generator, as circom writes it and under the flattened name the manifest serves.                                                                                                                                                                                                    |
| `packages/circuits/build/tablemate_itinerary.zkey`                            | `setup.sh`   | The proving key.                                                                                                                                                                                                                                                                                     |
| `packages/circuits/build/verification_key.json`                               | `setup.sh`   | The key the `api` verifies proofs with.                                                                                                                                                                                                                                                              |
| `packages/circuits/build/artifacts.manifest.json`                             | `setup.sh`   | The name, size and SHA-256 of the wasm, the proving key and the verification key, parsed against `ArtifactsManifest` from `@tablemate/shared` before the run reports itself complete.                                                                                                                |
| `docs/zk-proofs.md`                                                           | both         | Two marker blocks: `circuits:compile`, holding the constraint count, the capacity and the public-signal shape, and `circuits:setup`, holding the ceremony transcript — the phase 1 file with its digest and its source, both contributions, the beacon, the verify result and the final key digests. |

`build/` is git-ignored (AAP 0.7.1), so the marker blocks in `docs/zk-proofs.md` are the tracked
record of which artefacts are in the tree.

### Constraint ceiling

`compile.sh` fails above 4,194,304 constraints (2^22), the capacity of the 2^22 phase 1 file, and it
does so before any ceremony step runs: the count comes from `snarkjs r1cs info` over the R1CS the
ceremony would consume. The `circuits:compile` block records the count and either `within limit` or
`exceeds limit` before the failure is reported.

### One run at a time

Both scripts write fixed intermediate names under `packages/circuits/build/`, so one run at a time
owns that directory. Each script takes an exclusive lock before its first write and holds it for the
whole run.

| Mechanism | Used when                                  | Lock                                            | Released                                                                                                                        |
| --------- | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `flock`   | The host has `flock`, as Linux does        | The directory `packages/circuits/build`         | By the kernel when the process ends, a killed one included. The directory stays in place, so the next run locks the same inode. |
| `mkdir`   | The host has no `flock`, as macOS does not | The directory `packages/circuits/build/.lock.d` | At the end of the run, on a failure and on `SIGINT` or `SIGTERM`. Remove it by hand only once no run is active.                 |

A run that finds the lock held reports it and exits at once instead of queueing behind the other run,
naming the lock path and, for the directory, the remedy.

The circuit itself, the registry and the issuer records are in `docs/zk-proofs.md`.

## 1. Local stack

1. Copy the environment template and fill the internal secrets. The four `openssl` commands the
   template names are the whole of it: `FIELD_ENCRYPTION_KEY` is standard base64 of 32 bytes;
   `JWT_SECRET`, `ANALYTICS_SALT`, `EMAIL_LOOKUP_PEPPER` and `EXPERIMENT_SALT` are 32 hex bytes. Set
   `NULLIFIER_SALT=1` in the local stack, which is the salt the committed circuit fixtures were built
   with; any other environment sets its own. The defaults `APP_ENV=demo`, `STRIPE_MODE=mock`,
   `TELEPHONY_MODE=off` and `LLM_PROVIDER=fake` reach no third party, so no provider credential is
   needed to start.

   ```bash
   cp .env.example .env
   ```

2. Build the proving artefacts once per checkout with `pnpm circuits:build` (above). The `api` and
   `artifacts` services bind-mount `packages/circuits/build`, with `create_host_path: false`, so a
   stack started before the build fails loudly rather than serving an empty directory.

3. Start every default service:

   ```bash
   docker compose up -d --wait
   ```

   | Service                       | Role                                                                                              |
   | ----------------------------- | ------------------------------------------------------------------------------------------------- |
   | `postgres`                    | PostgreSQL 16 with PostGIS 3.4, the single source of truth                                        |
   | `redis`                       | Redis 7, no eviction: rate-limit counters, WebSocket fan-out, BullMQ queues                       |
   | `mailpit`                     | SMTP capture on 1025 and its web UI/API on 8025                                                   |
   | `migrate`                     | One-shot `pnpm db:deploy && pnpm db:seed`; `api` and `workers` wait for it to succeed             |
   | `api`                         | REST and WebSocket, proof verification, Stripe holds, the in-process settlement worker            |
   | `workers`                     | Place and lodging refresh, menu ingestion, call dispatch, notifications, data expiry, erasure     |
   | `web`                         | The Expo web export on nginx, including `/ops`                                                    |
   | `venue-console`               | The venue and lodging console pages on nginx                                                      |
   | `artifacts`                   | The circuit wasm, proving key and manifest, served with the web origin as its only allowed origin |
   | `stripe-mock`, `stripe-proxy` | The credential-free payment path `STRIPE_MODE=mock` uses, reached by the API alone                |

4. Ports. Each host-side port is the variable of its own name, so checkouts running side by side take
   separate blocks, and every one of them binds the loopback interface alone. The compose project
   name is derived from the checkout directory's own name for the same reason, so side-by-side
   checkouts share no containers, networks or the `pgdata` volume; `COMPOSE_PROJECT_NAME` or
   `docker compose -p` overrides it.

   | Variable                                 | Default    | Service             |
   | ---------------------------------------- | ---------- | ------------------- |
   | `API_PORT`                               | 3000       | `api`               |
   | `WEB_PORT`                               | 8080       | `web`               |
   | `VENUE_CONSOLE_PORT`                     | 8090       | `venue-console`     |
   | `ARTIFACTS_PORT`                         | 8070       | `artifacts`         |
   | `MAILPIT_HTTP_PORT`, `MAILPIT_SMTP_PORT` | 8025, 1025 | `mailpit`           |
   | `POSTGRES_PORT`, `REDIS_PORT`            | 5432, 6379 | `postgres`, `redis` |

5. Health and logs. `curl -s http://localhost:3000/v1/health` answers
   `{"status":"ok","checks":{"database":"ok","redis":"ok"}}`; a degraded answer names the dependency
   that failed and nothing else, and the compose healthcheck reads the same route. Logs are pino JSON,
   one line per event with a request id on every API line; authorization headers, console secrets,
   credential-bearing environment keys, booking fields, coordinates, email addresses and message
   bodies are censored as `[redacted]` before they are written. A `pubsub_subscribe_failed` warning
   shortly after startup is the pub/sub subscription retrying against Redis, and it clears itself.

6. Profiles, which a plain `up` never starts.

   | Profile       | Start                                               | What it adds                                                                        |
   | ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
   | `stripe-test` | `docker compose --profile stripe-test up -d --wait` | The Stripe CLI, forwarding the seven test-mode events to `POST /v1/webhooks/stripe` |
   | `test`        | `docker compose --profile test up -d --wait`        | The scripted telephony simulator, for `TELEPHONY_MODE=simulator`                    |
   | `perf`        | `pnpm perf`                                         | Seeds the stack and runs the k6 load profile at 50 requests per second              |

   Confirming a card in the UI needs `STRIPE_MODE=test` with test-mode keys in `.env`, and the
   `stripe-test` profile alongside it; the credential-free default never confirms one.

## 2. Seeding and console secrets

1. `pnpm db:seed` loads `config/cities.json` and `config/fixtures/<cityId>.json`: the five launch
   cities, their partner venues, their lodgings and their priced places, plus the fixture hosts'
   crawl-domain decisions. The compose `migrate` service runs the same seed on every `up`, and a run
   is idempotent, so it updates the rows it made rather than adding more. It logs one `seed complete`
   line with the counts and the path of the console-secret file, and it logs no secret.

2. Fixtures load only while `APP_ENV` is `test` or `demo`. In `staging` and `production` the run
   refuses before its first write, and the fixture guard keeps `is_fixture` rows out of every read.
   `pnpm db:seed --no-fixtures` loads the configuration without them. Every fixture row is named
   "Fixture …", and every fixture phone number comes from the ranges reserved for fiction
   (`+120255501xx`, `+131255501xx`, `+141555501xx`), which only the test environment's `CALL_ALLOWLIST`
   admits.

3. Each seeded venue and lodging receives a random 32-byte console secret, written to the git-ignored
   `.local/fixture-secrets.json` (mode 0600) so a demo can open each console:

   ```json
   {
     "appEnv": "demo",
     "generatedAt": "2026-11-07T09:00:00.000Z",
     "venues": [
       { "id": "<uuid>", "cityId": "lisbon", "name": "Fixture …", "secret": "<venue-secret>" }
     ],
     "lodgings": []
   }
   ```

   No secret enters the repository. A reseed keeps a row's existing secret whenever the stored
   ciphertext still decrypts to the digest the row carries, so `docker compose up` never rotates a
   console out from under a running demo. Rotating one is the registry screen's job (section 6).

4. A console is opened at `http://localhost:8090/venue` or `http://localhost:8090/lodging`: the operator
   types the secret in once, the page keeps it in that tab's `sessionStorage`, and every request
   carries it as `X-Venue-Secret` or `X-Lodging-Secret`. The code screen renders the server's
   `{ code, expiresAt }` and asks again at `expiresAt`, and its countdown is measured against the
   server clock taken from the `Date` response header, so a device clock minutes off affects the
   countdown and never a validation. The pages themselves are described under
   [Partner console pages](#partner-console-pages).

## 3. Operator access

1. The person signs in once by magic link: `POST /auth/magic-link`, then the link it mails, which is
   single use and expires in 15 minutes. The first `POST /auth/verify` is what creates the account
   row. In the local stack Mailpit captures the mail at `http://localhost:8025`.

2. Then grant the role — the only way an account obtains it:

   ```bash
   pnpm --filter @tablemate/api grant-operator -- <email>                        # on the host
   docker compose exec api node apps/api/dist/scripts/grant-operator.js <email>  # in the container
   ```

   `--revoke` demotes the account to `traveler` instead. The address goes through the same lookup
   hash as sign-in, so spelling and casing variations reach one account, and the person must have
   signed in at least once. The command writes exactly one line of JSON,
   `{"userId":…,"role":…,"changed":…}`, and exits `1` on a refusal, naming neither the address nor a
   token. A change revokes every session of that account, so the operator signs in again to get an
   access token that carries the role. The runtime image ships no `tsx`, which is why the container
   form runs the compiled script with `node`. The host form reads the API's own environment from its
   shell, so source `.env` first; inside the container compose supplies it.

3. `/ops` exists on the web build alone: its layout redirects every non-web platform and every
   session that is not a signed-in operator to `/discover`, and every `/v1/admin/*` route answers
   `403 operator_only` without the role. Open `http://localhost:8080/ops`; its bar carries Dashboard,
   Queues, Registry and Back to app.

## 4. Dashboard (`/ops`)

The filters at the top are the date range (`From` and `To` as `YYYY-MM-DD`, applied to the meetups'
`startsAt`), a city row over `GET /cities` that starts at "All cities", and a variant-pairing row over
`social`, `punitive` and `mixed`.

The headline is the pilot's one measure: **completion rate = meetups with both attendees checked in ÷
meetups with both deposits locked** (`lockedAt`). Both terms come from the check-ins and `lockedAt`,
never from the meetup's status, so a later lost hold or an operator resolution moves neither. Meetups
still inside their check-in window stay in the denominator, and their number is shown beside the rate.
`PILOT_LOCK_RATE_THRESHOLD` and `PILOT_COMPLETION_THRESHOLD` draw reference lines on the two rate
bars, labelled as reference values the build reports against and never enforces.

| Panel                     | What it shows                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deposit funnel            | Proposals sent, viewed by the recipient, accepted, both holds locked, both checked in, and the accepted-to-locked rate                                                                                                                                                       |
| Counts                    | No-shows (late cancellations included), early cancellations, late cancellations, holds lost, disputes opened                                                                                                                                                                 |
| Active proofs per city    | Travelers with a proof valid now, by city                                                                                                                                                                                                                                    |
| Meetups per partner venue | The pilot's venue distribution                                                                                                                                                                                                                                               |
| Prices and suggestions    | Places with a fresh price per city, partner-venue neighbourhoods with at least 10 priced places, meetups with suggestions viewed, places opened                                                                                                                              |
| Calls                     | Outcomes (completed, refused, do not call, unreachable, needs review, no answer), the lifecycle panel (queued without an outcome, in progress, cancelled, blocked by reason), calls per day against the cap, language-model spend against the cap, and the suspension banner |
| Lodging claims            | Submitted, verified, rejected, unreachable, and the median time to resolve                                                                                                                                                                                                   |
| Signups (secondary)       | Accounts created, below the fold                                                                                                                                                                                                                                             |

## 5. Queues (`/ops/queues`)

One screen, five tabs: Disputes, Reports, Call tasks, Lodging claims, Crawl domains. Each resolution
is a POST to the matching `/v1/admin/*` route, and a refusal is `403 operator_only`, `404` for an id
that no longer exists, or `422 invalid_outcome` when the lifecycle does not allow the transition —
the row's own banner states which, and the queue is refreshed after every attempt.

### Disputes

A traveler may file until 24 hours after the start; later than that the route answers
`409 dispute_window_closed`, on a meetup that is still `proposed` it answers `409 not_locked`, and
with one already open `409 dispute_open`. The tab lists the open disputes nearest deadline first and,
behind them, the resolved ones newest first, each with the venue, the city, the kind
(`venue_unavailable` or `other`), the filer's reason, the filing and deadline instants and every
participant's handle and check-in result — the check-ins are what a `settle_by_checkins` resolution
decides on. The deadline is `openedAt + 5 days`, and a dispute past it counts in the overdue banner;
the escalation job fires 24 hours before it.

| Outcome              | On a `locked` meetup                                                                                                                                                        | On a `forfeited` meetup                                                                     | On a `completed` or `unattended` meetup |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| `settle_by_checkins` | Closes the dispute; settles at once once `startsAt + 45 min` has passed, and before that leaves the meetup `locked` with check-in open, so the outcome waits for the window | Closes it and changes nothing: the forfeit already happened                                 | Closes it and changes nothing           |
| `no_fault`           | Releases both holds and changes no reputation — the resolution for a venue that could not witness                                                                           | Reverses the absent party's capture, voids the Table Credit grant, then releases both holds | `422 invalid_outcome`                   |

Two resolutions happen without an operator: a hold that expires while a dispute is open moves the
meetup to `lock_lost` and resolves the dispute with the note `hold_expired`, and a block resolves it
`no_fault` with `cancelled_by_block`. An operator resolution is durable even when the provider cannot
be reached — the money plan is written in the same transaction and the sweeper resumes it — and it is
what releases an account deletion that was waiting on the dispute.

### Reports

Newest first, up to 200 in one read, with no cursor: an older report is read from the database by
hand. Both handles are null once that account has been erased, the reason is null once the 180-day
purge has emptied it, and the meetup is absent when the report concerns none. The tab is read-only —
a report is written once by the safety route that files it and never changes.

### Call tasks

The tab lists every `needs_review` and `unreachable` task no operator has resolved yet, with its
target, city, attempts, the latest outcome and the fields its latest attempt extracted. It reads 100
tasks at a time: the line above the rows says how many of the tasks the current filters match and how
many of them are on screen, and `Load more call tasks` appends the next page until the queue runs out.
A search over the target's name, a status filter (All, Needs review, Unreachable) and a kind filter
(All, Menu prices, Stay verification) narrow the queue, and changing any of the three starts again
from the first page.

| `blockedReason`      | Meaning                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_allowlisted`    | The number is outside `CALL_ALLOWLIST` in a non-production environment                                                                                                            |
| `no_phone`           | The target has no callable number                                                                                                                                                 |
| `do_not_call`        | The number asked not to be called; every task of that target is stopped                                                                                                           |
| `invalid_number`     | The number is not valid: the task goes straight to `unreachable` with this reason                                                                                                 |
| `vendor_unavailable` | Eight definite vendor refusals before a call was created                                                                                                                          |
| `dispatch_unknown`   | The dispatch's outcome is unknown; any listing the provider returns is a candidate for the operator to judge, never evidence, and the slot stays consumed — do not redial blindly |
| `no_final_status`    | No final call status arrived and the provider's own fetch by the adopted call id failed                                                                                           |

Resolution applies to a `menu_prices` task only, and only while it is `needs_review` or `unreachable`;
a `lodging_stay_verification` task answers `422 invalid_outcome` for every outcome and is resolved
through its claim below. `Record prices from the call` (outcome `completed`) stores the prices the
operator was told as an `operator_entry` batch — each row needs the item name, category, the price
quoted verbatim, a currency and the amount in minor units, and a ticket also needs whether it admits
one person and its ticket type. `Refused` closes the task, `Do not call` also flags the place and
cancels its other tasks, and `Unreachable` records that no prices were obtainable. A task in any other
status, or one an operator already resolved, answers `422`. A price a call quoted with low confidence
stays in this queue and is excluded from suggestions until it is approved or re-entered here.

### Lodging claims

Claims whose call ended without a clear yes or no arrive here — as do claims for a lodging with no
phone or a `doNotCall` one — while the traveler still sees `pending_call`. The row shows the lodging,
its phone, the stay dates, when the claim was opened and when it expires; the claim resolves
`verified`, `rejected` or `unreachable` only while it is `pending_call` or `calling`, and an
unresolved claim becomes `unreachable` 72 hours after creation without penalty.

For a manual verification call, open the booking details from the row. The details are readable only
while the claim is open and before they are erased, every read is written to the operator access log
with the purpose `manual_verification_call`, and the name and reference are wiped by the hourly expiry
run within 24 hours of the claim becoming terminal. Read them for the call and do not copy them
anywhere else; a claim that is already terminal answers `409 details_unavailable`.

### Crawl domains

A menu domain the crawler meets for the first time is recorded `uncertain` / `awaiting_review` before
its first fetch and is never fetched while it stays there. Read the site's terms, then record
`allowed` or `prohibited` — `prohibited` and `uncertain` domains leave their places to the phone
fallback. A domain on `config/crawl-blocklist.json` stays `prohibited` whatever is recorded against
it: the blocklist outranks this queue. A decision is never rechecked automatically, so it stands until
an operator writes another.

## 6. Registry (`/ops/registry`)

1. **Venues.** Create one with its city, name, address, coordinates and active-partner flag, edit
   those fields later, and issue its console secret from the row. The secret is shown once and never
   again; issuing a new one replaces the current one, and the console that held the old one stops
   authenticating at once — hand the new value to the venue over a channel you trust. Adding a venue,
   moving it or activating it enqueues that city's place refresh, which is what puts its neighbourhood
   into the price pipeline.

2. **Lodgings.** A lodging entered here carries no OpenStreetMap identity, and its phone source is
   recorded as `operator`. The weekly refresh never replaces an operator phone, a `doNotCall` flag,
   a console secret, a fixture or a manually entered row. Issuing a console secret makes the lodging
   a partner lodging for price ingestion, and enqueues the same refresh.

3. **Price jobs.** Per city, `Run menu ingestion` (`menus`) fans out the menu pipeline and
   `Run price calls` (`calls`) queues the phone work; both answer `202` with a job id, which the row
   shows as `Queued (job …)`. `429 daily_cap_reached` means the city's local day has used up the cap
   the kind is counted against — `CAP_CALLS_PER_CITY_DAY` for calls, `CAP_LLM_USD_PER_CITY_DAY` of
   committed language-model spend for menus. The route's check is an early refusal for the operator;
   the enforcement point is the reservation each dispatch makes, and work over a cap runs from 09:00
   local the next day. With `TELEPHONY_MODE=off` a `calls` job waits in its queue until the mode
   changes.

## 7. Configuration changes

| Change              | Procedure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cities and fixtures | Edit `config/cities.json` or `config/fixtures/<cityId>.json`, then `pnpm db:seed`. A city whose aliases changed also needs `pnpm circuits:registry`; fixtures remain `test`- and `demo`-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Issuers             | Put real confirmation emails in the git-ignored `packages/circuits/samples/<issuer>/`, fill the key records with `pnpm --filter @tablemate/circuits fetch-dkim-key -- <issuer> --write`, author the template from the same samples, then `pnpm circuits:samples`. Only when that check passes, set `verificationStatus` to `verified` in `config/issuers/<issuer>.json`, run `pnpm circuits:registry`, and restart the API. The circuit itself, the registry and the current issuer statuses are in [./zk-proofs.md](./zk-proofs.md); Booking.com and Airbnb stay `awaiting_samples` until samples exist, and no proof can name an issuer without a registry leaf. |
| Caps and calling    | `CAP_CALLS_PER_CITY_DAY`, `CAP_CALL_SECONDS`, `CAP_LLM_USD_PER_CITY_DAY` and `LLM_MAX_TURNS_PER_CALL` are read by `api` and `workers` at startup, so restart both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Experiment split    | `EXPERIMENT_SOCIAL_SHARE` (0.5 by default; `1.0` is all-social). It decides the variant of accounts created _after_ the change: an existing assignment is never recomputed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Telephony           | `TELEPHONY_MODE` is `off`, `simulator` or `twilio`. Outside production only numbers in `CALL_ALLOWLIST` are dialled; production calls additionally need `CALLS_PRODUCTION_APPROVED=true`, which legal review governs.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Language model      | `LLM_PROVIDER` is `fake` or `openai`; `openai` needs `LLM_API_KEY`, `LLM_MODEL` and both prices, and `LLM_MODEL` must be one of the models the adapter meters — any other value makes the process refuse to start.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Language-model suspension.** A provider-reported input-token count that differs from the count the
request was reserved for is charged in full, logged as `llm_count_mismatch`, and suspends
language-model use in every city: menu jobs defer, and a call that cannot reserve its next turn ends
politely. The dashboard's Calls panel shows the banner and the mismatch count. The flag is the Redis
key `llm:suspended`, which `api` and `workers` share and which holds `{"since","reason"}`, and
`llm:count_mismatches` counts the mismatches; the implemented re-enable step removes that key. **No
admin route and no script calls it today**, so there is no supported operator surface for clearing the
suspension — recorded here as a gap for `apps/api` and `packages/server-core`, whose owner must add
one. Until then, do not clear the flag from a shell without first establishing why the count changed:
the suspension is what stops spend the cap can no longer bound.

## 8. Delivery status

Notifications reach a traveler over Expo push on a native device, and over email on the web and for
every magic link. Push is switched off by configuration, not by a flag: with no `EXPO_ACCESS_TOKEN`
the process sends none, and web users still get email. Email goes through `SMTP_URL` with
`EMAIL_FROM`, plain text only; the local stack captures it in Mailpit at `http://localhost:8025`.

**Delivery verified with Mailpit only** — no dated result exists for real push or SMTP delivery yet,
because neither credential has been supplied. Replace this line with the dated results once they are.

## Partner console pages

`apps/venue-console` serves the two pages the plan names for it, each behind the operator-issued
secret the API checks (AAP 0.3.2, 0.5.4): `/venue` shows the venue's rotating check-in code with
its QR form, and `/lodging` shows one lodging's leaderboard standing. Beyond those two, it serves
a landing index at `/` that links both consoles, and any other path renders that same index with a
"Page not found" line above the links. The landing index is a deliberate addition to the two
screens the AAP names for this workspace, not a route the API serves. It renders no route data and
makes no request: the `venue-console` image is nginx, which answers `index.html` for every path
(AAP 0.6.2), so the page decides what to render from the path alone.
