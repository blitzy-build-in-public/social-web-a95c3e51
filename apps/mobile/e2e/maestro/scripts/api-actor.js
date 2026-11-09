/* global http, json, output, maestro, ACTION, ROLE, API_URL, TEST_CONTROL_TOKEN, OFFSET_MIN */
/*
 * The API side of the native criterion 1 walks (AAP 0.8.1, 0.11.2): one `runScript` step per action.
 * `criterion1-initiator.yaml` and `criterion1-recipient.yaml` each play one actor on the device and drive
 * the counterpart — and, where only an operator can act, the operator — through the API.
 *
 * Actions: signin, clear-pair, fresh-day, propose, accept, check-in, advance-to, settle, resolve-dispute,
 * assert-settled. The last carries criterion 1's pass checks: both holds released after settlement, a
 * completion rate of 100% for one meetup, and the pair's one completion read back through the disclosure
 * tier the API computes (tier 2 after one completed meetup, tier 3 after two).
 *
 * Flow env: ACTION, ROLE (`a`, `b` or `operator`), API_URL, TEST_CONTROL_TOKEN (every step that moves the
 * clock or settles) and OFFSET_MIN (minutes from the start, for advance-to), each read as
 * `typeof X !== 'undefined'` because a flow's `env:` values arrive as globals rather than as
 * declarations. `output` read: `e2e` (from `.local/e2e/fixture-proofs.js`, written by `prepare-maestro`
 * in apps/mobile/e2e/playwright/support/api-actor.ts), `token`, `code`, `sessions`, `meetupId`,
 * `meetupRole`, `day`, `pairCompletedBefore`. `output` set: `sessions[ROLE]`, `meetupId`, `meetupRole`,
 * `day`, `pairCompletedBefore` and `e2e.stay.cursor`; `token` is deleted once exchanged. No message here
 * carries a token, the venue secret, a check-in code or a coordinate.
 */
