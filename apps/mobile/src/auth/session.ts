/**
 * The traveler's session: the magic-link exchange, the access token's lifetime in memory, the
 * rotating refresh token in platform storage, and the one chat socket a session owns
 * (AAP 0.3.2, AAP 0.3.3, AAP 0.5.1, AAP 0.5.4, AAP 0.8.1).
 *
 * `requestMagicLink` mails a 15-minute single-use link; `verifyToken` exchanges it for the pair
 * `POST /auth/verify` answers, keeping the access token here and writing the refresh token to
 * storage before the session is exposed; every later `401 token_invalid` is recovered by
 * `refreshAccessToken`, which `./client` and `./ws` reach through `configureAuth`; `bootstrap`
 * restores a session after a reload, and is also what `./client` awaits through the `ensureSession`
 * hook, so a read a screen issues at mount waits for the restored token instead of leaving
 * unauthenticated; and `signOut` ends one.
 *
 * Four invariants hold here. This module alone writes `../state/session-store`, and `setSignedIn`
 * runs only once the refresh token is in storage. The access token never leaves memory (AAP 0.5.2).
 * `epoch` guards every asynchronous step: one that finds it changed discards its result, with no
 * storage write and no store update, so a rotation completing after a sign-out cannot resurrect a
 * session. And the chat socket opens only for a consented session (AAP 0.5.4).
 *
 * The web's multi-tab caveat is not recovered from here. Two tabs refreshing at once present the same
 * rotated token, which the API reads as reuse and answers by revoking every session of the user
 * (AAP 0.11.2), signing both out. The mitigations only reduce the window: rotate on refusal alone,
 * never on a timer, and read the token from storage at the moment of use. A tab that loses a genuine
 * race signs out, and the traveler signs in again with a fresh link.
 *
 * Client-safe, with no side effect beyond the single `configureAuth` call at the foot of the file and
 * no logging at all — not a token, not an email address, not a field of a `MeDto` (AAP 0.11.1).
 */
import type { MeDto, RefreshResponse } from '@tablemate/shared';

import { apiClient, configureAuth } from '../api/client';
import { ApiError, isApiError } from '../api/errors';
import { connect, disconnect } from '../api/ws';
import { queryClient, queryKeys } from '../state/meetup-store';
import {
  getSessionSnapshot,
  sessionFromMe,
  setConsented,
  setRestoreFailure,
  setSignedIn,
  setSignedOut,
} from '../state/session-store';
import { tokenStorage } from './storage';

/**
 * Where the refresh token is kept between launches (AAP 0.3.3, AAP 0.5.2): `./storage.native` on iOS
 * and Android, `./storage.web` on the web, reached through the extensionless `./storage` import
 * above, which Metro resolves per platform and `tsconfig.json` type-checks against the native half.
 * Only the refresh token is stored.
 */
export interface TokenStorage {
  /** The stored refresh token, or null when there is none. */
  getRefreshToken(): Promise<string | null>;

  /** Replaces the stored refresh token with the rotated one. */
  setRefreshToken(token: string): Promise<void>;

  /** Removes the stored token. */
  clear(): Promise<void>;
}

/**
 * What {@link bootstrap} established. `signed_in` and `signed_out` are answers; `unavailable` is a
 * failure that proved nothing, so the caller keeps the stored refresh token and retries.
 */
export type BootstrapResult = 'signed_in' | 'signed_out' | 'unavailable';

/** What {@link signOut} may be told. */
export interface SignOutOptions {
  /**
   * Ask the API to revoke the session as well. Defaults to true. `app/settings/delete-account.tsx`
   * passes false after `DELETE /me`, because the server has already revoked every session of the
   * account (AAP 0.5.3) and a call would only be refused.
   */
  remote?: boolean;
}

/** The access token every authenticated request carries. In memory only, null while signed out. */
let accessToken: string | null = null;

/**
 * The session generation, raised by every sign-in and every sign-out. An asynchronous step captures
 * it when it starts and discards its result when it has changed. `bootstrap` deliberately does not
 * raise it: restoring the session a stored token already belongs to is not a new sign-in, and
 * raising it would cancel a magic-link exchange landing at the same moment.
 */
