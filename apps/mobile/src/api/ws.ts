/**
 * The traveler app's one WebSocket: pair chat and meetup-status pushes on `WS /v1/chat`
 * (AAP 0.1.1 requirement 9, AAP 0.3.3, AAP 0.5.4, AAP 0.8.1).
 *
 * One socket serves every meetup and every screen, and the session owns it rather than a screen:
 * `src/auth/session.ts` calls {@link connect} once a session exists and {@link disconnect} when it
 * ends, and `src/state/meetup-store.ts` subscribes to the frames so it can refetch what it caches.
 * This module therefore imports nothing from `src/auth` or `src/state` — the dependency runs from
 * those modules into here, which keeps the three out of a cycle (AAP 0.5.1).
 *
 * Four invariants hold here:
 *
 *   - The socket authenticates with the `Sec-WebSocket-Protocol: bearer, <accessToken>`
 *     subprotocol, the only way a browser `WebSocket` can carry the access token (AAP 0.3.3). The
 *     token is read from the auth hooks injected through `configureAuth` in `./client`, never from
 *     storage, a query parameter or a header.
 *   - No frame is trusted and none is echoed: every inbound frame is parsed with the shared
 *     {@link ServerFrame} and an unreadable one is dropped, while {@link send} validates its own
 *     frame with {@link ClientFrame} so what leaves is exactly what was checked. It writes only to
 *     an open socket while the runtime is online ({@link isOnline}), so a frame nothing can deliver
 *     is refused instead of left in a buffer nothing flushes. The server is the authority on access
 *     — messaging opens only once both deposits are locked (AAP 0.5.4).
 *   - Nothing is logged: no frame, no message body, no token, no close or error event (AAP 0.11.1).
 *   - Importing this module has no side effect and touches no platform global until {@link connect}
 *     runs, so a Node test can import it with no environment configured.
 */
import { onlineManager } from '@tanstack/react-query';
import { ClientFrame, ServerFrame, WS_BEARER_SUBPROTOCOL } from '@tablemate/shared';
import type { ChatSend } from '@tablemate/shared';

import { authHooks, refreshSession } from './client';
import { isApiError } from './errors';

/** The chat path appended to the configured base (AAP 0.5.4). */
const CHAT_PATH = '/v1/chat';

/** The shortest gap between two connection attempts, in milliseconds. */
const MIN_BACKOFF_MS = 1_000;

/** The longest gap between two connection attempts, in milliseconds. */
const MAX_BACKOFF_MS = 30_000;

/** The close code our own {@link disconnect} sends: a normal closure (RFC 6455 §7.4.1). */
const CLOSE_NORMAL = 1000;

/**
 * The `readyState` of an open socket, as a number rather than through `WebSocket.OPEN`: a static is
 * a property of whichever implementation the platform supplies, while the value is fixed by the
 * WHATWG specification.
 */
const READY_STATE_OPEN = 1;

/**
 * The close codes the API sends on the chat socket (`WS_CLOSE` in
 * `apps/api/src/plugins/websocket.ts`): `4401` unauthorized, `4403` forbidden, `4409` invalidated
 * — sessions revoked by account deletion or refresh-token reuse — and `4429` too many sockets. The
 * API's module is not importable from the client bundle, so the numeric contract is restated here.
 */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_INVALIDATED = 4409;

/**
 * What the socket is doing, so a screen can show "reconnecting" instead of a dead chat
 * (AAP 0.3.3).
 */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting';

/** The state most recently published to the listeners. */
let connectionState: ConnectionState = 'idle';

/** The socket currently held, or null. Cleared as soon as a socket is discarded. */
let socket: WebSocket | null = null;

/** True from {@link connect} until {@link disconnect}: a close while it is true is an interruption. */
let desired = false;

/** True while an attempt is opening a socket, so a second {@link connect} cannot open another. */
let opening = false;

/** How many consecutive attempts have failed, which sets the next backoff ceiling. */
let failedAttempts = 0;

/** The scheduled reconnect, or null. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether the next attempt must rotate the session before it opens a socket. */
let refreshBeforeNextAttempt = false;

/** Whether a rotation has succeeded since the last successful open. */
let refreshedSinceUnauthorized = false;

/** How many consecutive unauthorized closes have happened since the last successful open. */
let unauthorizedCloses = 0;

