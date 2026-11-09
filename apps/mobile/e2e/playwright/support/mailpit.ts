/**
 * Reads a Tablemate magic-link email back out of Mailpit, so the end-to-end suite can sign an actor in
 * without a real inbox (AAP 0.3.3); criteria 1, 3 and 8 depend on it.
 *
 * `POST /v1/auth/magic-link` answers `202` and never reveals the token, so the link exists only in the
 * mail the `notifications` job delivers: `magicLinkUrl` writes `${WEB_ORIGIN}/auth/verify?token=` into the
 * message text. The fields read here are Mailpit v1.33.0's — `messages[].ID` and `Created` from
 * `/api/v1/search`, `Text` and `HTML` from `/api/v1/message/<id>`. The payload is narrowed from `unknown`,
 * `mailpitUrl` arrives as an argument, and nothing is logged: the token and the mail text stay in memory.
 */

/** How the caller asks for a link: the instant it recorded, Mailpit's origin, and its patience. */
export interface WaitForMagicLinkOptions {
  /** Epoch milliseconds recorded immediately before `POST /v1/auth/magic-link`. */
  since: number;
  /** How long to keep looking; 30 seconds when omitted. */
  timeoutMs?: number;
  /** Mailpit's HTTP origin, for example `http://localhost:8025`. */
  mailpitUrl: string;
  /** The actor's role (`actor-a`, `actor-b`, `operator`, `throwaway`), named only when timing out. */
  purpose?: string;
}

/** One captured email: the link as the message carries it, its token, and Mailpit's message id. */
export interface MagicLinkMessage {
  link: string;
  token: string;
  messageId: string;
}

// Defaults and bounds: the overall wait, the polling interval, one request's own ceiling, and the
// slack on `since` that absorbs the sub-second difference between Mailpit's clock and ours.
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;
const CLOCK_SLACK_MS = 1_000;

/** The link pattern: the `/auth/verify` route and `token` parameter that `magicLinkUrl` builds. */
const MAGIC_LINK_PATTERN = /https?:\/\/[^\s"'<>]+\/auth\/verify\?token=[A-Za-z0-9_\-.~%]+/;

/**
 * Waits for the magic-link email addressed to `email` and returns the link it carries: every 500 ms it
 * reads the newest message to that address received at or after `since` and looks for the link in the
 * body. A message without a usable link, an HTTP error, an unreachable container and an unparseable body
 * are all transient inside the deadline, which alone ends the wait.
 *
 * @throws Error when nothing arrives in time, naming the `purpose` only -- never the address, the token
 * or the mail text.
 */
export async function waitForMagicLink(
  email: string,
  options: WaitForMagicLinkOptions,
): Promise<MagicLinkMessage> {
  const { mailpitUrl, since, purpose } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin = mailpitUrl.replace(/\/+$/, '');
  const searchUrl = `${origin}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const budget = Math.min(REQUEST_TIMEOUT_MS, Math.max(deadline - Date.now(), 1));
    const newest = newestSince(await fetchJson(searchUrl, budget), since);
    if (newest !== undefined) {
      const messageUrl = `${origin}/api/v1/message/${encodeURIComponent(newest.id)}`;
      const message = magicLinkIn(await fetchJson(messageUrl, budget), newest.id);
      if (message !== undefined) {
        return message;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`magic link for ${purpose ?? 'e2e account'} not received within ${timeoutMs} ms`);
}

interface Candidate {
  id: string;
  created: number;
}

/** The newest message received at or after `since`; a body of another shape yields none. */
function newestSince(body: unknown, since: number): Candidate | undefined {
  const messages = propertyOf(body, 'messages');
  if (!Array.isArray(messages)) return undefined;
  const floor = since - CLOCK_SLACK_MS;
  let newest: Candidate | undefined;
  for (const message of messages) {
    const id = stringOf(propertyOf(message, 'ID'));
    const created = Date.parse(stringOf(propertyOf(message, 'Created')) ?? '');
    if (id === undefined || !Number.isFinite(created) || created < floor) continue;
    if (newest === undefined || created > newest.created) newest = { id, created };
  }
  return newest;
}

/** The magic link one message carries, or undefined when it carries none and polling continues. */
function magicLinkIn(detail: unknown, messageId: string): MagicLinkMessage | undefined {
  const text = stringOf(propertyOf(detail, 'Text'));
  const html = stringOf(propertyOf(detail, 'HTML'));
  // These messages are plain text under the project's templates, so the HTML part is a fallback, and
  // it is searched only after unescaping: what renders as `&` is written as `&amp;`.
  const match =
    MAGIC_LINK_PATTERN.exec(text ?? '') ??
    MAGIC_LINK_PATTERN.exec((html ?? '').replaceAll('&amp;', '&'));
  const link = match?.[0];
  if (link === undefined) return undefined;
  try {
    const token = new URL(link).searchParams.get('token');
    return token === null || token === '' ? undefined : { link, token, messageId };
  } catch {
    // A URL the parser refuses is no link, so the message stays "not received yet".
    return undefined;
  }
}

/**
 * One Mailpit GET as JSON, or undefined for any failure -- an HTTP error, a body that is not JSON, a
 * connection refused while the container starts. Each is transient inside the deadline.
 */
async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? ((await response.json()) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function propertyOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}
