/**
 * The traveler app's one WebSocket: pair chat and meetup-status pushes on `WS /v1/chat`.
 *
 * The session owns the socket, not a screen, and this module imports nothing from `src/auth` or
 * `src/state`, so the dependency runs one way and the three stay out of a cycle (AAP 0.5.1). It
 * authenticates with `Sec-WebSocket-Protocol: bearer, <accessToken>` — the only way a browser
 * `WebSocket` can carry the access token (AAP 0.3.3) — read from the auth hooks, never from storage,
 * a query parameter or a header. No frame is trusted and none is echoed: inbound frames are parsed
 * with {@link ServerFrame} and outbound ones with {@link ClientFrame}, an unreadable frame is dropped,
 * and a write is refused unless the socket is open, the runtime is online — a socket kept open by a
 * lost connection takes the write into a buffer nothing flushes — and the socket still holds the
 * session's current credential. That last one is the lifecycle this module owns: a socket is admitted
 * once, with the token held at its upgrade, while every REST `401` rotates the session and a rotation
 * revokes the session the socket was admitted with (AAP 0.11.2), so {@link send} drops a socket whose
 * token has been rotated away and writes the frame on a fresh one instead of handing the traveler's
 * message to a credential the server has already retired. An attempt opens only once the session
 * holds a token: with none, the installed `AuthHooks.ensureSession` is awaited first, exactly as
 * `./client` awaits it before the first authenticated read, and a gate that refuses leaves the socket
 * unopened rather than offering a handshake with an empty credential. A write the server still refuses
 * with `token_invalid` is transport rather than the end of the session: the frame is written again on
 * the socket the rotating reconnect opens, up to {@link RESEND_LIMIT} times, so a rotation landing
 * between one reconnect and its write cannot lose the traveler's message, and the rotation that
 * follows — or two unauthorized closes between opens — is what ends a session that is genuinely gone
 * (AAP 0.5.3). An upgrade the server refuses before the socket ever opens escalates to one rotation
 * per credential episode, so a refusal no rotation can fix cannot rotate for ever. The server is the
 * authority on access: messaging opens only once both deposits are locked (AAP 0.5.4). Nothing is
 * logged — no frame, body, token or event (AAP 0.11.1) — and importing the module has no side effect.
 */
import { onlineManager } from '@tanstack/react-query';
import {
  API_PATH_PREFIX,
  CHAT_PATH,
  ClientFrame,
  ServerFrame,
  WS_BEARER_SUBPROTOCOL,
  WS_CLOSE,
} from '@tablemate/shared';
import type { ChatSend } from '@tablemate/shared';
import { authHooks, refreshSession } from './client';
import { isApiError } from './errors';

/** The shortest gap between two connection attempts, in milliseconds. */
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** How long {@link send} waits for the socket it reopens to open before it refuses the write. */
const REOPEN_TIMEOUT_MS = 5_000;

/**
 * The close code our own {@link disconnect} sends: a normal closure (RFC 6455 §7.4.1), and this
 * module's own rather than one of the API's application-level codes, which are read from
 * `@tablemate/shared`'s {@link WS_CLOSE} — the one declaration the API that sends them and this
 * client that branches on them both import, so a code added or renumbered there compiles here.
 */
const CLOSE_NORMAL = 1000;
const READY_STATE_OPEN = 1;

/** How many consecutive closes before their socket ever opened make the next attempt rotate the session first. */
const REFUSED_OPENS_BEFORE_ROTATION = 2;

/**
 * How many times a frame the server refused with `token_invalid` is written again before its record is
 * dropped. A refusal is answered by one more write on the socket the rotating reconnect opens, and a
 * rotation that lands between that reconnect and its write refuses that one too, so the re-send re-arms
 * rather than being spent once — but only this many times: past it the unauthorized-close path is what
 * ends a session no rotation can fix, where writing again would keep offering the frame to a credential
 * that is not coming back.
 */
const RESEND_LIMIT = 2;

