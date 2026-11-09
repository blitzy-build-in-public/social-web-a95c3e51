# API performance

The API's latency targets and the load profile that measures them. `infra/k6/api-load.js` drives the
whole docker-compose stack at 50 requests per second and reports reads, writes with the card
provider's time excluded, the failure rate and the achieved rate (AAP 0.1.1, 0.12.2). The figures
under Results come from the run's `.local/perf/summary.json` and the report the profile prints when
it finishes, and no measure is `pass` without a run.

## Targets

| Target                       | Threshold                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Reads p95                    | ≤ 300 ms — `read_latency{phase:measure}` `p(95)<=300`                                        |
| Writes p95 (Stripe excluded) | ≤ 800 ms — `write_latency_excl_stripe{phase:measure}` `p(95)<=800`                           |
| Failure rate                 | below 1% — `http_req_failed{phase:measure}` `rate<0.01`                                      |
| Request rate                 | 50/s sustained in both scenarios with no dropped iteration — `dropped_iterations` `count==0` |

A `409` is an expected answer under load (`already_checked_in`, `meetup_exists`): the profile accepts
2xx and 409 and counts a conflict per endpoint rather than as a failure. k6 exits non-zero on a
breached threshold, on any dropped iteration, and on a failure rate at or above 1%.

## Method

### Command

```bash
pnpm perf   # export RATE_LIMIT_IP_PER_MIN=1000000 && docker compose up -d --wait
            #   && docker compose exec -T api printenv RATE_LIMIT_IP_PER_MIN | grep -qx 1000000
            #   && docker compose run --rm migrate pnpm --filter @tablemate/api perf:seed
            #   && docker compose --profile perf run --rm k6
```

The sequence builds and starts the default stack and waits for its health checks, seeds through the
`migrate` service whose environment block the API's own configuration validates, then runs
`grafana/k6:2.3.0` as the profile `perf` service against `API_URL=http://api:3000`, with `infra/k6`
mounted at `/scripts` and `.local/perf` at `/results`. Between the start and the seed, the chain's guard
— `docker compose exec -T api printenv RATE_LIMIT_IP_PER_MIN | grep -qx 1000000` — aborts the run when
the `api` container's own `RATE_LIMIT_IP_PER_MIN` is not 1000000, so a stack that never took the raised
ceiling stops the run instead of yielding a measurement the ceiling invalidates. The ceiling is exported
for the whole chain rather than prefixed onto the first command, because every `docker compose`
invocation interpolates `RATE_LIMIT_IP_PER_MIN` from `docker-compose.yml`'s anchor for itself and the k6
stage reconciles the `api` service it depends on: a ceiling set for the first command alone is resolved
back to the documented 600 there, and the run then measures a stack whose per-IP counter refuses the
load generator. `RATE_LIMIT_IP_PER_MIN=1000000` covers the single load-generator IP, while the per-user
limit (60 mutating requests a minute) is unchanged because 1,000 accounts share it. The seed is written
under `.local/perf/`, mode 0600 since it carries bearer tokens, and the summary beside it, which is why
the k6 service runs as root. `perf-seed` also takes `--api-url <url>` and `--out <path>` for a run
outside the compose network. The API image
mounts the circuit's verification key, so `pnpm circuits:build` and `.env` must exist before the
stack comes up.

### Connection budget

Every client the profile touches is bounded rather than left to Prisma's own default of
`2 x CPU cores + 1`, which on a 112-core host is 225 connections from one process — more than a
default 100-connection server accepts in full. `connection_limit=20&pool_timeout=10` rides on the
compose `DATABASE_URL`, so each client holds at most 20: `api`, with its in-process settlement
worker, 20, `workers` 20, and the `migrate` service, through which `perf-seed` runs, 20. A running
stack therefore holds 60, or 80 with a second API replica (AAP 0.1.1), inside the `postgres`
service's own `-c max_connections=200`, which leaves the rest of the ceiling to operator sessions.
The profile's own peak sits far inside that: a virtual user holds a connection for the length of one
request, so the 50 requests per second it drives keep concurrency in the low tens, and a burst past
the bound waits `pool_timeout` seconds for a free connection instead of taking another server slot.

### Load

- Two `constant-arrival-rate` scenarios at 50 requests per second: `warmup` for 60 s, then `measure`
  for 300 s started at 60 s. Each pre-allocates 50 VUs and may grow to 200.