let epoch = 0;

/** The rotation every caller shares while it runs, or null (AAP 0.11.2). */
let rotationInFlight: Promise<string> | null = null;

/** The sign-out every caller shares while it runs, or null. */
let signOutInFlight: Promise<void> | null = null;

/** The restore every caller shares while it runs, or null. */
let bootstrapInFlight: Promise<BootstrapResult> | null = null;

/**
 * The failure the last restore attempt ended with, or null. {@link ensureSession} refuses a request
 * with it, so a caller sees the failure that actually stopped the restore — a `network_error` above
 * all — rather than a generic one, and `../state/session-store` carries its code so a screen whose
 * own read never ran has something to show instead of a loading line.
 */
let lastRestoreFailure: ApiError | null = null;

/**
 * Records how a restore attempt ended: the {@link ApiError} that stopped it, or null once one has
 * produced a session or a sign-out has ended it. The single place the record is written, so every
 * reader of {@link lastRestoreFailure} sees one value — and the store is told from the same line, so
 * a screen reads the same attempt rather than a second one of its own.
 */
function recordRestoreFailure(failure: ApiError | null): void {
  lastRestoreFailure = failure;
  setRestoreFailure(failure === null ? null : failure.code);
}

/**
 * The in-memory access token, or null while signed out. `./client` and `./ws` read it through the
 * hooks installed at the foot of this file; no screen needs it, and no copy of it is persisted.
 */
export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Asks for a sign-in link for an address (AAP 0.5.4). The API always answers `202`, whatever the
 * account state of the address, so nothing about it can be learned here. `400 invalid_email` and
 * `429 rate_limited` reach the sign-in screen as an {@link ApiError}.
 */
export async function requestMagicLink(email: string): Promise<void> {
  await apiClient.magicLink({ email: email.trim() });
}

/**
 * Exchanges a magic-link token for a session (AAP 0.5.4, AAP 0.5.8). A refused link — unknown,
 * older than 15 minutes, or already used — propagates as `401 token_invalid` and leaves the session
 * exactly as it was. On success the returned pair becomes the session: the refresh token is stored
 * before anything is exposed, the `GET /me` cache is seeded so the first screen needs no round trip,
 * and the chat socket opens for an account that already passed the age gate.
 *
 * @returns The caller's own profile, which is what the verifying screen routes on.
 */
export async function verifyToken(token: string): Promise<MeDto> {
  const sessionEpoch = epoch;
  const answer = await apiClient.verify({ token });

  // A sign-out that landed while the exchange was in flight outranks this sign-in, which would
  // otherwise open a session the traveler just closed. The link is single use, so the caller asks
  // for a new one rather than retrying this one.
  if (epoch !== sessionEpoch) throw refusal();

  // An account switch must not leave the previous session behind: not a socket, not a cached
  // profile, and above all not an access token that could authenticate as the wrong traveler.
  const active = getSessionSnapshot().userId;
  if (active !== undefined && active !== answer.user.id) {
    accessToken = null;
    disconnect();
    queryClient.clear();
  }

  // A new sign-in opens a generation, so a rotation or a restore still in flight is now stale.
  epoch += 1;
  if (!(await installVerifiedSession(answer.user, answer, epoch))) throw refusal();
  return answer.user;
}

/**
 * Restores the session a stored refresh token belongs to, for `app/_layout.tsx` to call once on
 * start-up (AAP 0.5.1). Single-flight, with the slot cleared when an attempt settles so the retry the
 * caller offers after `unavailable` really runs again.
 *
 * The three answers are deliberate. `signed_out` means the stored token was refused, and the session
 * with it is gone. `unavailable` means nothing was proved — `network_error`, `rate_limited`,
 * `service_unavailable`, a 5xx answer, or a storage the client cannot read — so the stored token
 * stays where it is, the store stays in `loading`, and an offline start never erases a session. That
 * attempt's code reaches the store with it, which is what lets a screen tell this state from a
 * restore that is still running.
 */
