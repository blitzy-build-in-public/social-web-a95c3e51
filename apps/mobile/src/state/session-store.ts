/**
 * The signed-in session's snapshot for the client's navigation gate (AAP 0.5.1, AAP 0.5.8).
 *
 * An external store over React's `useSyncExternalStore`, so a screen or a layout reads the session
 * without a provider: `app/_layout.tsx` chooses between the splash, the sign-in route, the age gate
 * and the tabs from this one value.
 *
 * It holds nothing but the status and, while signed in, the caller's id, role and consent flag. It
 * never holds an access or refresh token — the access token lives in memory inside
 * `src/auth/session.ts` and the refresh token in `src/auth/storage.*` — and never an email address,
 * handle, avatar seed, experiment variant or any other profile field, which come from the React
 * Query cache (`queryKeys.me`). Nothing here is persisted and nothing is logged, so reading the
 * session cannot leak one.
 */
import { useSyncExternalStore } from 'react';

import type { MeDto, UserRole } from '@tablemate/shared';

/**
 * Where the session stands: `loading` until bootstrap has restored a session or failed to, then
 * `signed_in` or `signed_out`.
 */
export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

/**
 * The session as the client knows it. The three identity fields are present together while the
 * status is `signed_in` and absent — omitted, never `undefined` — otherwise, so the snapshot always
 * has one shape per status.
 */
export interface SessionSnapshot {
  /** The status the navigation gate switches on. */
  readonly status: SessionStatus;

  /** The caller's user id, while signed in. */
  readonly userId?: string;

  /**
   * The caller's role. The `/ops` area is offered on web only when this is `operator`; that check
   * is a navigation convenience, and the API's `403 operator_only` is the authority (AAP 0.3.2).
   */
  readonly role?: UserRole;

  /** Whether the age gate has been passed and `POST /v1/me/consents` has succeeded. */
  readonly consented?: boolean;
}

/**
 * A signed-in identity: what {@link sessionFromMe} returns and what {@link setSignedIn} accepts.
 * Naming the three fields keeps a caller from handing over a wider object.
 */
export interface SessionIdentity {
  readonly userId: string;
  readonly role: UserRole;
  readonly consented: boolean;
}

/** The one snapshot per status is frozen and shared; the store starts unknown until bootstrap runs. */
const INITIAL_SNAPSHOT: SessionSnapshot = Object.freeze({ status: 'loading' });

/** The writable form a snapshot is built in, with exactly the snapshot's own fields. */
interface SnapshotDraft {
  status: SessionStatus;
  userId?: string;
  role?: UserRole;
  consented?: boolean;
}

let snapshot: SessionSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();

/** Compares the four fields, so republishing an unchanged session notifies no subscriber. */
function isSameSnapshot(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return (
    a.status === b.status &&
    a.userId === b.userId &&
    a.role === b.role &&
    a.consented === b.consented
  );
}

/**
 * The single write path. It builds a draft field by field — never spreading a caller-supplied
 * object — so no key outside the snapshot's fields can enter one, freezes what it stores, and
 * notifies every subscriber.
 */
function publish(status: SessionStatus, identity?: SessionIdentity): void {
  const draft: SnapshotDraft = { status };
  if (identity !== undefined) {
    draft.userId = identity.userId;
    draft.role = identity.role;
    draft.consented = identity.consented;
  }

  const next = Object.freeze(draft);
  if (isSameSnapshot(snapshot, next)) return;
  snapshot = next;
  // Iterate a copy: a listener that subscribes from inside a notification is not called by it.
  for (const listener of [...listeners]) listener();
}

/**
 * The current snapshot. The reference is stable until the session actually changes, which is what
 * `useSyncExternalStore` needs to avoid a render loop.
 */
export function getSessionSnapshot(): SessionSnapshot {
  return snapshot;
}

/** Subscribes to session changes and returns the function that unsubscribes. */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current session as a React value, re-rendering the calling component whenever a setter
 * publishes one. The server snapshot is the same getter, so the web export's static render reads
 * `loading` rather than a client-only value.
 */
export function useSession(): SessionSnapshot {
  return useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot);
}

/**
 * Records a signed-in session. Called only by `src/auth/session.ts`, with the value
 * {@link sessionFromMe} built once `POST /v1/auth/verify` or `GET /v1/me` has answered.
 *
 * Exactly the three identity fields are copied, so a wider object — a `MeDto` straight from the API
 * included — cannot put an email, a variant or another profile field in the store.
 */
export function setSignedIn(identity: SessionIdentity): void {
  publish('signed_in', {
    userId: identity.userId,
    role: identity.role,
    consented: identity.consented,
  });
}

/** Records that no session is held. `signOut()` and a bootstrap that fails both call it. */
export function setSignedOut(): void {
  publish('signed_out');
}

/**
 * Records that the age gate has been passed, after `POST /v1/me/consents` has succeeded. Called
 * only by `markConsented()` in `src/auth/session.ts`, and it changes nothing unless the session is
 * signed in, so a late response cannot sign anyone in.
 */
export function setConsented(): void {
  const current = snapshot;
  if (current.status !== 'signed_in') return;
  const { userId, role } = current;
  if (userId === undefined || role === undefined) return;
  publish('signed_in', { userId, role, consented: true });
}

/**
 * Builds the store's identity from an own-profile payload: the `user` of `POST /v1/auth/verify` and
 * the response of `GET /v1/me` are both a `MeDto`, and the age gate has been passed exactly when
 * `consents.ageConfirmedAt` is set.
 */
export function sessionFromMe(me: Pick<MeDto, 'id' | 'role' | 'consents'>): SessionIdentity {
  return { userId: me.id, role: me.role, consented: me.consents.ageConfirmedAt !== null };
}