- One iteration issues exactly one counted request, so the iteration rate is the request rate. The
  warm-up opens connections and warms Prisma and the caches while reaching no Trend: only the
  measured five minutes enter the thresholds.

### Data

`perf-seed` writes 1,000 accounts (`perf_0001` … `perf_1000`), each with one access token and a valid
test-issuer proof, 200 meetups over distinct pairs — 60 `proposed`, 80 `locked`, 60 `completed`, 40
per city — and 20 messages per locked or completed pair. The locked meetups start ten minutes out, so
their check-in windows cover the whole run, and the completed ones settled an hour before, inside the
suggestion route's 24-hour eligibility.

- The seed file also holds the five cities' partner venues with their coordinates, their lodgings and
  the venue secrets the seed itself wrote, so a check-in code can be fetched at run time; no code is
  written down, because it rotates every 60 seconds.
- A rerun deletes the rows a previous run left (its `perf_` handles and deterministic nullifiers) and
  writes the same counts, so seeding is idempotent. `APP_ENV` must be `test` or `demo`.
- In `STRIPE_MODE=mock` every account gets a customer with a saved card at the stripe-proxy, so a
  proposal reaches a real hold; in `STRIPE_MODE=test` no provider object is created and a proposal
  answers `402 hold_failed`. Tokens live 15 minutes, which is why the seed runs immediately before
  the load test, and the API's sweeper settles the locked meetups 55 minutes after seeding, so
  restoring them is a rerun of `perf-seed` rather than of k6.

### Mix

80% reads and 20% writes, out of 100, in a weighted round robin over a 100-slot block that hits every
weight exactly and interleaves the two kinds. Reads: `discovery` 12 `GET /v1/cities/:cityId/travelers`,
`profile` 12 `GET /v1/users/:userId`, `me` 12 `GET /v1/me`, `meetup_detail` 10 `GET /v1/meetups/:id`,
`messages` 10 `GET /v1/meetups/:id/messages`, `venues` 8 `GET /v1/cities/:cityId/venues`,
`suggestions` 8 `GET /v1/meetups/:id/suggestions`, `lodgings` 8
`GET /v1/cities/:cityId/lodgings?sort=activity`. Writes, 4 each: `profile_update`
`PUT /v1/me/profile`, `propose` `POST /v1/meetups`, `check_in` `POST /v1/meetups/:id/check-in`,
`report` `POST /v1/users/:id/report`, and `budget_change`, the suggestion route's state-writing read
`GET /v1/meetups/:id/suggestions?perPersonBudgetCents=`.

Each write has the API's own `Server-Timing: stripe;dur=` value subtracted from its latency, so the
card provider's round trip is not charged to the API; a write that called Stripe not at all carries
`dur=0`, and an absent or unparsable entry counts as none. Each check-in first fetches the venue's
live code from `GET /v1/venue/check-in-code` with the venue secret; that request is tagged
`phase: aux`, so it reaches neither latency Trend nor any `phase: measure` threshold, and a VU reuses
a code until the step it belongs to ends.

### Output

`.local/perf/summary.json`, the k6 service's `/results/summary.json`: the export k6's own
`--summary-export` writes, a `metrics` map with `root_group` beside it. Every figure to paste is in
`metrics` — `read_latency{phase:measure}` and `write_latency_excl_stripe{phase:measure}` with `med`,
`p(95)`, `max` and `count`; the `value` of `http_req_failed{phase:measure}`; the `count` of
`dropped_iterations`; and `ep_<endpoint>_reqs`, `ep_<endpoint>_409` and `ep_<endpoint>_fail` for each
endpoint. The export also carries a boolean per threshold under each metric's `thresholds`, and in this
k6 version that boolean means the threshold was breached — a held threshold is exported `false` and a
breached one `true` — so the verdicts are the profile's own printed PASS or FAIL lines and its
`tablemate` block (both computed by `handleSummary`), never those booleans.

The profile's `handleSummary` also assembles a `tablemate` block — those figures with `runStart`,
`runEnd`, `targetRate`, `warmupSeconds`, `measureSeconds`, each threshold's verdict and the totals —
and prints one PASS or FAIL line per target with the run's volume and mix; that block is what the file
holds when the profile is run without an export for its path. Under `pnpm perf` the service's
`--summary-export` names the same path, so the block reaches the console and the export is what the
file keeps. The seed data is dropped before the report is built, so neither the file nor the output
holds a token or a secret.

## Results

### Run metadata