/**
 * What the socket is doing, so a screen can show "reconnecting" instead of a dead chat (AAP 0.3.3).
 * `limited` is the API refusing this socket while the account already holds its allowance of live
 * chat sockets on that instance (AAP 0.3.2): the socket stays down with nothing to retry on its own
 * until the traveler closes the other one, so a screen says why rather than showing an interruption.
 */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'limited';

/** The state most recently published to the listeners. */
let connectionState: ConnectionState = 'idle';
let socket: WebSocket | null = null;

/**
 * The access token the socket currently held was admitted with, or null when no socket is held. The
 * credential belongs to the socket rather than to the module: the session's token is rotated away by
 * every REST `401` (AAP 0.11.2), so comparing the two is what tells {@link send} whether the socket
 * it holds may still be written on.
 */
let openedWithToken: string | null = null;

/**
 * The payload of the last frame this module put on a socket, or null. Held until that write's fate is
 * known: a refusal the server answers with `token_invalid` is written again on the socket the rotating
 * reconnect opens, while {@link RESEND_LIMIT} allows it, and a refusal of any other kind drops it. The
 * server's own echo of the frame is what clears it once the write is stored, so a frame that reached the
 * wire is never written a second time — and no message body outlives the connection it was written on by
 * more than that.
 */
let lastWrite: string | null = null;

/** Whether the frame in {@link lastWrite} was refused as unauthenticated and still owes a re-send. */
let resendPending = false;

/** How many times the frame in {@link lastWrite} has been written again since it was refused, against {@link RESEND_LIMIT}. */
let resendAttempts = 0;

/** True from {@link connect} until {@link disconnect}: a close while it is true is an interruption. */
let desired = false;
let opening = false;
let failedAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refreshBeforeNextAttempt = false;
let refreshedSinceUnauthorized = false;
let unauthorizedCloses = 0;

/**
 * How many consecutive attempts have ended before their socket ever opened. One such close proves
 * nothing — an upgrade refused for a spent credential is answered as plain HTTP before the upgrade,
 * which a browser reports exactly like an unreachable socket (AAP 0.3.3) — so a single one is retried
 * with the credential it carried; two in a row are what {@link attach} escalates to one rotation.
 */
let refusedOpens = 0;

/** The handlers attached to the socket currently held, removed when it is discarded. */
let attached: { socket: WebSocket; detach: () => void } | null = null;
const frameListeners = new Set<(frame: ServerFrame) => void>();
const stateListeners = new Set<(state: ConnectionState) => void>();
/**
 * Subscribes to the frames the API pushes. Listeners stay registered across connects and disconnects, and each is
 * called in isolation, so one that throws neither stops the others nor breaks the socket.
 */
export function subscribe(listener: (frame: ServerFrame) => void): () => void {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}