/** The handlers attached to the socket currently held, removed when it is discarded. */
let attached: { socket: WebSocket; detach: () => void } | null = null;

/** Everyone waiting for frames: the meetup store, the chat screen. */
const frameListeners = new Set<(frame: ServerFrame) => void>();

/** Everyone waiting for connection-state changes. */
const stateListeners = new Set<(state: ConnectionState) => void>();

// --- Listener registration (AAP 0.3.3) ---------------------------------------------------------

/**
 * Subscribes to the frames the API pushes (AAP 0.3.3, AAP 0.5.4): a stored chat message, a meetup
 * status change, or a refusal such as `messaging_locked`, `blocked` or `rate_limited`.
 *
 * Listeners stay registered across connects and disconnects, because the session outlives a socket;
 * {@link disconnect} does not clear them. Each listener is called in isolation, so one that throws
 * neither stops the others nor breaks the socket.
 *
 * @returns The function that removes this listener.
 */
export function subscribe(listener: (frame: ServerFrame) => void): () => void {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}

/**
 * Subscribes to connection-state changes (AAP 0.3.3), which the chat screen renders so a traveler
 * waiting on a dropped connection is told it is reconnecting rather than shown as sent.
 *
 * @returns The function that removes this listener.
 */
export function subscribeConnectionState(listener: (state: ConnectionState) => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** The current connection state, for a caller that cannot wait for the next change (AAP 0.3.3). */
export function getConnectionState(): ConnectionState {
  return connectionState;
}

// --- Connect, send, disconnect (AAP 0.3.3, AAP 0.5.4) ------------------------------------------

/**
 * Opens the chat socket, or does nothing when one is already connecting, open or waiting to be
 * retried (AAP 0.3.3).
 *
 * Idempotent, so `src/auth/session.ts` may call it after every sign-in and bootstrap and
 * `app/_layout.tsx` may call it as well. With no hooks installed or no access token there is nothing
 * to authenticate, so the state stays `idle` rather than throwing; an unset `EXPO_PUBLIC_WS_URL`
 * behaves the same way. Reconnecting after a failure is this module's own job and needs no further
 * call.
 */
export function connect(): void {
  desired = true;
  if (socket !== null || opening || reconnectTimer !== null) return;
  void openSocket();
}

/**
 * Whether the runtime currently has a connection — the app's one connectivity answer (AAP 0.3.3).
 *
 * It is deliberately the query layer's own answer rather than a second opinion: `onlineManager` is
 * the connectivity signal React Query itself consults, and `QueryClientProvider` mounting the client
 * is what registers its `window` `online` and `offline` listeners — so this answer and the one the
 * query layer acts on cannot disagree.
 *
 * On a platform that raises no such events the manager reports online and the socket's own
 * `readyState` is what refuses a write; {@link send} reads both, and refuses when either says so.
 *
 * @returns True while the runtime reports a connection.
 */
export function isOnline(): boolean {
  return onlineManager.isOnline();
}

/**
 * Sends one chat message for a meetup (AAP 0.3.3, AAP 0.5.4, `ChatSend`).
 *
 * The frame is written only to an open socket while the runtime is online ({@link isOnline}), and
 * only once it has been validated with the shared {@link ClientFrame}, so a body that is empty,
 * whitespace-only or longer than the contract's limit is refused here rather than answered by the
 * server. There is no local echo and no offline queue, and nothing is buffered either: a socket kept
 * open by a lost connection accepts a write into its own send buffer and then drops it with the
 * browser tab, so a caller refused here keeps its text and reports the failure. The server answers
 * with a `message` frame fanned out to both participants, or with an {@link ErrorFrame} the
 * listeners receive.
 *
 * @returns True when the frame was written to an open socket while the runtime was online, false
 * when it was invalid, the socket was not open, or the runtime was offline — the caller may then
 * tell the traveler to try again, keeping what they typed.
 */
export function send(meetupId: string, body: string): boolean {
  const open = socket;
  if (open === null || open.readyState !== READY_STATE_OPEN) return false;

  // A socket holds `readyState` 1 while the connection is down, so the write below would land in
  // its send buffer: nothing would be delivered, the tab would lose the message, and the traveler
  // would be told nothing. Refusing is what lets the chat screen keep the draft and report the
  // failure (AAP 0.5.4).
  if (!isOnline()) return false;

  const frame: ChatSend = { type: 'chat_send', meetupId, body };
  const checked = ClientFrame.safeParse(frame);
  if (!checked.success) return false;

  try {
    // The parsed frame, not the input: what was validated is what is sent, trimming included.
    open.send(JSON.stringify(checked.data));
    return true;
  } catch {
    // The socket closed between the check above and the write. Nothing is queued; the caller can
    // ask for a fresh attempt.
    return false;
  }
}

/**
 * Closes the socket and stops reconnecting (AAP 0.3.3).
 *
 * Called when the session ends, on sign-out and after account deletion. A pending reconnect is
 * cancelled, the backoff and unauthorized counters are cleared, and the state returns to `idle`.
 * Registered listeners are left in place: they belong to the session's lifetime, not to a socket's.
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
  failedAttempts = 0;
  setState('idle');
}

// --- Opening a socket -------------------------------------------------------------------------

/**
 * Opens one socket for the current session, rotating the session first when the last close looked
 * unauthorized. Never rejects, and never throws at the caller.
 */
async function openSocket(): Promise<void> {
  opening = true;
  try {
    if (!desired) return;

    if (refreshBeforeNextAttempt) {
      refreshBeforeNextAttempt = false;
      const rotation = await rotateSession();
      if (rotation === 'signed_out') return;
      if (rotation === 'failed') {
        // Nothing was opened and nothing was refused, so the session may still be good — a lost
        // connection is not a refusal. Keep the flag and stay in the backoff.
        refreshBeforeNextAttempt = true;
        scheduleReconnect();
        return;
      }
    }

    // The session may have ended while the rotation was in flight.
    if (!desired || socket !== null) return;

    const base = wsBaseUrl();
    const token = accessToken();
    if (base === null || token === null) {
      setState('idle');
      return;
    }

    let created: WebSocket;
    try {
      created = new WebSocket(`${base}${CHAT_PATH}`, [WS_BEARER_SUBPROTOCOL, token]);
    } catch {
      // A base the platform cannot parse. Retried like any other interruption, and never logged
      // (AAP 0.11.1).
      scheduleReconnect();
      return;
    }

    socket = created;
    setState('connecting');
    attach(created);
  } finally {
    opening = false;
  }
}

/**
 * Attaches the four handlers to a socket and records how to remove them again.
 *
 * Every handler first checks that the socket is still the one this module holds, so a late event
 * from a socket that was already discarded cannot change the state or deliver a frame twice.
 */
function attach(created: WebSocket): void {
  const handleOpen = (): void => {
    if (socket !== created) return;
    failedAttempts = 0;
    unauthorizedCloses = 0;
    refreshedSinceUnauthorized = false;
    refreshBeforeNextAttempt = false;
    setState('open');
  };

  const handleMessage = (event: MessageEvent): void => {
    if (socket !== created) return;
    receive(event.data);
  };

  const handleError = (): void => {
    // Nothing to do: a browser and React Native both follow an error with a close, which decides
    // whether the next attempt rotates the session. The event is never inspected — it can carry the
    // request URL — and never logged (AAP 0.11.1).
  };

  const handleClose = (event: CloseEvent): void => {
    if (socket !== created) return;
    discard(created);

    // Our own close, or an orderly one from the platform: no reason to come back.
    if (!desired || event.code === CLOSE_NORMAL) {
      setState('idle');
      return;
    }

    // 4403 is the server refusing this traveler outright — a block, or a meetup that is not theirs —
    // so retrying would be refused again (AAP 0.5.4).
    if (event.code === CLOSE_FORBIDDEN) {
      setState('idle');
      return;
    }

    // A refusal the API itself labelled unauthorized: the close code says the session is not live, or
    // a `token_invalid` frame arrived before the close. A close before `open` is deliberately not
    // one: an upgrade refused for a spent token is answered as plain HTTP before the upgrade, which a
    // browser reports exactly like an unreachable socket — a close, usually 1006 (AAP 0.3.3) — so it
    // proves nothing about the session and is retried on the backoff below, session untouched.
    const unauthorized =
      event.code === CLOSE_UNAUTHORIZED ||
      event.code === CLOSE_INVALIDATED ||
      refreshBeforeNextAttempt;

    if (unauthorized) {
      unauthorizedCloses += 1;
      if (refreshedSinceUnauthorized && unauthorizedCloses >= 2) {
        // Both closes were the API's own unauthorized refusals, and a rotation has run in between —
        // which only a live session permits — so the session itself is gone: the refresh token was
        // revoked, or the account was deleted (AAP 0.5.3). Reconnecting would only repeat the refusal.
        void signOutAndStop();
        return;
      }
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

/** Removes a discarded socket's handlers and drops it, so its late events change nothing. */
function discard(created: WebSocket): void {
  const current = attached;
  if (current !== null && current.socket === created) {
    current.detach();
    attached = null;
  }
  if (socket === created) socket = null;
}

// --- Receiving --------------------------------------------------------------------------------

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
  // A frame this client cannot read — one from a newer API, or something that is not a frame at all —
  // is dropped rather than logged or answered (AAP 0.11.1).
  if (!frame.success) return;

  const value: ServerFrame = frame.data;
  if (value.type === 'error' && value.code === 'token_invalid') {
    // The write was refused because the session no longer authenticates it, and the server closes
    // with 4401 next: rotate before the next attempt (AAP 0.5.3).
    refreshBeforeNextAttempt = true;
  }

  for (const listener of [...frameListeners]) {
    try {
      listener(value);
    } catch {
      // One failing listener must not stop the others, and it must not break the socket.
    }
  }
}

// --- Reconnecting and the session rotation ----------------------------------------------------

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

/** Cancels a scheduled reconnect, if one is waiting. */
function clearReconnect(): void {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Rotates the session before a reconnect, through the single flight shared with the REST client, so
 * one refresh token is spent once whatever else is retrying (AAP 0.3.3, AAP 0.11.2).
 *
 * @returns `rotated` when a new pair is installed, `failed` when the rotation failed for any reason
 * other than a refusal — a lost connection above all — and `signed_out` when it was refused with
 * `401 token_invalid`, in which case the session has already been cleared.
 */
async function rotateSession(): Promise<'rotated' | 'failed' | 'signed_out'> {
  try {
    await refreshSession();
    refreshedSinceUnauthorized = true;
    return 'rotated';
  } catch (error) {
    // A refusal means the refresh token is spent or revoked: reuse detection revokes the session
    // that presented a rotated token (AAP 0.11.2). Anything else leaves the session alone.
    if (isApiError(error) && error.status === 401 && error.code === 'token_invalid') {
      await signOutAndStop();
      return 'signed_out';
    }
    return 'failed';
  }
}

/**
 * Ends the session: the hooks clear it and the socket stops reconnecting (AAP 0.5.3, AAP 0.11.2).
 *
 * `onSignedOut` is idempotent by contract (`./client`), and `src/auth/session.ts` calls
 * {@link disconnect} from it as well, so the second call here is harmless.
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

// --- Environment and state --------------------------------------------------------------------

/**
 * The WebSocket base the chat path is appended to, or null when the build configured none.
 *
 * `process.env.EXPO_PUBLIC_WS_URL` is read by direct static member access on purpose:
 * `babel-preset-expo` 12 inlines only that form, so a destructured or computed read would arrive
 * `undefined` in the bundle. `apps/mobile/app.config.ts` validates it at build time as a `ws:` or
 * `wss:` origin; a trailing slash is tolerated here. The read happens per call rather than at module
 * load, so importing this module needs no environment.
 */
function wsBaseUrl(): string | null {
  // The read is kept as one direct member access and the value narrowed by hand, as in `./client`:
  // under the Expo program's types the variable arrives as `any`, so `typeof` is what turns a
  // compose-supplied empty string into a missing value.
  const configured: unknown = process.env.EXPO_PUBLIC_WS_URL;
  const base = typeof configured === 'string' ? configured.trim().replace(/\/+$/, '') : '';
  return base === '' ? null : base;
}

/** The access token the auth hooks hold, or null while signed out or unconfigured. */
function accessToken(): string | null {
  const hooks = authHooks();
  if (hooks === null) return null;
  const token = hooks.getAccessToken();
  // An empty token is no token: `['bearer', '']` would be a handshake with nothing to authenticate.
  return token === null || token === '' ? null : token;
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
