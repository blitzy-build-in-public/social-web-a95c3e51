/* global http, json, output, EMAIL, ROLE, API_URL, MAILPIT_URL */
/*
 * Reads the Tablemate magic-link email for one actor out of Mailpit (AAP 0.3.3) and puts its token in
 * `output.token` — the value a native flow embeds unchanged in `tablemate://auth/verify?token=…`, the deep
 * link `app/auth/verify.tsx` parses. Criteria 1 and 8 sign in through it.
 *
 * Flow env: `EMAIL`, `API_URL` (the API origin) and `MAILPIT_URL` (Mailpit's origin) are required; `ROLE` is
 * an optional label used in failure messages alone and defaults to `account`. `POST /auth/magic-link` is sent
 * exactly once and never retried: the route allows 5 links an hour per address, and the web suite and the
 * sibling native flows spend the same budget. No message raised here carries the address, the link, the token
 * or the mail text.
 */
(function () {
  'use strict';
  /* The token is a base64url value of 43 characters, minted by `randomToken`, whose alphabet
   * `encodeURIComponent` never escapes; the class also ends the capture at the link's delimiter. */
  const TOKEN_PATTERN = /\/auth\/verify\?token=([A-Za-z0-9_-]+)/;
  const POLL_ATTEMPTS = 60;
  const POLL_PAUSE_MS = 500;
  const email = required('EMAIL', typeof EMAIL === 'undefined' ? '' : String(EMAIL));
  const apiUrl = `${required('API_URL', typeof API_URL === 'undefined' ? '' : String(API_URL)).replace(/\/+$/, '')}/v1`;
  const mailpitUrl = required(
    'MAILPIT_URL',
    typeof MAILPIT_URL === 'undefined' ? '' : String(MAILPIT_URL),
  ).replace(/\/+$/, '');
  const role = typeof ROLE === 'undefined' || ROLE === '' ? 'account' : String(ROLE);
  const search = `/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=5`;
  /** One Mailpit read parsed as JSON. Its failure names Mailpit's origin and nothing else, because a
   * request URL and a search body both carry the actor's address (AAP 0.11.1). */
  function mailpitGet(path) {
    let response;
    try {
      response = http.get(mailpitUrl + path);
    } catch {
      throw mailpitDown('no response');
    }
    if (!response.ok) throw mailpitDown(`HTTP ${response.status}`);
    try {
      return json(response.body);
    } catch {
      throw mailpitDown('a body that is not JSON');
    }
  }
  function mailpitDown(reason) {
    return new Error(`Mailpit unreachable at ${mailpitUrl} (${reason})`);
  }
  /** The newest message id in Mailpit's search response — ordered newest first — or `''`. */
  function newestId() {
    const messages = mailpitGet(search).messages;
    const newest = Array.isArray(messages) ? messages[0] : undefined;
    return newest !== undefined && typeof newest.ID === 'string' ? newest.ID : '';
  }
  /** The token inside the message with `id`, or `''`: `Text` first, then `HTML` with `&amp;`
   * unescaped, since the template's plain-text part carries the link on a line of its own. */
  function tokenOf(id) {
    const message = mailpitGet(`/api/v1/message/${encodeURIComponent(id)}`);
    const text = typeof message.Text === 'string' ? message.Text : '';
    const html = typeof message.HTML === 'string' ? message.HTML.replace(/&amp;/g, '&') : '';
    const match = TOKEN_PATTERN.exec(text) || TOKEN_PATTERN.exec(html);
    return match === null ? '' : decodeURIComponent(match[1]);
  }
  /** The `error.code` of a failure envelope (AAP 0.5.4), or `no_code` when the body carries none. */
  function codeOf(response) {
    try {
      const error = json(response.body).error;
      return typeof error?.code === 'string' ? error.code : 'no_code';
    } catch {
      return 'no_code';
    }
  }
  /** A required flow variable, refused by name and never by value. */
  function required(name, value) {
    if (value === '') throw new Error(`read-magic-link.js needs the ${name} flow variable`);
    return value;
  }
  /** A bounded busy-wait between polls: Maestro's GraalJS exposes no timers. */
  function pause(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* busy-wait */
    }
  }
  /* The newest message before the request: the awaited one has to differ from it, which is what makes
   * a polled message this request's answer rather than a link left by an earlier run. */
  const seen = newestId();
  const posted = http.post(`${apiUrl}/auth/magic-link`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (posted.status === 429) {
    throw new Error(
      `magic-link limit reached for ${role} (429 rate_limited): at most 5 links per email per hour — wait or reset the stack`,
    );
  }
  if (posted.status !== 202) {
    throw new Error(
      `POST /auth/magic-link for ${role} failed: HTTP ${posted.status} ${codeOf(posted)}`,
    );
  }
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const id = newestId();
    if (id !== '' && id !== seen) {
      const token = tokenOf(id);
      if (token === '') throw new Error(`magic-link email for ${role} has no /auth/verify link`);
      // The flows put this straight into `tablemate://auth/verify?token=${output.token}`.
      output.token = token;
      return;
    }
    pause(POLL_PAUSE_MS);
  }
  throw new Error(
    `no magic-link email for ${role} within 30 s — check the workers notifications job and Mailpit`,
  );
})();