(function () {
  'use strict';
  /* TEST_CONTROL_HEADER (packages/shared/src/schemas/common.ts) and VENUE_SECRET_HEADER
   * (…/consoles.ts), written out because this sandbox has no imports. */
  const TEST_HEADER = 'X-Test-Control-Token';
  const VENUE_HEADER = 'X-Venue-Secret';
  const STEP_MS = 60000; // one step of the rotating venue code, and the resolution of apiNow()
  const MIN_MS = 60000;
  const DAY_MS = 86400000;
  const DEPOSIT_CENTS = 1000; // the middle of 500 / 1000 / 2000 (AAP 0.7.3)
  const PAGES_MAX = 20; // 20 meetups a page; the bound stops a cursor the API hands back unchanged
  const ACCEPT_WAIT_MS = 15000;
  const ACCEPT_PAUSE_MS = 1500;
  const RELEASE_WAIT_MS = 90000;
  const RELEASE_PAUSE_MS = 2000;
  const EXECUTOR_EVERY = 5; // re-run the settlement every 5th poll, about every 10 s
  const action = typeof ACTION === 'undefined' ? '' : String(ACTION);
  const role = typeof ROLE === 'undefined' ? '' : String(ROLE);
  const offset = typeof OFFSET_MIN === 'undefined' ? '' : String(OFFSET_MIN).trim();
  const controlToken = typeof TEST_CONTROL_TOKEN === 'undefined' ? '' : String(TEST_CONTROL_TOKEN);
  const base =
    required('API_URL', typeof API_URL === 'undefined' ? '' : String(API_URL)).replace(/\/+$/, '') +
    '/v1';
  if (role !== 'a' && role !== 'b' && role !== 'operator') {
    throw new Error(`ROLE must be a, b or operator, not ${role === '' ? '(unset)' : role}`);
  }
  output.sessions = output.sessions || {};
  /* One flow variable, refused by name and never by value. */
  function required(name, value) {
    if (value === '') throw new Error(`api-actor.js needs the ${name} flow variable`);
    return value;
  }
  /* The other actor of this walk's pair; an operator holds no pair, so it is an error here. */
  function other(actorRole) {
    if (actorRole === 'a') return 'b';
    if (actorRole === 'b') return 'a';
    throw new Error('this action runs as an actor role (a or b), not operator');
  }
  function e2e() {
    const fixture = output.e2e;
    if (!fixture || typeof fixture !== 'object') {
      throw new Error(
        'fixture data missing — the flow must runScript .local/e2e/fixture-proofs.js first (pnpm --filter @tablemate/mobile e2e:prepare)',
      );
    }
    return fixture;
  }
  /* The `error.code` of the shared envelope { error: { code, message } } (AAP 0.5.4). */
  function code(res) {
    const error = res.data && typeof res.data === 'object' ? res.data.error : undefined;
    return error && typeof error.code === 'string' ? error.code : 'no_code';
  }
  /* One request. A `GET` carries no body and no `Content-Type`, because Fastify refuses an empty body
   * declared as JSON; every other method sends one — `{}` when the step has none — for that reason. */
  function send(method, path, body, headers) {
    const options = { headers: headers || {} };
    if (method !== 'GET') {
      options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers);
      options.body = JSON.stringify(body || {});
    }
    const url = base + path;
    const response = method === 'GET' ? http.get(url, options) : http.post(url, options);
    const text = typeof response.body === 'string' ? response.body : '';
    let data = null;
    if (text !== '') {
      try {
        data = json(text);
      } catch {
        /* a body that is not JSON carries no data */
      }
    }
    return { status: response.status, data };
  }
  function fail(method, path, res, hint) {
    const suffix = hint ? ` — ${hint}` : '';
    throw new Error(`${method} /v1${path} failed: HTTP ${res.status} ${code(res)}${suffix}`);
  }
  /* One authenticated request, refreshing an expired access token once: a walk jumps the test clock far
   * past the token's 15 minutes, and the API rotates refresh tokens and revokes the whole session when
   * one is presented twice, so the rotated pair is stored before the retry. */
  function call(actorRole, method, path, body) {
    let session = output.sessions[actorRole];
    if (!session) {
      throw new Error(
        `no session for ${actorRole} — run ACTION=signin with ROLE=${actorRole} first`,
      );
    }
    const auth = (current) => ({ Authorization: `Bearer ${current.accessToken}` });
    let res = send(method, path, body, auth(session));
    if (res.status === 401 && code(res) === 'token_invalid') {
      const rotated = send('POST', '/auth/refresh', { refreshToken: session.refreshToken });
      if (rotated.status !== 200 || !rotated.data) {
        fail('POST', '/auth/refresh', rotated, 'rerun e2e:prepare');
      }
      session = Object.assign({}, rotated.data, { userId: session.userId });
      output.sessions[actorRole] = session;
      res = send(method, path, body, auth(session));
    }
    if (res.status === 403 && code(res) === 'age_gate_required') {
      throw new Error(`the account for ${actorRole} lacks consents — rerun e2e:prepare`);
    }
    return res;
  }
  /* One test-control call: the API mounts those routes only under `APP_ENV=test` with
   * `TEST_CONTROL_TOKEN` set, and answers a wrong header as it answers an unknown path, `404`. */
  function control(path, body) {
    if (controlToken === '') {
      throw new Error(`TEST_CONTROL_TOKEN is required for ACTION=${action}`);
    }
    const res = send('POST', path, body, { [TEST_HEADER]: controlToken });
    if (res.status === 404) {
      throw new Error(
        'test control unavailable: APP_ENV must be test and TEST_CONTROL_TOKEN must match the stack',
      );
    }
    if (res.status !== 204) fail('POST', path, res);
  }
  /* The venue's code and the end of its 60-second step, the one reading of the API's injected clock
   * there is: the response `Date` header is wall time, not the test clock (AAP 0.3.2, 0.5.7). */
  function clockEnd() {
    const res = send('GET', '/venue/check-in-code', undefined, {
      [VENUE_HEADER]: e2e().venue.secret,
    });
    if (res.status === 401) throw new Error('venue secret rejected — rerun e2e:prepare');
    if (res.status !== 200 || !res.data) fail('GET', '/venue/check-in-code', res);
    return res.data;
  }
  /* The API's clock, bounded from below to one step: the step the current code belongs to has begun. */
  function apiNow() {
    return Date.parse(clockEnd().expiresAt) - STEP_MS;
  }
  /* The clock moves forwards only: a target inside the step it is already in would have the venue's
   * code derived for a counter that has gone. */
  function setClock(target) {
    const upper = Date.parse(clockEnd().expiresAt);
    if (!Number.isFinite(target))
      throw new Error('setClock needs a finite instant in milliseconds');
    if (target <= upper) {
      throw new Error(
        `refusing to move the test clock backwards: target ${new Date(target).toISOString()} is not after ${new Date(upper).toISOString()}`,
      );
    }
    control('/test/clock', { now: new Date(target).toISOString() });
  }
  /* Every page of the caller's own meetups under one query, following the keyset cursor (AAP 0.5.4).
   * A plain read, so it is not under the per-user mutating limit. */
  function meetups(actorRole, query) {
    const found = [];
    let cursor = null;
    for (let page = 0; page < PAGES_MAX; page += 1) {
      const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const res = call(actorRole, 'GET', `/meetups?${query}${suffix}`);
      if (res.status !== 200 || !res.data) fail('GET', '/meetups', res);
      for (const item of res.data.items || []) found.push(item);
      cursor = res.data.nextCursor || null;
      if (cursor === null) break;
    }
    return found;
  }
  /* This walk's pair alone, on the side and in the state asked for: never a third party's meetup that a
   * shared stack happens to hold. */
  function pairAll(actorRole, side, status) {
    const counterpart = e2e().actors[other(role)].userId;
    return meetups(actorRole, `role=${side}&status=${status}`).filter((item) =>
      Boolean(item && item.counterpart && item.counterpart.id === counterpart),
    );
  }
  /* The newest of a list, which is the one just made when a race left more than one: at most one open
   * meetup exists per pair (AAP 0.5.2). */
  function newest(items) {
    return items.reduce((best, item) => {
      return !best || Date.parse(item.startsAt) > Date.parse(best.startsAt) ? item : best;
    }, null);
  }
  function dateOf(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  function addDays(date, days) {
    return dateOf(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
  }
  /* A bounded busy-wait between poll attempts: Maestro's GraalJS exposes no timers. */
  function wait(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
  function meetupId() {
    if (!output.meetupId) throw new Error('no meetup — run ACTION=propose or ACTION=accept first');
    return output.meetupId;
  }
  function meetupDay() {
    const chosen = output.day;
    if (!chosen || typeof chosen.startsAt !== 'string') {
      throw new Error('no meetup day — run ACTION=fresh-day first');
    }
    return chosen;
  }
  /* A hold needs a saved card, and only Stripe's test keys can confirm one, so the walk runs on the
   * stack `scripts/e2e.ts` starts in `STRIPE_MODE=test`, never through a mocked payment path (0.11.2). */
  function stripeRequired() {
    if (e2e().stripeMode !== 'test') {
      throw new Error(
        'Stripe test mode required: this walk confirms real test-mode holds, and the stack runs STRIPE_MODE=mock',
      );
    }
  }
  function noCard(actorRole) {
    return `no saved card for ${actorRole} — prepare-maestro runs ensureCard in test mode`;
  }
  /* One cancelled meetup. `409 already_settled` is one that lapsed meanwhile, which is what clearing
   * it wanted. */
  function cancelMeetup(id) {
    const res = call(role, 'POST', `/meetups/${id}/cancel`);
    const gone = code(res) === 'already_settled' || code(res) === 'not_proposed';
    if (res.status !== 200 && !gone) fail('POST', `/meetups/${id}/cancel`, res);
  }
  function openDispute(id) {
    const res = call('operator', 'GET', '/admin/disputes');
    if (res.status !== 200 || !res.data) fail('GET', '/admin/disputes', res);
    const found = (res.data.items || []).filter(
      (item) => item && item.meetupId === id && item.status === 'open',
    );
    return found.length === 0 ? null : found[0];
  }
  /* One operator outcome, which the handler validates against the dispute lifecycle (AAP 0.5.3). */
  function resolveDispute(disputeId, outcome) {
    const res = call('operator', 'POST', `/admin/disputes/${disputeId}/resolve`, { outcome });
    if (res.status !== 200) fail('POST', `/admin/disputes/${disputeId}/resolve`, res);
  }
  /* One open meetup, cancelled or settled — the only two ways it leaves the pair's way. Nothing here
   * ever blocks: there is no unblock route, and a block would break every later walk (AAP 0.7.2). */
  function clearMeetup(meetup) {
    if (meetup.status === 'proposed') {
      cancelMeetup(meetup.id);
      return;
    }
    if (meetup.disputeOpen) {
      if (!output.sessions.operator) {
        throw new Error('clear-pair needs ROLE=operator signed in to resolve an open dispute');
      }
      const dispute = openDispute(meetup.id);
      if (dispute === null) {
        throw new Error(`meetup ${meetup.id} has an open dispute the operator queue does not hold`);
      }
      resolveDispute(dispute.id, 'no_fault');
      return;
    }
    /* At or before `startsAt − 2 h` a cancel is free — exactly 2 h before the start is still free —
     * with a minute of slack for the step `apiNow()` reads the API's clock to (AAP 0.5.3). */
    if (apiNow() + STEP_MS <= Date.parse(meetup.lateCancelFrom)) {
      cancelMeetup(meetup.id);
      return;
    }
    const settledAt = Date.parse(meetup.startsAt) + 46 * MIN_MS;
    if (settledAt > Date.parse(clockEnd().expiresAt)) setClock(settledAt);
    control('/test/run-settlement', { meetupId: meetup.id });
  }
  /* Criterion 1's headline, from the operator dashboard: one meetup, both attendees checked in, and
   * `rate` is the 0..1 fraction `completionRate` computes, so 100% is exactly 1 (AAP 0.5.7). */
  function assertRate(id) {
    const day = meetupDay();
    const cityId = encodeURIComponent(e2e().venue.cityId);
    const res = call(
      'operator',
      'GET',
      `/admin/metrics?from=${day.date}&to=${day.date}&cityId=${cityId}`,
    );
    if (res.status !== 200 || !res.data) fail('GET', '/admin/metrics', res);
    const completion = res.data.completion;
    if (completion.lockedMeetups !== 1 || completion.bothCheckedIn !== 1 || completion.rate !== 1) {
      throw new Error(
        `meetup ${id} does not complete the rate for ${day.date} in ${e2e().venue.cityId}: ${completion.bothCheckedIn}/${completion.lockedMeetups} with rate ${String(completion.rate)}, expected 1/1 and rate 1`,
      );
    }
  }
  switch (action) {
    /* Exchange the magic-link token for a session (AAP 0.5.4). */
    case 'signin': {
      const token = typeof output.token === 'string' ? output.token : '';
      if (token === '') throw new Error('no magic-link token — run read-magic-link.js first');
      const res = send('POST', '/auth/verify', { token });
      if (res.status === 401) {
        throw new Error(`magic-link token rejected for ${role} (expired or already used)`);
      }
      if (res.status !== 200 || !res.data || !res.data.user) fail('POST', '/auth/verify', res);
      const user = res.data.user;
      if (role === 'operator' && user.role !== 'operator') {
        throw new Error('signed in without the operator role — rerun e2e:prepare');
      }
      if (role !== 'operator' && user.id !== e2e().actors[role].userId) {
        throw new Error(`signed in as the wrong account for ${role}`);
      }
      output.sessions[role] = {
        accessToken: res.data.accessToken,
        refreshToken: res.data.refreshToken,
        userId: user.id,
      };
      delete output.token;
      break;
    }
    /* Take the pair back to no open meetup, then record what the walk's tier check turns on. */
    case 'clear-pair': {
      for (const side of ['initiator', 'recipient']) {
        for (const status of ['proposed', 'locked']) {
          for (const meetup of pairAll(role, side, status)) clearMeetup(meetup);
        }
      }
      output.pairCompletedBefore =
        newest(pairAll(role, 'initiator', 'completed')) !== null ||
        newest(pairAll(role, 'recipient', 'completed')) !== null;
      break;
    }
    /* A day of this pair's own, inside the overlap of the two proofs. */
    case 'fresh-day': {
      const stay = e2e().stay || {};
      const cursor = stay.cursor;
      const last =
        typeof cursor === 'string'
          ? cursor
          : cursor && cursor.lastLocalDate
            ? cursor.lastLocalDate
            : '';
      if (last === '' || typeof stay.overlapEnd !== 'string' || stay.overlapEnd === '') {
        throw new Error(
          'no stay window in the fixture data — rerun e2e:prepare (pnpm --filter @tablemate/mobile e2e:prepare)',
        );
      }
      const today = dateOf(apiNow());
      const day = addDays(today > last ? today : last, 1);
      if (day > addDays(stay.overlapEnd, -1)) {
        throw new Error('stay overlap exhausted — reset the stack');
      }
      /* 09:00 UTC, with the meetup at noon UTC on that date: noon UTC falls on one local date in every
       * launch city (UTC−6 … +8), so the day the dashboard ranges over is that date whichever zone the
       * API applies, each walk gets a day of its own, and no `Intl` zone data is needed. */
      setClock(Date.parse(`${day}T09:00:00Z`));
      /* Written back in the shape `prepare-maestro` left, so a cursor record keeps its fields. */
      if (cursor && typeof cursor === 'object') cursor.lastLocalDate = day;
      else stay.cursor = day;
      output.day = { date: day, startsAt: `${day}T12:00:00.000Z` };
      break;
    }
    /* The initiator's half: propose at the day's noon. */
    case 'propose': {
      stripeRequired();
      const day = meetupDay();
      const res = call(role, 'POST', '/meetups', {
        recipientId: e2e().actors[other(role)].userId,
        venueId: e2e().venue.id,
        startsAt: day.startsAt,
        depositCents: DEPOSIT_CENTS,
      });
      if (res.status === 402) throw new Error(noCard(role));
      if (res.status !== 201 || !res.data) fail('POST', '/meetups', res);
      output.meetupId = res.data.meetupId;
      output.meetupRole = 'initiator';
      break;
    }
    /* The recipient's half: lock the proposal the device made. */
    case 'accept': {
      stripeRequired();
      const day = meetupDay();
      const deadline = Date.now() + ACCEPT_WAIT_MS;
      let proposal = newest(pairAll(role, 'recipient', 'proposed'));
      /* The proposal becomes visible to the recipient only once the initiator's hold is held, so the
       * first sight of it is awaited rather than assumed. */
      while (proposal === null) {
        if (Date.now() >= deadline) {
          throw new Error(
            `no proposal for ${role} within 15 s — criterion1-initiator.yaml must propose on ${day.date} and its hold must be held first`,
          );
        }
        wait(ACCEPT_PAUSE_MS);
        proposal = newest(pairAll(role, 'recipient', 'proposed'));
      }
      /* The device picks the exact time; a start the API reports on the day `fresh-day` chose is
       * adopted, so `advance-to` stays relative to the real start. */
      if (proposal.startsAt !== day.startsAt) {
        if (dateOf(Date.parse(proposal.startsAt)) !== day.date) {
          throw new Error(
            `device proposal starts at ${proposal.startsAt}, outside day ${day.date} chosen by fresh-day`,
          );
        }
        day.startsAt = proposal.startsAt;
      }
      output.meetupId = proposal.id;
      output.meetupRole = 'recipient';
      const res = call(role, 'POST', `/meetups/${proposal.id}/accept`);
      if (res.status === 402) throw new Error(noCard(role));
      if (res.status !== 200 || !res.data) fail('POST', `/meetups/${proposal.id}/accept`, res);
      if (res.data.status !== 'locked') {
        throw new Error(
          'accept left the meetup proposed (3-D Secure pending) — the saved test card must not require authentication',
        );
      }
      break;
    }
    /* Submit the console's code with the venue's coordinates (AAP 0.5.7). */
    case 'check-in': {
      const id = meetupId();
      const venue = e2e().venue;
      const submit = (value) =>
        call(role, 'POST', `/meetups/${id}/check-in`, {
          code: value,
          lat: venue.lat,
          lng: venue.lng,
        });
      let res = submit(output.code || clockEnd().code);
      /* The 60-second step can roll over between the code being read and submitted: one fresh read, so
       * a genuinely wrong code still fails rather than being retried away. */
      if (res.status === 422 && code(res) === 'invalid_code') res = submit(clockEnd().code);
      if (res.status !== 200 || !res.data) fail('POST', `/meetups/${id}/check-in`, res);
      break;
    }
    case 'advance-to': {
      const day = meetupDay();
      const minutes = Number(offset);
      if (offset === '' || !Number.isFinite(minutes)) {
        throw new Error(
          'OFFSET_MIN must be a number of minutes — the flows pass -5 inside the check-in window and 46 past settlement',
        );
      }
      setClock(Date.parse(day.startsAt) + minutes * MIN_MS);
      break;
    }
    /* Idempotent, and the route also runs one sweeper pass and drains the outbox, so the payment
     * operations settlement planned are carried out before it answers (AAP 0.5.1). */
    case 'settle':
      control('/test/run-settlement', { meetupId: meetupId() });
      break;
    case 'resolve-dispute': {
      const id = meetupId();
      const dispute = openDispute(id);
      if (dispute === null) {
        throw new Error(
          `no open dispute on meetup ${id} — the device files it from the meetup screen`,
        );
      }
      /* criterion1-recipient.yaml calls this after `startsAt + 45 min`, where the API settles the meetup
       * at once; any earlier it only closes the dispute and leaves the outcome to the timer (AAP 0.5.3). */
      resolveDispute(dispute.id, 'settle_by_checkins');
      break;
    }
    /* The pass checks of criterion 1 (AAP 0.12.1). */
    case 'assert-settled': {
      const id = meetupId();
      const side = output.meetupRole === 'recipient' ? 'recipient' : 'initiator';
      const released = (item) =>
        item && item.initiatorHold === 'released' && item.recipientHold === 'released'
          ? item
          : null;
      const deadline = Date.now() + RELEASE_WAIT_MS;
      let settled = released(newest(pairAll(role, side, 'completed')));
      /* The list route is polled, not `GET /meetups/:id`, which is a state-writing read under the
       * 60-per-minute per-user limit (AAP 0.5.4). */
      for (let poll = 1; settled === null && Date.now() < deadline; poll += 1) {
        wait(RELEASE_PAUSE_MS);
        /* Every 5th attempt re-runs the settlement, which executes the release operations it decided. */
        if (poll % EXECUTOR_EVERY === 0) control('/test/run-settlement', { meetupId: id });
        settled = released(newest(pairAll(role, side, 'completed')));
      }
      if (settled === null) {
        /* One detail read, so a `lock_lost` or a forfeit is visible and not only a timeout. */
        const res = call(role, 'GET', `/meetups/${id}`);
        const state =
          res.status === 200 && res.data
            ? `${res.data.status}, holds ${res.data.initiatorHold}/${res.data.recipientHold}`
            : `HTTP ${res.status} ${code(res)}`;
        throw new Error(
          `meetup ${id} was not completed with both holds released within 90 s (${state})`,
        );
      }
      /* The settled meetup itself, asserted field by field rather than assumed from the poll. */
      const detail = call(role, 'GET', `/meetups/${id}`);
      if (detail.status !== 200 || !detail.data) fail('GET', `/meetups/${id}`, detail);
      const meetup = detail.data;
      const completed =
        meetup.status === 'completed' &&
        meetup.initiatorHold === 'released' &&
        meetup.recipientHold === 'released';
      if (!completed) {
        throw new Error(
          `meetup ${id} settled as ${meetup.status} with holds ${meetup.initiatorHold}/${meetup.recipientHold}, expected completed with both released`,
        );
      }
      assertRate(id);
      /* One completion is tier 2 against the device user, two are tier 3: read key by key, because
       * every field a tier adds is a required key (criterion 5, AAP 0.5.7). */
      const tier = output.pairCompletedBefore === false ? 2 : 3;
      const deviceUserId = e2e().actors[other(role)].userId;
      const profile = call(role, 'GET', `/users/${deviceUserId}`);
      if (profile.status !== 200 || !profile.data) fail('GET', `/users/${deviceUserId}`, profile);
      const has = (key) => Object.prototype.hasOwnProperty.call(profile.data, key);
      const disclosed =
        tier === 2 ? has('hasPhoto') && !has('fullName') : has('hasPhoto') && has('fullName');
      if (!disclosed) {
        throw new Error(
          `tier ${tier} expected from pairCompletedBefore=${String(output.pairCompletedBefore)}, but the profile carries hasPhoto=${has('hasPhoto')} fullName=${has('fullName')} externalContact=${has('externalContact')}`,
        );
      }
      console.log(`E2E_ASSERT_SETTLED ok meetup=${id} tier=${tier}`);
      break;
    }
    default:
      throw new Error(
        `unknown ACTION ${action === '' ? '(unset)' : action}; valid: signin, clear-pair, fresh-day, propose, accept, check-in, advance-to, settle, resolve-dispute, assert-settled`,
      );
  }
})();