export function bootstrap(): Promise<BootstrapResult> {
  const running = bootstrapInFlight;
  if (running !== null) return running;

  const started = Promise.resolve().then(restoreSession);
  bootstrapInFlight = started;
  return started.finally(() => {
    bootstrapInFlight = null;
  });
}

/** One restore attempt, single-flight through {@link bootstrap}. Never rejects. */
async function restoreSession(): Promise<BootstrapResult> {
  const sessionEpoch = epoch;

  let stored: string | null;
  try {
    stored = await tokenStorage.getRefreshToken();
  } catch {
    // A storage the client cannot read is a local failure, not an absent session: the token stays
    // where it is, so the caller retries instead of signing the traveler out.
    recordRestoreFailure(unavailable());
    return 'unavailable';
  }

  if (epoch !== sessionEpoch) return settledResult();
  if (stored === null) {
    setSignedOut();
    return 'signed_out';
  }

  let access: string;
  try {
    access = await refreshAccessToken();
  } catch (error) {
    // A token that is spent, revoked or belonged to a deleted account (AAP 0.11.2, AAP 0.5.3).
    if (!isRefusal(error)) {
      recordRestoreFailure(isApiError(error) ? error : unavailable());
      return 'unavailable';
    }
    await signOut({ remote: false });
    return 'signed_out';
  }

  if (epoch !== sessionEpoch) return settledResult();

  let me: MeDto;
  try {
    me = await apiClient.getMe();
  } catch (error) {
    // The session was revoked between the rotation and this read.
    if (!isRefusal(error)) {
      recordRestoreFailure(isApiError(error) ? error : unavailable());
      return 'unavailable';
    }
    await signOut({ remote: false });
    return 'signed_out';
  }

  const published = publishSession(me, access, sessionEpoch);
  // A session is held from here on, so nothing stays recorded to refuse a request with.
  recordRestoreFailure(null);
  return published ? 'signed_in' : settledResult();
}

/**
 * Waits until a session's access token is held, for `./client` to await before the first
 * authenticated send of a cold load (AAP 0.3.3).
 *
 * A session already held resolves at once. Otherwise this joins the single-flight {@link bootstrap}
 * rather than starting a rotation of its own, so a load whose restore is already running pays one
 * rotation: refresh tokens rotate with reuse detection, and a second concurrent one would end the
 * session (AAP 0.11.2).
 *
 * @throws ApiError the failure the restore ended with when it answered `unavailable` — a
 * `network_error`, a `rate_limited`, a `service_unavailable` — and this module's own `401
 * token_invalid` when there was no session to restore, which is what the API would have answered to a
 * request sent without a token. Either way the request is refused rather than sent unauthenticated.
 */
async function ensureSession(): Promise<void> {
  if (accessToken !== null) return;

  const result = await bootstrap();
  if (result === 'signed_in') return;
  if (result === 'unavailable') throw lastRestoreFailure ?? unavailable();
  throw refusal();
}

/**
 * The answer a restore gives when a newer decision superseded it: that decision's own state, and
 * `unavailable` while it is still publishing, so the caller retries rather than contradicting it.
 */
function settledResult(): BootstrapResult {
  const status = getSessionSnapshot().status;
  if (status === 'signed_in') return 'signed_in';
  return status === 'signed_out' ? 'signed_out' : 'unavailable';
}

/**
 * Rotates the session and returns the access token to use (AAP 0.3.3).
 *
 * Single-flight, and that is the point: refresh tokens rotate, and a token presented after it was
 * rotated away is read as reuse, which revokes every session of the user (AAP 0.11.2). One in-flight
 * rotation therefore serves every caller — a request refused with `401 token_invalid`, the chat
 * socket reconnecting after `4409`, and a restore — so one token is spent once. The stored token is
 * read at the moment of use rather than cached, because another web tab may have rotated it.
 *
 * @throws ApiError `401 token_invalid` when there is no stored token or the API refused it: the
 * session has ended, and has been ended locally too. Other failures leave storage untouched, so the
 * caller may retry.
 */
