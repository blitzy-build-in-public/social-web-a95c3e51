/**
 * `infra/k6/api-load.js` — the API's 50 requests-per-second load profile (AAP 0.8.1, 0.12.2).
 *
 * ```sh
 * pnpm perf   # seeds the compose stack, then runs this profile in its `perf` k6 service
 * ```
 *
 * It measures the targets of AAP 0.1.1 on the full docker-compose stack: p95 ≤ 300 ms for reads and
 * p95 ≤ 800 ms for writes with Stripe time excluded, at 50 requests per second. One iteration issues
 * exactly one measured request, so the iteration rate is the request rate; the first minute only
 * opens connections and warms Prisma and the caches, and reaches no Trend.
 *
 * The seed `pnpm perf` writes (`.local/perf/seed.json`, mounted at `/results` as `SEED_FILE`) holds
 * 1,000 accounts with tokens, 200 meetups over distinct pairs and the console secrets of the locked
 * meetups' venues. This file writes `/results/summary.json` (`SUMMARY_FILE`) and prints one line per
 * target with its measured value and PASS or FAIL. A breach, a dropped iteration or a failure rate
 * at 1% or above gives k6 a non-zero exit.
 *
 * Three deliberate choices about what is measured: a write's latency has the API's own
 * `Server-Timing: stripe;dur=` value subtracted (AAP 0.12.2), so the card provider's round trip is
 * not charged to the API; a `409` is an expected answer under load (`already_checked_in`,
 * `meetup_exists`) and is counted on its own rather than as a failure; and the auxiliary
 * `GET /venue/check-in-code` fetch carries `phase: aux`, so it can enter neither latency Trend nor
 * any `phase: measure` threshold.
 *
 * The figures below mirror `packages/shared/src/constants.ts` and the shared route schemas; this
 * script cannot import TypeScript, so they are restated once, here.
 */
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

// The arrival rate, both scenarios, and the seed life they must fit inside.
const TARGET_RATE = 50;
const MEASURE = 'measure';
const WARMUP_SECONDS = 60;
const MEASURE_SECONDS = 300;
const RUNNING_MS = (WARMUP_SECONDS + MEASURE_SECONDS + 60) * 1000;
// The schedule's block, the slots the proposal and check-in streams each hold in a block, and the
// caller rotation's stride. Both streams weigh 4, so one block asks for four proposals and four
// check-ins.
const BLOCK = 100;
const STREAM_SLOTS = 4;
const CALLER_STRIDE = 7;
// The accounts each city spends on seeded meetups: its first 80, which is 40 meetups over 200.
const SEEDED_PAIR_ACCOUNTS = 80;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_LOGGED_FAILURES = 20;
const SEED_FILE = __ENV.SEED_FILE || '/results/seed.json';
const SUMMARY_FILE = __ENV.SUMMARY_FILE || '/results/summary.json';

/*
 * The seed, the API origin and the lookups every VU shares
 */

let seed = {};
try {
  seed = JSON.parse(open(SEED_FILE));
} catch (error) {
  exec.test.abort(`cannot read ${SEED_FILE} (${error}); \`pnpm perf\` seeds before it loads.`);
}

const origin = `${__ENV.API_URL || seed.apiUrl || ''}`.replace(/\/+$/, '');
if (origin === '') {
  exec.test.abort("neither API_URL nor the seed's apiUrl names the API; run `pnpm perf`.");
}
const BASE = `${origin}/v1`;

const rows = (value) => (Array.isArray(value) ? value : []);
const at = (list, index) => list[index % list.length];
const pairKey = (first, second) => (first < second ? `${first}|${second}` : `${second}|${first}`);
const auth = (caller) => ({ authorization: `Bearer ${caller.accessToken}` });
// `name` replaces k6's URL-valued tag, so a path carrying an id never grows the tag cardinality.
const tagsFor = (name, kind) => ({ kind, endpoint: name, name });
const params = (caller, name, kind) => ({ headers: auth(caller), tags: tagsFor(name, kind) });
const jsonParams = (caller, name, kind) => ({
  headers: { ...auth(caller), 'content-type': 'application/json' },
  tags: tagsFor(name, kind),
});