/** Subscribes to connection-state changes (AAP 0.3.3), which the chat screen renders so a traveler waiting on a dropped connection is told it is reconnecting rather than shown as sent. */
export function subscribeConnectionState(listener: (state: ConnectionState) => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export function getConnectionState(): ConnectionState {
  return connectionState;
}

/**
 * Opens the chat socket, or does nothing when one is already connecting, open or waiting to be retried
 * (AAP 0.3.3). Idempotent, so a caller may invoke it after every sign-in and bootstrap; with no hooks,
 * no `EXPO_PUBLIC_WS_URL`, or a session the gate below refuses, the state stays `idle` rather than
 * throwing. Reconnecting after a failure is this module's own job and needs no further call — except
 * for a session this module holds no token for, which the session module is to install and with it to
 * call {@link connect} again — and the one close this module does not retry on its own, the account's
 * socket allowance (`limited`), which the caller retries by invoking this again.
 */
export function connect(): void {
  desired = true;
  if (socket !== null || opening || reconnectTimer !== null) return;
  void openSocket();
}

/**
 * Whether the runtime currently has a connection. Deliberately the query layer's own signal, because `onlineManager`
 * is what React Query consults, so this answer and the one the query layer acts on cannot disagree. On a platform that
 * raises no connectivity events the manager reports online and the socket's own `readyState` is what refuses a write.
 */
export function isOnline(): boolean {
  return onlineManager.isOnline();
}

/**
 * Sends one chat message for a meetup (AAP 0.3.3, AAP 0.5.4, `ChatSend`), and answers false when the
 * frame was not written: it is validated with the shared {@link ClientFrame}, so an empty,
 * whitespace-only or over-long body is refused here rather than answered by the server, and it is
 * refused while the runtime is offline or while no socket can be written on.
 *
 * The socket is written on only while it holds the session's current credential, which is what the
 * awaited answer is for. A socket whose token a rotation has replaced would be answered by the server
 * with `token_invalid` and closed `4401` — the message never stored — after the caller had already
 * handed its text over, so such a socket is dropped and the frame is written on a fresh one opened
 * with the current token instead. A socket whose credential is current is written to as before. There
 * is no local echo and no offline queue — a socket kept open by a lost connection accepts a write into
 * its own send buffer and then drops it with the browser tab — so a caller refused here keeps its text
 * and reports the failure.
 */
export async function send(meetupId: string, body: string): Promise<boolean> {
  const frame: ChatSend = { type: 'chat_send', meetupId, body };
  const checked = ClientFrame.safeParse(frame);
  if (!checked.success) return false;
  // The parsed frame, not the input: what was validated is what is sent, trimming included.
  const payload = JSON.stringify(checked.data);
  // A socket holds `readyState` 1 while the connection is down, so the write below would land in
  // its send buffer: nothing would be delivered, the tab would lose the message, and the traveler
  // would be told nothing. Refusing is what lets the chat screen keep the draft and report the
  // failure (AAP 0.5.4).
  if (!isOnline()) return false;

  const current = socket;
  // Nothing to write on: no socket is held, or the one held has not opened or has already closed,
  // and a caller refused here keeps its text rather than losing it into a socket's send buffer.
  if (current === null || current.readyState !== READY_STATE_OPEN) return false;
  if (openedWithToken === accessToken()) return writeForSend(current, payload);
  const reopened = await reopenWithCurrentToken(current);
  return reopened !== null && writeForSend(reopened, payload);
}

/** Writes one validated payload on a socket, and answers whether the write happened. */
function writeFrame(target: WebSocket, payload: string): boolean {
  if (target.readyState !== READY_STATE_OPEN) return false;
  try {
    target.send(payload);
    return true;
  } catch {
    // The socket closed between the check above and the write. Nothing is queued; the caller can retry after the reconnect.
    return false;
  }
}

/**
 * Writes the caller's validated payload and keeps it as the frame the last write put on the wire, so a
 * refusal the server answers with `token_invalid` can be written again on the socket that replaces this
 * one. The record is replaced here and its re-send count starts over, because the frame it held was this
 * caller's and nothing of that frame is owed any more. It is cleared in {@link receive} once the server
 * echoes the frame back — the write is stored, so writing it again would store it twice — when
 * {@link attach} reaches {@link RESEND_LIMIT}, on a refusal of any other kind, and by {@link disconnect}
 * when the session ends.
 */
function writeForSend(target: WebSocket, payload: string): boolean {
  if (!writeFrame(target, payload)) return false;
  lastWrite = payload;
  resendPending = false;
  resendAttempts = 0;
  return true;
}

/**
 * Drops the open socket whose credential a rotation has replaced and opens a fresh one (AAP 0.11.2).
 * Answers the socket once it is open and null when none could be opened, in which case the caller keeps
 * its text. The wait is bounded by {@link REOPEN_TIMEOUT_MS}, so a socket that never opens cannot hold
 * a send open indefinitely.
 */
async function reopenWithCurrentToken(stale: WebSocket): Promise<WebSocket | null> {
  discard(stale);
  try {
    stale.close(CLOSE_NORMAL);
  } catch {
    // Already closed: the socket is gone either way, and its handlers are detached.
  }
  await openSocket();
  const created = socket;
  if (created === null) return null;
  return created.readyState === READY_STATE_OPEN ? created : await waitForOpen(created);
}

/**
 * Waits for a socket this module just opened to reach `open`, for at most {@link REOPEN_TIMEOUT_MS}.
 * The wait follows the state this module publishes rather than the socket's own handlers, which
 * {@link attach} owns: an attempt that fails, or a socket a reconnect replaced meanwhile, answers null
 * instead of holding the write open.
 */
function waitForOpen(created: WebSocket): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let subscription: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: WebSocket | null): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (subscription !== null) {
        subscription();
        subscription = null;
      }
      resolve(value);
    };
    const settle = (): void => {
      if (socket !== created) {
        finish(null);
        return;
      }
      if (created.readyState === READY_STATE_OPEN) finish(created);
    };
    subscription = subscribeConnectionState(settle);
    timer = setTimeout(() => finish(null), REOPEN_TIMEOUT_MS);
    // The socket may already have opened while this wait was being set up.
    settle();
  });
}

