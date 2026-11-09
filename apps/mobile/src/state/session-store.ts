/**
 * The signed-in session's snapshot for the client's navigation gate (AAP 0.5.1).
 *
 * An external store over React's `useSyncExternalStore`, so a screen or a layout reads the session without a provider:
 * `app/_layout.tsx` chooses between the splash, the sign-in route, the age gate and the tabs from this one value.
 * It holds nothing but the status, the code of a restore that failed and proved nothing, and, while signed in, the
 * caller's id, role and consent flag. It never holds an access or refresh token and never an email address, handle,
 * avatar seed or any other profile field, which come from the React Query cache. Nothing here is persisted or logged.
 */
import { useSyncExternalStore } from 'react';
import type { MeDto, UserRole } from '@tablemate/shared';

// Type-only, so the store keeps no runtime dependency on the API layer (AAP 0.5.1): the code is
// carried to a screen, which is where `userMessageFor` turns it into a sentence.
import type { ClientErrorCode } from '../api/errors';
/** Where the session stands: `loading` until bootstrap has restored a session or failed to, then `signed_in` or
 * `signed_out`. */
export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

export interface SessionSnapshot {
  readonly status: SessionStatus;
  readonly userId?: string;
  readonly role?: UserRole;
  readonly consented?: boolean;
  readonly restoreFailureCode?: ClientErrorCode;
}

export interface SessionIdentity {
  readonly userId: string;
  readonly role: UserRole;
  readonly consented: boolean;
}

const INITIAL_SNAPSHOT: SessionSnapshot = Object.freeze({ status: 'loading' });

interface SnapshotDraft {
  status: SessionStatus;
  userId?: string;
  role?: UserRole;
  consented?: boolean;
  restoreFailureCode?: ClientErrorCode;
}

let snapshot: SessionSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();

function isSameSnapshot(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return (
    a.status === b.status &&
    a.userId === b.userId &&
    a.role === b.role &&
    a.consented === b.consented &&
    a.restoreFailureCode === b.restoreFailureCode
  );
}

/**
 * The single write path. It builds a draft field by field — never spreading a caller-supplied object — so no key outside
 * the snapshot's fields can enter one, and notifies every subscriber. A field the caller leaves out is absent from the
 * draft, never present as `undefined`, which is also what clears it. */
function publish(
  status: SessionStatus,
  identity?: SessionIdentity,
  restoreFailureCode?: ClientErrorCode,
): void {
  const draft: SnapshotDraft = { status };
  if (identity !== undefined) {
    draft.userId = identity.userId;
    draft.role = identity.role;
    draft.consented = identity.consented;
  }
  if (restoreFailureCode !== undefined) draft.restoreFailureCode = restoreFailureCode;
  const next = Object.freeze(draft);
  if (isSameSnapshot(snapshot, next)) return;
  snapshot = next;
  // Iterate a copy: a listener that subscribes from inside a notification is not called by it.
  for (const listener of [...listeners]) listener();
}

/** The current snapshot. The reference is stable until the session actually changes, which is what
 * `useSyncExternalStore` needs to avoid a render loop. */
export function getSessionSnapshot(): SessionSnapshot {
  return snapshot;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current session as a React value, re-rendering the calling component whenever a setter publishes one. The server
 * snapshot is the same getter, so the web export's static render reads `loading`. */
export function useSession(): SessionSnapshot {
  return useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot);
}

/**
 * Records a signed-in session. Called only by `src/auth/session.ts`, with the value {@link sessionFromMe} built once
 * `POST /v1/auth/verify` or `GET /v1/me` has answered.
 *
 * Exactly the three identity fields are copied, so a wider object — a `MeDto` straight from the API included — cannot put
 * an email, a variant or another profile field in the store.
 */
export function setSignedIn(identity: SessionIdentity): void {
  publish('signed_in', {
    userId: identity.userId,
    role: identity.role,
    consented: identity.consented,
  });
}

/** Records that no session is held. `signOut()` and a bootstrap that fails both call it, and both answer what the
 * restore was asking, so this clears `restoreFailureCode` too. */
export function setSignedOut(): void {
  publish('signed_out');
}

/**
 * Records, or clears, the failure the last restore attempt ended with: the code when the attempt proved nothing, and
 * null once one has answered otherwise.
 *
 * Called only by `recordRestoreFailure()` in `src/auth/session.ts`, from the same line that records the failure
 * `./client` refuses a request with, so both readers of one failure see the same attempt.
 */
export function setRestoreFailure(code: ClientErrorCode | null): void {
  // A restore failure only ever describes an unknown session. A snapshot that already answered
  // `signed_in` or `signed_out` was not left unknown by this attempt, so it keeps what it published
  // rather than gaining a failure a screen would show over a session it holds.
  if (snapshot.status !== 'loading') return;
  publish('loading', undefined, code === null ? undefined : code);
}

/** Records that the age gate has been passed, after `POST /v1/me/consents` has succeeded. It changes nothing unless the
 * session is signed in, so a late response cannot sign anyone in. */
export function setConsented(): void {
  const current = snapshot;
  if (current.status !== 'signed_in') return;
  const { userId, role } = current;
  if (userId === undefined || role === undefined) return;
  publish('signed_in', { userId, role, consented: true });
}

/** Builds the store's identity from an own-profile payload: `POST /v1/auth/verify` and `GET /v1/me` both answer a
 * `MeDto`, and the age gate has been passed exactly when `consents.ageConfirmedAt` is set. */
export function sessionFromMe(me: Pick<MeDto, 'id' | 'role' | 'consents'>): SessionIdentity {
  return { userId: me.id, role: me.role, consented: me.consents.ageConfirmedAt !== null };
}