function groupBy(list, key) {
  const grouped = new Map();
  for (const item of list) {
    const bucket = grouped.get(key(item)) || [];
    bucket.push(item);
    grouped.set(key(item), bucket);
  }
  return grouped;
}

// The caller of a plain request; the stride is coprime with the 1,000 accounts, so consecutive
// iterations land on different accounts and no user approaches the 60-per-minute mutating limit.
const callerFor = (index) => at(USERS, index * CALLER_STRIDE);

/** One meetup of a pool and one of its participants, the side alternating on each pass over it. */
function meetupFor(index, pool) {
  const meetup = at(pool, index);
  const id = Math.floor(index / pool.length) % 2 === 0 ? meetup.initiatorId : meetup.recipientId;
  return { meetup, caller: USER_BY_ID.get(id) || callerFor(index) };
}

const USERS = rows(seed.users);
const MEETUPS = rows(seed.meetups);
const VENUES = rows(seed.venues);
const CODES = rows(seed.codes);
const USER_BY_ID = new Map(USERS.map((user) => [user.id, user]));
const VENUE_BY_ID = new Map(VENUES.map((venue) => [venue.id, venue]));
const CODE_BY_VENUE = new Map(CODES.map((entry) => [entry.venueId, entry.venueSecret]));
const USERS_BY_CITY = groupBy(USERS, (user) => user.cityId);
const VENUES_BY_CITY = groupBy(VENUES, (venue) => venue.cityId);
const CITY_IDS = [...USERS_BY_CITY.keys()];

// The meetups this run may read, the pairs it must not propose again (`409 meetup_exists`), and
// every locked meetup a check-in can reach — venue coordinates plus a console secret — by LOCKED index.
const LOCKED = MEETUPS.filter((meetup) => meetup.status === 'locked');
const CHATTY = MEETUPS.filter(
  (meetup) => meetup.status === 'locked' || meetup.status === 'completed',
);
const SEEDED_PAIRS = new Set(MEETUPS.map((m) => pairKey(m.initiatorId, m.recipientId)));
const CHECK_IN_POOL = LOCKED.filter(
  (meetup) => CODE_BY_VENUE.has(meetup.venueId) && VENUE_BY_ID.has(meetup.venueId),
).map((meetup) => LOCKED.indexOf(meetup));

// k6 accepts a status the callback names, so a 409 never enters `http_req_failed`.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

/*
 * The measured mix (AAP 0.12.2): 80% reads and 20% writes, weights out of 100. `budget_change` is the
 * state-writing read of AAP 0.5.4, so it belongs to the writes; `meetup_detail` and `suggestions` are
 * reads in the mix although the API limits them per user, which the rotation above is sized for.
 */
const ENDPOINTS = [
  { name: 'discovery', kind: 'read', weight: 12, run: discovery },
  { name: 'venues', kind: 'read', weight: 8, run: venues },
  { name: 'profile', kind: 'read', weight: 12, run: profile },
  { name: 'meetup_detail', kind: 'read', weight: 10, run: meetupDetail },
  { name: 'messages', kind: 'read', weight: 10, run: messages },
  { name: 'suggestions', kind: 'read', weight: 8, run: suggestions },
  { name: 'lodgings', kind: 'read', weight: 8, run: lodgings },
  { name: 'me', kind: 'read', weight: 12, run: me },
  { name: 'profile_update', kind: 'write', weight: 4, run: profileUpdate },
  { name: 'propose', kind: 'write', weight: 4, run: propose },
  { name: 'check_in', kind: 'write', weight: 4, run: checkIn },
  { name: 'report', kind: 'write', weight: 4, run: report },
  { name: 'budget_change', kind: 'write', weight: 4, run: budgetChange },
];