/**
 * Closes the socket and stops reconnecting (AAP 0.3.3). A pending reconnect is cancelled and the
 * backoff and unauthorized counters are cleared; registered listeners are left in place, because they
 * belong to the session's lifetime rather than to a socket's.
 */
export function disconnect(): void {
  desired = false;
  clearReconnect();
  const closing = socket;
  if (closing !== null) {
    discard(closing);
    try {
      closing.close(CLOSE_NORMAL);
    } catch {
      // Already closed: the socket is gone either way, and its handlers are detached.
    }
  }
  refreshBeforeNextAttempt = false;
  refreshedSinceUnauthorized = false;
  unauthorizedCloses = 0;
  refusedOpens = 0;
  failedAttempts = 0;
  // Nothing of a write outlives the session it belonged to.
  lastWrite = null;
  resendPending = false;
  resendAttempts = 0;
  setState('idle');
}

/** Opens one socket for the current session, rotating the session first when the last close looked unauthorized. Never rejects, and never throws at the caller. */
async function openSocket(): Promise<void> {
  opening = true;
  try {
    if (!desired) return;
    if (refreshBeforeNextAttempt) {
      refreshBeforeNextAttempt = false;
      const rotation = await rotateSession();
      if (rotation === 'signed_out') return;
      if (rotation === 'failed') {
        // Nothing was opened and nothing was refused, so the session may still be good — a lost connection, most often.
        refreshBeforeNextAttempt = true;
        scheduleReconnect();
        return;
      }
    }
    // The session may have ended while the rotation was in flight.
    if (!desired || socket !== null) return;
    const base = wsBaseUrl();
    if (base === null) {
      setState('idle');
      return;
    }
    // The token the handshake is offered, behind the same gate `./client` awaits: on a cold start the
    // restore may still be running, and a handshake carrying no credential is refused at the HTTP
    // layer (401) before the upgrade, which the browser reports as a connection error (AAP 0.3.3). A
    // gate that refuses opens nothing and schedules nothing: the session module calls `connect` again
    // once it installs one, so a refused restore cannot become a retry loop of its own.
    const token = await sessionToken();
    if (!desired || socket !== null) return;
    if (token === null) {
      setState('idle');
      return;
    }
    let created: WebSocket;
    try {
      created = new WebSocket(`${base}${API_PATH_PREFIX}${CHAT_PATH}`, [
        WS_BEARER_SUBPROTOCOL,
        token,
      ]);
    } catch {
      // A base the platform cannot parse. Retried like any other interruption, and never logged.
      scheduleReconnect();
      return;
    }
    socket = created;
    // Recorded so a write can tell a socket that still holds the session's credential from one a
    // rotation has replaced (AAP 0.11.2).
    openedWithToken = token;
    setState('connecting');
    attach(created);
  } finally {
    opening = false;
  }
}

/**
 * Attaches the four handlers to a socket and records how to remove them again. Every handler first checks that the
 * socket is still the one this module holds, so a late event from a discarded socket cannot change the state or
 * deliver a frame twice.
 */