| Date       | Commit    | Host CPU (model, cores)                                                                      | Host memory                 | Docker resources                                                                                                                                            | Stack mode                         | Result |
| ---------- | --------- | -------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------ |
| 2026-11-09 | `e08b045` | `INTEL(R) XEON(R) PLATINUM 8581C CPU @ 2.10GHz, 112 CPUs` (2 sockets × 28 cores × 2 threads) | 3,071,657,416 kB (2.86 TiB) | No limits set — `Memory=0`, `NanoCpus=0` and `CpuShares=0` on every service (Docker Engine 29.9.3, Compose v5.7.0), so these are unconstrained-host figures | `APP_ENV=demo`, `STRIPE_MODE=mock` | pass   |

### Measured

| Measure                   | p50 (ms) | p95 (ms) | max (ms) | Target                               | Result                                                          |
| ------------------------- | -------- | -------- | -------- | ------------------------------------ | --------------------------------------------------------------- |
| Reads                     | 4.2      | 19.9     | 79.1     | p95 ≤ 300 ms                         | pass                                                            |
| Writes (excluding Stripe) | 8.9      | 53.7     | 1275.0   | p95 ≤ 800 ms                         | pass                                                            |
| Failure rate              | —        | —        | —        | below 1%                             | pass — 0.00%, 0 failed of 15,001 measured requests              |
| Achieved rate             | —        | —        | —        | 50/s sustained, no dropped iteration | pass — 15,001 requests over 300 s at 50/s, 0 dropped iterations |

Reads and writes are the `med`, `p(95)` and `max` of `read_latency{phase:measure}` and
`write_latency_excl_stripe{phase:measure}`, rounded to one decimal as the profile printed them; the
failure rate is the `value` of `http_req_failed{phase:measure}` over the measured phase, and the
achieved rate is the 15,001 measured requests the report counted over the 300 measured seconds with no
dropped iteration. The host CPU, host memory and Docker limits are recorded with the run (AAP 0.12.2).

### Per endpoint

| Endpoint       | Requests | p95 (ms) | 409s | Failures |
| -------------- | -------- | -------- | ---- | -------- |
| discovery      | 1801     | —        | 0    | 0        |
| venues         | 1200     | —        | 0    | 0        |
| profile        | 1800     | —        | 0    | 0        |
| meetup_detail  | 1500     | —        | 0    | 0        |
| messages       | 1500     | —        | 0    | 0        |
| suggestions    | 1200     | —        | 0    | 0        |
| lodgings       | 1200     | —        | 0    | 0        |
| me             | 1800     | —        | 0    | 0        |
| profile_update | 600      | —        | 0    | 0        |
| propose        | 600      | —        | 0    | 0        |
| check_in       | 600      | —        | 560  | 0        |
| report         | 600      | —        | 0    | 0        |
| budget_change  | 600      | —        | 0    | 0        |

Requests, 409s and failures are the `ep_<endpoint>_reqs`, `ep_<endpoint>_409` and `ep_<endpoint>_fail`
counters in the file's `metrics`; the run left no `ep_<endpoint>_fail` counter at all, which is why
every Failures cell reads 0. No per-endpoint latency reaches the file — the profile's thresholds name
the two phase aggregates — so this column stays `—`. The auxiliary code fetch carries its own `aux_code`
name and reaches no counter here.

### Previous runs

Three earlier runs of the same command — 2026-11-09, the first three on HEAD `33bb261` with this
checkpoint's working-tree change — passed too: reads p95 19.8 ms, 19.6 ms and 18.9 ms; writes
excluding Stripe p95 56.0 ms, 53.7 ms and 43.3 ms; a 0.00 % failure rate and 0 dropped iteration in
each, over the same 15,001 measured requests at 50/s (reads 12,001 / writes 3,000). Each later run
overwrote the previous `.local/perf/summary.json`, so only those console figures survive: the
earlier runs' p50, max and per-endpoint counters were not retained. The latest run stays above; an
older one moves here with its date, commit and figures.

## How to update

1. Run `pnpm perf` against the compose stack.
2. Read the file's `metrics` for the four aggregates and the `ep_*` counters, and the printed report
   for the volume and mix, then fill the tables above with the run's date, the commit
   (`git rev-parse --short HEAD`), the host CPU and memory and the Docker resource limits.
3. Write `pass` only where the run met its threshold, `fail` where it did not, and `pending` where no
   run has covered it. Move the superseded run down to "Previous runs".