/**
 * The 100 slots of one block: a weighted round robin that hands each slot to the endpoint furthest
 * below its share. It hits every weight exactly and interleaves the kinds, so an aligned window of
 * iterations keeps the ratio instead of asking for twelve discoveries in a row; `buildRanks` numbers
 * the proposals of each block.
 */
function buildSchedule(endpoints) {
  const counts = endpoints.map(() => 0);
  const slots = [];
  for (let slot = 0; slot < BLOCK; slot += 1) {
    let best = 0;
    for (let index = 1; index < endpoints.length; index += 1) {
      if (endpoints[index].weight - counts[index] > endpoints[best].weight - counts[best])
        best = index;
    }
    counts[best] += 1;
    slots.push(best);
  }
  return slots;
}

function buildRanks(slots) {
  const seen = {};
  return slots.map((slot) => {
    const rank = seen[slot] || 0;
    seen[slot] = rank + 1;
    return rank;
  });
}

const SCHEDULE = buildSchedule(ENDPOINTS);
const SCHEDULE_RANK = buildRanks(SCHEDULE);
const READ_LATENCY = new Trend('read_latency', true);
const WRITE_LATENCY = new Trend('write_latency_excl_stripe', true);

// Per-endpoint counters: k6 carries no tag breakdown in the summary for a metric no threshold names.
const COUNTERS = {};
for (const endpoint of ENDPOINTS) {
  COUNTERS[endpoint.name] = {
    requests: new Counter(`ep_${endpoint.name}_reqs`),
    conflicts: new Counter(`ep_${endpoint.name}_409`),
    failures: new Counter(`ep_${endpoint.name}_fail`),
  };
}

// The four thresholds (AAP 0.12.2): the selector `options` keys and the expression k6 evaluates.
const LIMITS = [
  ['read_latency{phase:measure}', 'p(95)<=300'],
  ['write_latency_excl_stripe{phase:measure}', 'p(95)<=800'],
  ['http_req_failed{phase:measure}', 'rate<0.01'],
  ['dropped_iterations', 'count==0'],
];
const thresholds = {};
for (const [selector, expression] of LIMITS) {
  thresholds[selector] = [expression];
}

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      exec: 'run',
      rate: TARGET_RATE,
      timeUnit: '1s',
      duration: `${WARMUP_SECONDS}s`,
      preAllocatedVUs: 50,
      maxVUs: 200,
      tags: { phase: 'warmup' },
    },
    measure: {
      executor: 'constant-arrival-rate',
      exec: 'run',
      startTime: `${WARMUP_SECONDS}s`,
      rate: TARGET_RATE,
      timeUnit: '1s',
      duration: `${MEASURE_SECONDS}s`,
      preAllocatedVUs: 50,
      maxVUs: 200,
      tags: { phase: MEASURE },
    },
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  setupTimeout: '60s',
  // Response bodies are kept: the failure diagnostics read the error envelope, and both are small.
  thresholds,
};

/*
 * The endpoints, one measured request each. Each body follows the strict shared schema of its route,
 * where an unknown key would answer `400 invalid_field` and count as a failure.
 */