export function refreshAccessToken(): Promise<string> {
  const running = rotationInFlight;
  if (running !== null) return running;

  const sessionEpoch = epoch;
  // Started on a microtask, like `refreshSession` in `./client`, so the shared promise is stored
  // before the rotation body runs and a call made from inside it joins this rotation.
  const rotation = Promise.resolve().then(() => rotate(sessionEpoch));
  rotationInFlight = rotation;
  // Cleared when the rotation settles, so the next need starts a fresh one.
  return rotation.finally(() => {
    rotationInFlight = null;
  });
}

/** One rotation, single-flight through {@link refreshAccessToken}. */
async function rotate(sessionEpoch: number): Promise<string> {
  let refreshToken: string | null;
  try {
    refreshToken = await tokenStorage.getRefreshToken();
  } catch {
    // Nothing could be read, so nothing can be rotated and nothing was refused: the session is left
    // alone and the caller retries.
    throw unavailable();
  }

  if (refreshToken === null) {
    // Nothing to rotate with, so the session is over locally too.
    await signOut({ remote: false });
    throw refusal();
  }

  let next: RefreshResponse;
  try {
    next = await apiClient.refresh({ refreshToken });
  } catch (error) {
    // A refusal means the token is spent or revoked, so the local session ends with it. Anything
    // else — a lost connection, a 5xx — is not a refusal, leaves storage untouched, and is retried.
    if (isRefusal(error)) await signOut({ remote: false });
    throw error;
  }

  if (epoch !== sessionEpoch) return supersededRotation();

  // Stored before the token is handed out: a reload landing between the two finds the rotated token
  // rather than the spent one, and a step that failed mid-flight is retried rather than lost.
  await writeRefreshToken(next.refreshToken);
  if (epoch !== sessionEpoch) return supersededRotation();

  accessToken = next.accessToken;
  return next.accessToken;
}

/**
 * The access token a rotation answers with when a newer decision superseded it: the current
 * session's token where a newer sign-in installed one, so the caller retries with what is live; and
 * otherwise a `401 token_invalid` refusal, which signs nobody out a second time.
 */
async function supersededRotation(): Promise<string> {
  const current = await discardSupersededWrite();
  if (current === null) throw refusal();
  return current;
}

/**
 * Ends the session, locally and — unless told otherwise — on the server (AAP 0.3.3). Idempotent and
 * re-entrant: a second call while one is running returns that same promise, and a call once the
 * session is gone only re-clears local state. The teardown always happens, in a `finally`, whether
 * or not the server answered.
 */
export function signOut(options?: SignOutOptions): Promise<void> {
  const running = signOutInFlight;
  if (running !== null) return running;

  const remote = options?.remote !== false;
  const started = Promise.resolve().then(() => finishSignOut(remote));
  signOutInFlight = started;
  return started.finally(() => {
    signOutInFlight = null;
  });
}

/** One sign-out, single-flight through {@link signOut}. */
async function finishSignOut(remote: boolean): Promise<void> {
  // Raised first, so a rotation, a restore or a sign-in that is in flight when the sign-out starts
  // can no longer install anything.
  epoch += 1;

  try {
    if (remote && accessToken !== null) {
      try {
        // Best effort, and never through a refresh: `apiClient.logout` disables the 401 refresh
        // path, so a stale token cannot start a rotation while the sign-out runs.
        await apiClient.logout();
      } catch {
        // A refused logout — an already revoked session, a deleted account — is not something the
        // traveler can act on, and the local session ends either way.
      }
    }
  } finally {
    await clearRefreshToken();
    accessToken = null;
    // Nothing is left to refuse a request with: the session did not survive the sign-out.
    recordRestoreFailure(null);
    disconnect();
    queryClient.clear();
    setSignedOut();
  }
}

/**
 * Records that the age gate was passed, for `app/(auth)/age-gate.tsx` to call once
 * `POST /v1/me/consents` has succeeded. The store is told first, so the navigation gate lets the
 * traveler through; the own-profile read is invalidated so the consents it shows are the ones just
 * recorded; and only then is the chat socket opened, which is what keeps an age-gated account from
 * holding one (AAP 0.5.4).
 */