function attach(created: WebSocket): void {
  /** Whether this socket ever reached `open`, which is what tells a refused upgrade from an interruption. */
  let everOpened = false;
  const handleOpen = (): void => {
    if (socket !== created) return;
    everOpened = true;
    failedAttempts = 0;
    unauthorizedCloses = 0;
    refusedOpens = 0;
    refreshedSinceUnauthorized = false;
    refreshBeforeNextAttempt = false;
    // The fate of the last write is decided here, on the socket that replaced the one it was refused
    // on: a frame the server answered `token_invalid` is written again — the reconnect that follows
    // that refusal has rotated the session, which is what the write needed — and its record is kept,
    // because a rotation landing between that reconnect and this write refuses the re-send as well,
    // and that refusal has to re-arm rather than lose the traveler's message. The record is dropped
    // once RESEND_LIMIT re-sends have been made: a refusal no rotation can fix is the
    // unauthorized-close path's to end by then, never this module's to write again (AAP 0.5.3).
    const owed =
      resendPending && lastWrite !== null && resendAttempts < RESEND_LIMIT ? lastWrite : null;
    if (owed === null) {
      lastWrite = null;
    } else {
      resendAttempts += 1;
    }
    resendPending = false;
    setState('open');
    if (owed !== null) writeFrame(created, owed);
  };
  const handleMessage = (event: MessageEvent): void => {
    if (socket !== created) return;
    receive(event.data);
  };
  const handleError = (): void => {
    // Nothing to do: a browser and React Native both follow an error with a close, which decides what happens next.
  };
  const handleClose = (event: CloseEvent): void => {
    if (socket !== created) return;
    discard(created);
    // A close that arrives before this socket ever opened is what a refused upgrade looks like from a
    // browser: a spent credential is answered as plain HTTP before the upgrade, and the platform
    // reports that like an unreachable socket — a close, usually 1006 (AAP 0.3.3). A socket that did
    // open, and then ended, resets the count: the two are not the same event.
    refusedOpens = everOpened ? 0 : refusedOpens + 1;
    // Our own close, or an orderly one from the platform: no reason to come back.
    if (!desired || event.code === CLOSE_NORMAL) {
      setState('idle');
      return;
    }
    // 4403 is the server refusing this traveler outright — a block, or a meetup that is not theirs —
    // so retrying would be refused again (AAP 0.5.4).
    if (event.code === WS_CLOSE.forbidden) {
      setState('idle');
      return;
    }
    // 4429 is the API refusing this socket because the account already holds its allowance of live
    // chat sockets on that instance (AAP 0.3.2, AAP 0.5.4). The account's other sockets keep serving
    // its chat and the allowance is released as one of them closes, so re-dialling this one on the
    // backoff below would only hammer a refusal that repeats: the socket stays down and the state
    // says why until the traveler closes the other socket and asks again from the screen.
    if (event.code === WS_CLOSE.tooMany) {
      setState('limited');
      return;
    }
    // A refusal the API itself labelled unauthorized: the close code says the session is not live, or
    // a `token_invalid` frame arrived before the close. A close before `open` is deliberately not one
    // of those on its own, because one of them is not evidence about the session.
    const unauthorized =
      event.code === WS_CLOSE.unauthorized ||
      event.code === WS_CLOSE.invalidated ||
      refreshBeforeNextAttempt;
    if (unauthorized) {
      unauthorizedCloses += 1;
      if (refreshedSinceUnauthorized && unauthorizedCloses >= 2) {
        // Both closes were the API's own unauthorized refusals with a rotation in between — which only a live session
        // permits — so the session itself is gone: the refresh token was revoked, or the account was deleted.
        void signOutAndStop();
        return;
      }
      refreshBeforeNextAttempt = true;
    } else if (refusedOpens >= REFUSED_OPENS_BEFORE_ROTATION && !refreshedSinceUnauthorized) {
      // A credential the server refused twice in a row before the socket ever opened is a credential
      // problem rather than a lost connection, so the next attempt rotates the session first and
      // opens with the token that rotation installs. The `refreshedSinceUnauthorized` guard keeps
      // that to one rotation per credential episode: a rotation raises it and only a successful open
      // lowers it, so a refusal a rotation cannot fix — a role, consent or age-gate refusal, say —
      // is retried on the backoff below instead of rotating for ever (AAP 0.3.3).
      refreshBeforeNextAttempt = true;
    }
    scheduleReconnect();
  };
  created.onopen = handleOpen;
  created.onmessage = handleMessage;
  created.onerror = handleError;
  created.onclose = handleClose;
  attached = {
    socket: created,
    detach: () => {
      created.onopen = null;
      created.onmessage = null;
      created.onerror = null;
      created.onclose = null;
    },
  };
}