function discovery(index) {
  const caller = callerFor(index);
  return http.get(`${BASE}/cities/${caller.cityId}/travelers`, params(caller, 'discovery', 'read'));
}
function venues(index) {
  const caller = callerFor(index);
  return http.get(`${BASE}/cities/${caller.cityId}/venues`, params(caller, 'venues', 'read'));
}
function profile(index) {
  const caller = callerFor(index);
  const target = at(USERS, index * CALLER_STRIDE + 1);
  return http.get(`${BASE}/users/${target.id}`, params(caller, 'profile', 'read'));
}
function meetupDetail(index) {
  const { meetup, caller } = meetupFor(index, MEETUPS);
  return http.get(`${BASE}/meetups/${meetup.id}`, params(caller, 'meetup_detail', 'read'));
}
function messages(index) {
  const { meetup, caller } = meetupFor(index, CHATTY);
  return http.get(`${BASE}/meetups/${meetup.id}/messages`, params(caller, 'messages', 'read'));
}
function suggestions(index) {
  const { meetup, caller } = meetupFor(index, CHATTY);
  return http.get(
    `${BASE}/meetups/${meetup.id}/suggestions`,
    params(caller, 'suggestions', 'read'),
  );
}
function lodgings(index) {
  const caller = callerFor(index);
  return http.get(
    `${BASE}/cities/${caller.cityId}/lodgings?sort=activity`,
    params(caller, 'lodgings', 'read'),
  );
}
function me(index) {
  const caller = callerFor(index);
  return http.get(`${BASE}/me`, params(caller, 'me', 'read'));
}
function profileUpdate(index) {
  const caller = callerFor(index);
  const body = JSON.stringify({ bio: `perf ${index}` });
  return http.put(`${BASE}/me/profile`, body, jsonParams(caller, 'profile_update', 'write'));
}
function propose(index, rank) {
  const plan = proposalPlan(index, rank);
  return http.post(
    `${BASE}/meetups`,
    JSON.stringify(plan.body),
    jsonParams(plan.caller, 'propose', 'write'),
  );
}
function checkIn(index, rank, data) {
  const ordinal = blockOrdinal(index, rank);
  const meetup = LOCKED[at(data.checkIn, ordinal)];
  const [first, second] = [meetup.initiatorId, meetup.recipientId];
  const id = Math.floor(ordinal / data.checkIn.length) % 2 === 0 ? first : second;
  const venue = VENUE_BY_ID.get(meetup.venueId);
  const body = JSON.stringify({
    code: currentCode(meetup.venueId),
    lat: venue.lat,
    lng: venue.lng,
  });
  const caller = USER_BY_ID.get(id) || callerFor(index);
  return http.post(
    `${BASE}/meetups/${meetup.id}/check-in`,
    body,
    jsonParams(caller, 'check_in', 'write'),
  );
}
function report(index) {
  const caller = callerFor(index);
  const target = at(USERS, index * CALLER_STRIDE + 1);
  const body = JSON.stringify({ reason: 'perf load test' });
  return http.post(
    `${BASE}/users/${target.id}/report`,
    body,
    jsonParams(caller, 'report', 'write'),
  );
}
function budgetChange(index) {
  const { meetup, caller } = meetupFor(index, CHATTY);
  const budget = 500 + (index % 20) * 500;
  return http.get(
    `${BASE}/meetups/${meetup.id}/suggestions?perPersonBudgetCents=${budget}`,
    params(caller, 'budget_change', 'write'),
  );
}

/**
 * The ordinal of one of a stream's {@link STREAM_SLOTS} slots in the run: the count the proposals and
 * the check-ins number themselves from. `iterationInTest` restarts in each scenario, so the block
 * comes from the global index instead, which puts both streams on one timeline.
 */
function blockOrdinal(index, rank) {
  return Math.floor(index / BLOCK) * STREAM_SLOTS + rank;
}

/**
 * One proposal of the run: a pair from the city's pool past the seeded pairs, an active partner venue
 * of that city, and a start inside the five-day horizon (AAP 0.5.4). The pairs stay unique across the
 * run: the ordinal cycles the cities, and within one city the gap walks a fresh cyclic difference of
 * the pool, so no pair is proposed twice.
 */
function proposalPlan(index, rank) {
  const ordinal = blockOrdinal(index, rank);
  const city = CITY_IDS[ordinal % CITY_IDS.length];
  const venues = VENUES_BY_CITY.get(city);
  const accounts = USERS_BY_CITY.get(city) || USERS;
  const pool =
    accounts.length > SEEDED_PAIR_ACCOUNTS + 1 ? accounts.slice(SEEDED_PAIR_ACCOUNTS) : accounts;
  const nth = Math.floor(ordinal / CITY_IDS.length);
  const from = nth % pool.length;
  const gap = 1 + Math.floor(nth / pool.length);
  const initiator = pool[from];
  let recipient = pool[(from + gap) % pool.length];
  if (SEEDED_PAIRS.has(pairKey(initiator.id, recipient.id))) {
    recipient = pool[(from + gap + 1) % pool.length];
  }

  return {
    caller: initiator,
    body: {
      recipientId: recipient.id,
      venueId: venues[nth % venues.length].id,
      startsAt: new Date(Date.now() + 2 * DAY_MS + (ordinal % 600) * MINUTE_MS).toISOString(),
      depositCents: 1000,
    },
  };
}