export function markConsented(): void {
  setConsented();
  void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  connect();
}

/**
 * Exposes a session whose refresh token is already in storage: sets the in-memory access token,
 * seeds the `GET /me` cache, records the identity for the navigation gate, and opens the chat socket
 * for a consented account.
 *
 * @returns False when a newer decision superseded this one, in which case nothing was exposed.
 */
function publishSession(user: MeDto, access: string, sessionEpoch: number): boolean {
  if (epoch !== sessionEpoch) return false;

  const identity = sessionFromMe(user);
  accessToken = access;
  queryClient.setQueryData(queryKeys.me, user);
  setSignedIn(identity);
  if (identity.consented) connect();
  return true;
}

/**
 * Stores a verified session's refresh token and exposes that session (AAP 0.3.3). The token reaches
 * storage before the session is exposed, so a reload landing mid-way restores this session rather
 * than the previous one, and the generation is re-checked either side of the write, so a sign-in a
 * sign-out superseded leaves no token behind for a later `bootstrap` to restore.
 *
 * @returns False when a newer decision superseded this sign-in.
 */
async function installVerifiedSession(
  user: MeDto,
  tokens: { accessToken: string; refreshToken: string },
  sessionEpoch: number,
): Promise<boolean> {
  if (epoch !== sessionEpoch) return false;

  await writeRefreshToken(tokens.refreshToken);
  if (epoch !== sessionEpoch) {
    await discardSupersededWrite();
    return false;
  }

  return publishSession(user, tokens.accessToken, sessionEpoch);
}

/**
 * Ends a session step that a newer decision superseded: the refresh token the step just wrote
 * belongs to a session that no longer exists, so it is removed — unless a newer sign-in already owns
 * that slot, whose own token is left untouched. Nothing in memory changes.
 *
 * @returns The access token the current session holds, or null when there is none.
 */
async function discardSupersededWrite(): Promise<string | null> {
  if (getSessionSnapshot().status === 'signed_in') return accessToken;
  await clearRefreshToken();
  return null;
}

/**
 * Writes the refresh token, tolerating a storage that refuses it — a browser with storage disabled
 * by the traveler, a full quota. The session still opens and simply does not survive a reload, which
 * is better than refusing to sign in at all.
 */
async function writeRefreshToken(token: string): Promise<void> {
  try {
    await tokenStorage.setRefreshToken(token);
  } catch {
    // As documented: the session lives in memory until storage accepts a token again.
  }
}

/** Removes the stored refresh token, tolerating a storage that cannot be reached. */
async function clearRefreshToken(): Promise<void> {
  try {
    await tokenStorage.clear();
  } catch {
    // A sign-out that could not clear storage still ends the session in memory; the next one tries
    // again.
  }
}

/** True when an error is the API's `401 token_invalid`: the session is gone (AAP 0.11.2). */
function isRefusal(error: unknown): boolean {
  return isApiError(error) && error.status === 401 && error.code === 'token_invalid';
}

/** The `401 token_invalid` this module raises where a session ended without the API saying so. */
function refusal(): ApiError {
  return new ApiError(401, 'token_invalid');
}

/**
 * The error for a failure of this client's own storage, which no request reached. It is a shared
 * code (AAP 0.5.4) rather than a new one, chosen for what the callers already do with it: `./client`
 * reports it without signing anybody out, `./ws` keeps its session and retries, and `bootstrap`
 * answers `unavailable`.
 */
function unavailable(): ApiError {
  return new ApiError(503, 'service_unavailable');
}

// Installed once, at first load, and never re-installed: `./client` and `./ws` read the hooks per
// call and a module body runs once per instance, so a second call would only replace them with the
// same four functions. `onSignedOut` is local-only by design — `./client` calls it only after the
// session is already invalid (a refresh token refused as reused, or a request refused twice,
// AAP 0.11.2), and a remote logout from there would recurse into the refresh that is failing.
configureAuth({
  getAccessToken,
  ensureSession,
  refresh: refreshAccessToken,
  onSignedOut: () => signOut({ remote: false }),
});
