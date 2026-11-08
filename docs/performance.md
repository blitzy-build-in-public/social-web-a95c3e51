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
pnpm perf   # RATE_LIMIT_IP_PER_MIN=1000000 docker compose up -d --wait
            #   && docker compose run --rm migrate pnpm --filter @tablemate/api perf:seed
            #   && docker compose --profile perf run --rm k6
```

The sequence builds and starts the default stack and waits for its health checks, seeds through the
`migrate` service whose environment block the API's own configuration validates, then runs
`grafana/k6:2.3.0` as the profile `perf` service against `API_URL=http://api:3000`, with `infra/k6`
mounted at `/scripts` and `.local/perf` at `/results`. `RATE_LIMIT_IP_PER_MIN=1000000` covers the
single load-generator IP, while the per-user limit (60 mutating requests a minute) is unchanged
because 1,000 accounts share it. The seed is written under `.local/perf/`, mode 0600 since it carries
bearer tokens, and the summary beside it, which is why the k6 service runs as root. `perf-seed` also
takes `--api-url <url>` and `--out <path>` for a run outside the compose network. The API image
mounts the circuit's verification key, so `pnpm circuits:build` and `.env` must exist before the
stack comes up.

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
`p(95)`, `max` and `count`; the `rate` of `http_req_failed{phase:measure}`; the `count` of
`dropped_iterations`; and `ep_<endpoint>_reqs`, `ep_<endpoint>_409` and `ep_<endpoint>_fail` for each
endpoint.

The profile's `handleSummary` also assembles a `tablemate` block — those figures with `runStart`,
`runEnd`, `targetRate`, `warmupSeconds`, `measureSeconds`, each threshold's verdict and the totals —
and prints one PASS or FAIL line per target with the run's volume and mix; that block is what the file
holds when the profile is run without an export for its path. Under `pnpm perf` the service's
`--summary-export` names the same path, so the block reaches the console and the export is what the
file keeps. The seed data is dropped before the report is built, so neither the file nor the output
holds a token or a secret.

## Results

### Run metadata

| Date    | Commit | Host CPU (model, cores) | Host memory | Docker resources | Stack mode                         | Result                            |
| ------- | ------ | ----------------------- | ----------- | ---------------- | ---------------------------------- | --------------------------------- |
| pending | —      | —                       | —           | —                | `APP_ENV=demo`, `STRIPE_MODE=mock` | Pending — `pnpm perf` not yet run |

### Measured

| Measure                   | p50 (ms) | p95 (ms) | max (ms) | Target                               | Result  |
| ------------------------- | -------- | -------- | -------- | ------------------------------------ | ------- |
| Reads                     | —        | —        | —        | p95 ≤ 300 ms                         | pending |
| Writes (excluding Stripe) | —        | —        | —        | p95 ≤ 800 ms                         | pending |
| Failure rate              | —        | —        | —        | below 1%                             | pending |
| Achieved rate             | —        | —        | —        | 50/s sustained, no dropped iteration | pending |

Pending — `pnpm perf` not yet run. p50, p95 and max are the `med`, `p(95)` and `max` of
`read_latency{phase:measure}` and `write_latency_excl_stripe{phase:measure}`; the failure rate is the
`rate` of `http_req_failed{phase:measure}`, and the achieved rate is the requests the report prints
over the 300 measured seconds. The host CPU, host memory and Docker limits are recorded with the run
(AAP 0.12.2).

### Per endpoint

| Endpoint | Requests | p95 (ms) | 409s | Failures |
| -------- | -------- | -------- | ---- | -------- |
| pending  | —        | —        | —    | —        |

Requests, 409s and failures are the `ep_<endpoint>_reqs`, `ep_<endpoint>_409` and `ep_<endpoint>_fail`
counters in the file's `metrics`. No per-endpoint latency reaches the file — the profile's thresholds
name the two phase aggregates — so this column stays `—`. The auxiliary code fetch carries its own
`aux_code` name and reaches no counter here.

### Previous runs

None yet. The latest run stays above; an older one moves here with its date, commit and figures.

## How to update

1. Run `pnpm perf` against the compose stack.
2. Read the file's `metrics` for the four aggregates and the `ep_*` counters, and the printed report
   for the volume and mix, then fill the tables above with the run's date, the commit
   (`git rev-parse --short HEAD`), the host CPU and memory and the Docker resource limits.
3. Write `pass` only where the run met its threshold, `fail` where it did not, and `pending` where no
   run has covered it. Move the superseded run down to "Previous runs".