/** This VU's per-venue cache of live check-in codes; a code expires with its 60-second step. */
const codeCache = {};

/**
 * The venue's current code, as auxiliary traffic: the console route is the only source, because a
 * code rotates every 60 seconds (AAP 0.5.7). The request is tagged `phase: aux`, so it reaches
 * neither latency Trend nor any `phase: measure` threshold, and a cached code is reused until the
 * step it belongs to ends — the API accepts the neighbouring steps as well.
 */
function currentCode(venueId) {
  const cached = codeCache[venueId];
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.code;

  const response = http.get(`${BASE}/venue/check-in-code`, {
    headers: { 'x-venue-secret': CODE_BY_VENUE.get(venueId) },
    tags: { kind: 'aux', endpoint: 'aux_code', name: 'aux_code', phase: 'aux' },
  });

  const body = parseBody(response);
  const expiresAt = body === null ? NaN : Date.parse(body.expiresAt);
  const code = body !== null && typeof body.code === 'string' ? body.code : '';
  if (response.status !== 200 || code.length !== 6 || !Number.isFinite(expiresAt)) return '';
  codeCache[venueId] = { code, expiresAt };
  return code;
}

/**
 * Validate the seed and pick the check-in targets. Every failure aborts with its reason and tells the
 * operator to re-run `pnpm perf`: the tokens live fifteen minutes and the locked meetups' check-in
 * windows are already open, so a stale seed measures 401s and 410s rather than latency. The returned
 * payload is ids and a timestamp only — k6 hands it to `handleSummary` as `setup_data`, and the
 * summary file is an artefact that must hold no token and no secret.
 */
export function setup() {
  const now = Date.now();
  const until = now + RUNNING_MS;
  const stale = 're-run `pnpm perf` immediately, so the seed is fresh.';

  if (USERS.length !== 1000) {
    exec.test.abort(`the seed holds ${USERS.length} accounts, not 1000: ${stale}`);
  }
  const incomplete = USERS.filter((user) => !user.accessToken || !user.cityId).length;
  if (incomplete > 0) {
    exec.test.abort(`${incomplete} seeded accounts carry no token or no city: ${stale}`);
  }
  if (!(Date.parse(seed.tokenExpiresAt) > until)) {
    exec.test.abort(`the seeded tokens expire before the run ends: ${stale}`);
  }
  if (CODE_BY_VENUE.size === 0) {
    exec.test.abort(`the seed carries no \`codes\` venue secrets, so no code can be had: ${stale}`);
  }
  if (CHATTY.length === 0) {
    exec.test.abort(`the seed carries no locked or completed meetup to read: ${stale}`);
  }
  for (const cityId of CITY_IDS) {
    const users = USERS_BY_CITY.get(cityId);
    if (users.length < 2 || VENUES_BY_CITY.get(cityId).length === 0) {
      exec.test.abort(`${cityId} holds ${users.length} accounts or no partner venue: ${stale}`);
    }
  }

  // A check-in must stay inside its window for the whole run: open no later than the run starts and
  // closing no earlier than it ends, or the route answers `410 outside_window` midway.
  const checkIn = CHECK_IN_POOL.filter((position) => {
    const startsAt = Date.parse(LOCKED[position].startsAt);
    return startsAt - 15 * MINUTE_MS <= now && startsAt + 45 * MINUTE_MS >= until;
  });
  if (checkIn.length === 0) {
    exec.test.abort(`no locked meetup's check-in window covers the next 7 minutes: ${stale}`);
  }
  return { checkIn, startedAt: new Date(now).toISOString() };
}