function discard(created: WebSocket): void {
  const current = attached;
  if (current !== null && current.socket === created) {
    current.detach();
    attached = null;
  }
  if (socket === created) {
    // The credential goes with the socket it was admitted with, so a later write can never be
    // attributed to a connection this module no longer holds.
    socket = null;
    openedWithToken = null;
  }
}

// --- Receiving --------------------------------------------------------------------------------

/**
 * The meetup and body the held write was made for, or null when nothing is held or the record cannot be
 * read as the frame it was written from. The payload is re-read through {@link ClientFrame}, the schema
 * that validated it on the way out, so what the server's echo is matched against is the frame this
 * module actually wrote.
 */
function heldWrite(): { meetupId: string; body: string } | null {
  if (lastWrite === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(lastWrite);
  } catch {
    // A record written by `writeForSend` is always JSON, so this cannot happen: a record that cannot be
    // read is no record, and the re-send it would have owed is dropped rather than guessed at.
    return null;
  }
  const frame = ClientFrame.safeParse(decoded);
  return frame.success ? { meetupId: frame.data.meetupId, body: frame.data.body } : null;
}

/** Parses one inbound payload and delivers it to the listeners (AAP 0.3.3, AAP 0.5.4). */
function receive(payload: unknown): void {
  if (typeof payload !== 'string') return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return;
  }
  const frame = ServerFrame.safeParse(decoded);
  // A frame this client cannot read — one from a newer API, or not a frame at all — is dropped; it is never forwarded.
  if (!frame.success) return;
  const value: ServerFrame = frame.data;
  if (value.type === 'error') {
    if (value.code === 'token_invalid') {
      // The write just made was refused because the session no longer authenticates it, and the
      // server closes with 4401 next, so the socket cannot continue: rotate before the next attempt
      // (AAP 0.5.3), and remember the frame so it is written again on the socket that reconnect opens
      // — as often as RESEND_LIMIT allows, since the rotation that follows may refuse it once more —
      // rather than lost with the credential it was refused on.
      refreshBeforeNextAttempt = true;
      resendPending = lastWrite !== null;
    } else {
      // Refused for a reason a reconnect cannot change — a block, a pair that may not chat, a write
      // over the allowance, an unreadable frame — so nothing of it is owed to the wire.
      lastWrite = null;
      resendPending = false;
    }
  } else if (value.type === 'message') {
    // A stored message came back (AAP 0.5.4): the publish reaches both participants, so the sender's own
    // socket carries the message it just wrote, and that echo is the confirmation of the write. The
    // record is cleared here because a reconnect writes it again on the socket it opens — a record that
    // outlived its stored write would store a second copy of it. The match is the meetup and the body,
    // which is what that write's own frame carries: another frame with the same body would stop a
    // re-send early, and stopping a re-send cannot duplicate a stored message, where clearing late can.
    const held = heldWrite();
    if (
      held !== null &&
      held.meetupId === value.message.meetupId &&
      held.body === value.message.body
    ) {
      lastWrite = null;
      resendPending = false;
      resendAttempts = 0;
    }
  }
  for (const listener of [...frameListeners]) {
    try {
      listener(value);
    } catch {
      // One failing listener must not stop the others, and it must not break the socket.
    }
  }
}

