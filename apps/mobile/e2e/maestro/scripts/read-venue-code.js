/* global http, json, output, API_URL */
/*
 * Reads the venue's current check-in code for the native criterion-1 flows (AAP 0.11.2; criterion 1
 * of AAP 0.12.1) and puts the pair the check-in screen needs in `output.code` and
 * `output.codeExpiresAt`. The flows run this immediately before typing the code on the device, and
 * before `api-actor.js ACTION=check-in`.
 *
 * Flow env: `API_URL`, the API origin, is required. Input: `output.e2e.venue.secret`, written by
 * `pnpm --filter @tablemate/mobile e2e:prepare` into `.local/e2e/fixture-proofs.js`, which the flow
 * runScripts first. Outputs: `output.code` and `output.codeExpiresAt`.
 *
 * The code is the server's alone — HKDF-SHA256 keyed by the venue secret, the counter of the current
 * 60-second step, accepted at T-1, T and T+1 and validated on the server clock only (AAP 0.5.7) — so
 * device clock skew moves nothing here. No message below carries the secret or the code (AAP 0.11.1).
 */
(function () {
  'use strict';

  const PATH = '/v1/venue/check-in-code';

  /* The shared `VENUE_SECRET_HEADER` of packages/shared/src/schemas/consoles.ts, restated: Maestro's
   * GraalJS sandbox has no imports, so this literal is the one place the name is spelled out. */
  const SECRET_HEADER = 'X-Venue-Secret';

  const apiUrl = (typeof API_URL === 'undefined' ? '' : String(API_URL)).replace(/\/+$/, '');
  if (apiUrl === '') throw new Error('read-venue-code.js needs the API_URL flow variable');

  const fixture = typeof output === 'undefined' ? undefined : output.e2e;
  const secret = fixture !== undefined && fixture.venue ? fixture.venue.secret : '';
  if (typeof secret !== 'string' || secret === '') {
    throw new Error(
      'fixture data missing — the flow must runScript .local/e2e/fixture-proofs.js first ' +
        '(written by pnpm --filter @tablemate/mobile e2e:prepare)',
    );
  }

  /** The `error.code` of a failure envelope (AAP 0.5.4), or `no_code` when the body carries none. */
  function codeOf(failure) {
    try {
      const error = json(failure.body).error;
      return typeof error?.code === 'string' ? error.code : 'no_code';
    } catch {
      return 'no_code';
    }
  }

  let response;
  try {
    response = http.get(apiUrl + PATH, { headers: { [SECRET_HEADER]: secret } });
  } catch {
    throw new Error(`no response from the API at ${apiUrl}`);
  }

  if (response.status === 401) {
    /* A 401 here is always `bad_venue_secret` (AAP 0.5.4). The web harness may have replaced the
     * secret through `POST /v1/admin/venues/:id/secret`, so reread the fixture rather than guess. */
    throw new Error('venue secret rejected — rerun e2e:prepare');
  }

  if (response.status !== 200) {
    throw new Error(`GET ${PATH} failed: HTTP ${response.status} ${codeOf(response)}`);
  }

  let body;
  try {
    body = json(response.body);
  } catch {
    throw new Error('unexpected check-in-code response shape');
  }

  const code = body?.code;
  const expiresAt = body?.expiresAt;
  if (
    typeof code !== 'string' ||
    !/^\d{6}$/.test(code) ||
    typeof expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new Error('unexpected check-in-code response shape');
  }

  output.code = code;
  output.codeExpiresAt = expiresAt;
})();