/**
 * One iteration: exactly one measured request. Both scenarios name this function in their `exec`, and
 * the global index puts them on one timeline, which keeps the propose pairs and the caller rotation
 * unique across the run rather than per scenario.
 */
export function run(data) {
  const index = globalIndex();
  const slot = index % BLOCK;
  const endpoint = ENDPOINTS[SCHEDULE[slot]];
  record(endpoint, endpoint.run(index, SCHEDULE_RANK[slot], data));
}

/** The iteration's position in the whole run: `iterationInTest` restarts in each scenario. */
function globalIndex() {
  return exec.scenario.name === MEASURE
    ? TARGET_RATE * WARMUP_SECONDS + exec.scenario.iterationInTest
    : exec.scenario.iterationInTest;
}

/**
 * Record one measured response. Nothing is recorded during the warm-up, which is why the Trends hold
 * the measured five minutes alone, and each sample names `phase: measure` itself, so the thresholds
 * select it whether or not a scenario's tags reach a custom metric.
 */
function record(endpoint, response) {
  if (exec.scenario.name !== MEASURE) return;

  const tags = { kind: endpoint.kind, endpoint: endpoint.name, phase: MEASURE };
  if (endpoint.kind === 'read') {
    READ_LATENCY.add(response.timings.duration, tags);
  } else {
    WRITE_LATENCY.add(Math.max(0, response.timings.duration - stripeMs(response)), tags);
  }

  const counters = COUNTERS[endpoint.name];
  counters.requests.add(1);
  if (response.status === 409) {
    counters.conflicts.add(1);
  } else if (response.status < 200 || response.status > 299) {
    counters.failures.add(1);
    diagnose(endpoint.name, response);
  }
}

/**
 * The milliseconds the API spent in Stripe for one request, from the `Server-Timing` header its
 * `onSend` hook sets on a mutating route. The header is absent when the route called Stripe not at
 * all, may repeat the metric, and k6 canonicalizes its name, so both spellings are read and an
 * absent or unparsable entry counts as zero (AAP 0.12.2).
 */
function stripeMs(response) {
  const header = response.headers['Server-Timing'] || response.headers['server-timing'] || '';
  let total = 0;

  for (const entry of `${header}`.split(',')) {
    const parts = entry.split(';');
    if (parts[0].trim() !== 'stripe') continue;
    for (const parameter of parts.slice(1)) {
      const [key, value] = parameter.split('=');
      const duration = parseFloat(value);
      if (`${key}`.trim() === 'dur' && Number.isFinite(duration)) total += duration;
    }
  }
  return total;
}

const logged = {};

/** Endpoint, status and the envelope's code only: never a URL, body, token, secret or coordinate. */
function diagnose(name, response) {
  const seen = logged[name] || 0;
  if (seen >= MAX_LOGGED_FAILURES) return;
  logged[name] = seen + 1;

  const body = parseBody(response);
  const code = body !== null && body.error !== undefined ? body.error.code : '-';
  console.warn(`unexpected ${name} ${response.status} ${code}`);
}

function parseBody(response) {
  try {
    return JSON.parse(response.body);
  } catch (_error) {
    return null;
  }
}

export function handleSummary(data) {
  // Defensive: what `setup()` returned is derived from the seed, and it belongs in no artefact.
  delete data.setup_data;

  const report = buildReport(data);
  return {
    [SUMMARY_FILE]: JSON.stringify({ ...data, tablemate: report }, null, 2),
    stdout: renderText(report),
  };
}