/** Schedules the next attempt with full-jitter exponential backoff, floored at 1 s, capped at 30 s. */
function scheduleReconnect(): void {
  if (!desired) return;
  clearReconnect();
  const ceiling = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** failedAttempts);
  const delay = Math.max(MIN_BACKOFF_MS, Math.floor(Math.random() * ceiling));
  failedAttempts += 1;
  setState('reconnecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openSocket();
  }, delay);
}

function clearReconnect(): void {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Rotates the session before a reconnect, through the single flight shared with the REST client, so one refresh token is
 * spent once whatever else is retrying (AAP 0.3.3, AAP 0.11.2). `failed` is a rotation that failed for a reason other
 * than a refusal, and `signed_out` one refused with `401 token_invalid`, the session already cleared.
 */
async function rotateSession(): Promise<'rotated' | 'failed' | 'signed_out'> {
  try {
    await refreshSession();
    refreshedSinceUnauthorized = true;
    return 'rotated';
  } catch (error) {
    // A refusal means the refresh token is spent or revoked: reuse detection revokes the session that presented a
    // rotated token, so there is no session left to reconnect for.
    if (isApiError(error) && error.status === 401 && error.code === 'token_invalid') {
      await signOutAndStop();
      return 'signed_out';
    }
    return 'failed';
  }
}

/**
 * Ends the session: the hooks clear it and the socket stops reconnecting (AAP 0.5.3). `onSignedOut` is idempotent by
 * contract and `src/auth/session.ts` calls {@link disconnect} from it as well, so the second call here is harmless.
 */
async function signOutAndStop(): Promise<void> {
  const hooks = authHooks();
  if (hooks !== null) {
    try {
      await hooks.onSignedOut();
    } catch {
      // Signing out must never mask the refusal that caused it, and it is never retried.
    }
  }
  disconnect();
}

/**
 * The WebSocket base the chat path is appended to, or null when the build configured none.
 *
 * `process.env.EXPO_PUBLIC_WS_URL` is read by direct static member access on purpose — `babel-preset-expo` inlines only
 * that form — and read per call rather than at module load, so importing this module needs no environment.
 */
function wsBaseUrl(): string | null {
  // Kept as one direct member access and narrowed by hand, as in `./client`: an environment read arrives as `any`
  // under the Expo program's types.
  const configured: unknown = process.env.EXPO_PUBLIC_WS_URL;
  const base = typeof configured === 'string' ? configured.trim().replace(/\/+$/, '') : '';
  return base === '' ? null : base;
}

function accessToken(): string | null {
  const hooks = authHooks();
  if (hooks === null) return null;
  const token = hooks.getAccessToken();
  // An empty token is no token: `['bearer', '']` would be a handshake with nothing to authenticate.
  return token === null || token === '' ? null : token;
}

/**
 * The access token an attempt may open with, once the session holds one (AAP 0.3.3). A token already
 * held is used as it is. With none, the installed `AuthHooks.ensureSession` is awaited first — the same
 * gate `./client` awaits before the first authenticated read of a cold load — so a restore that is
 * still running finishes before the handshake is offered, and one that would refuse it is answered
 * with null rather than a socket carrying an empty credential. The failure itself is the session
 * module's to report, and its rejection is deliberately not retried here.
 */
async function sessionToken(): Promise<string | null> {
  const held = accessToken();
  if (held !== null) return held;
  const hooks = authHooks();
  if (hooks === null || hooks.ensureSession === undefined) return null;
  try {
    await hooks.ensureSession();
  } catch {
    return null;
  }
  return accessToken();
}

/** Moves to `next` and tells the state listeners, each isolated from the others. */
function setState(next: ConnectionState): void {
  if (connectionState === next) return;
  connectionState = next;
  for (const listener of [...stateListeners]) {
    try {
      listener(next);
    } catch {
      // A failing listener must not stop the others or disturb the socket.
    }
  }
}