/** The `tablemate` block of the summary: the figures, their thresholds and the per-endpoint counts. */
function buildReport(data) {
  const endedAt = Date.now();
  const reads = buckets(data, LIMITS[0][0]);
  const writes = buckets(data, LIMITS[1][0]);
  const measured = [
    reads.p95,
    writes.p95,
    value(data, LIMITS[2][0], 'rate', 0),
    value(data, LIMITS[3][0], 'count', 0),
  ];
  const endpoints = {};
  const totals = { requests: 0, reads: 0, writes: 0 };

  for (const endpoint of ENDPOINTS) {
    const counted = {
      kind: endpoint.kind,
      requests: value(data, `ep_${endpoint.name}_reqs`, 'count', 0),
      conflicts409: value(data, `ep_${endpoint.name}_409`, 'count', 0),
      failures: value(data, `ep_${endpoint.name}_fail`, 'count', 0),
    };
    endpoints[endpoint.name] = counted;
    totals.requests += counted.requests;
    totals[endpoint.kind === 'read' ? 'reads' : 'writes'] += counted.requests;
  }
  totals.readToWriteRatio =
    totals.writes === 0 ? null : Math.round((totals.reads / totals.writes) * 100) / 100;

  return {
    runStart: new Date(endedAt - data.state.testRunDurationMs).toISOString(),
    runEnd: new Date(endedAt).toISOString(),
    targetRate: TARGET_RATE,
    warmupSeconds: WARMUP_SECONDS,
    measureSeconds: MEASURE_SECONDS,
    reads,
    writesExclStripe: writes,
    failureRate: measured[2],
    droppedIterations: measured[3],
    thresholds: LIMITS.map(([selector, expression], index) => ({
      selector,
      expression,
      measured: measured[index],
      ok: thresholdOk(data.metrics[selector], expression),
    })),
    endpoints,
    totals,
  };
}

/** One aggregated Trend value set, zeroed when the metric was never emitted. */
function buckets(data, selector) {
  return {
    p50: value(data, selector, 'med', 0),
    p95: value(data, selector, 'p(95)', 0),
    max: value(data, selector, 'max', 0),
    count: value(data, selector, 'count', 0),
  };
}

function value(data, selector, key, fallback) {
  const metric = data.metrics[selector];
  const found =
    metric === undefined || metric.values === undefined ? undefined : metric.values[key];
  return typeof found === 'number' ? found : fallback;
}

/**
 * A threshold's verdict in the summary data, or `null` when it carries none. k6 reports a metric's
 * thresholds as a map from expression to result; the array of one-key objects is read too, because
 * that layout has moved between releases.
 */
function thresholdOk(metric, expression) {
  const thresholds = metric === undefined ? undefined : metric.thresholds;

  if (Array.isArray(thresholds)) {
    const hit = thresholds.find(
      (entry) => entry !== null && typeof entry === 'object' && entry[expression] !== undefined,
    );
    return hit === undefined ? null : verdictOf(hit[expression]);
  }
  if (thresholds === null || typeof thresholds !== 'object' || !(expression in thresholds)) {
    return null;
  }
  return verdictOf(thresholds[expression]);
}

function verdictOf(result) {
  return result !== null && typeof result === 'object' ? result.ok === true : result !== false;
}

/** One line per target with its measured value, then the volume and the mix it was measured over. */
function renderText(report) {
  const checks = [
    ['reads p95', `${report.reads.p95.toFixed(1)} ms <= 300`, report.reads.p95 <= 300],
    [
      'writes excl. Stripe p95',
      `${report.writesExclStripe.p95.toFixed(1)} ms <= 800`,
      report.writesExclStripe.p95 <= 800,
    ],
    ['failure rate', `${(report.failureRate * 100).toFixed(2)} % < 1%`, report.failureRate < 0.01],
    ['dropped iterations', `${report.droppedIterations} == 0`, report.droppedIterations === 0],
  ];
  const lines = checks.map(([label, measured, held], index) => {
    const ok = report.thresholds[index].ok;
    return `${label} ${measured} ${(ok === null ? held : ok) ? 'PASS' : 'FAIL'}`;
  });

  const { requests, reads, writes, readToWriteRatio } = report.totals;
  const ratio = readToWriteRatio === null ? '' : ` (${readToWriteRatio}:1)`;
  lines.push(
    `${requests} measured requests over ${report.measureSeconds} s at ${report.targetRate}/s, ` +
      `reads ${reads} / writes ${writes}${ratio}`,
  );
  return `${lines.join('\n')}\n`;
}
