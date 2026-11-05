/**
 * The proof flow's client-side status store (AAP 0.5.5, AAP 0.5.8).
 *
 * This module is the one place the intake rule of AAP 0.5.5 lives on the client: an attempt keeps
 * only `{ status, issuerId?, errorCode? }` and a numeric download progress, and never email bytes,
 * a file name or URI, an extracted field value (city, dates, guest name, booking reference), a
 * circuit input, witness data, a proof or public signals. The setters' signatures make that
 * structural — every value they accept is a status, a non-negative integer issuer id, a
 * `snake_case` error code or a 0-1 progress number — and nothing here logs or persists anything, so
 * an error code is the only thing that leaves the flow.
 *
 * `apps/mobile/test/eml-intake.test.ts` enforces the same rule, asserting that a snapshot and the
 * captured logs hold no fixture text.
 *
 * These statuses are deliberately not the shared `ProofStatus` enum of `MeDto.proof.status`
 * (`none`, `valid`, `expired`): that is the server's record of a stored proof, while these are the
 * transient steps of one local attempt.
 */
import { useSyncExternalStore } from 'react';

/**
 * One step of a local proving attempt, as the proof screens render it. `idle` before an attempt and
 * after {@link resetProof}; `reading` while the picked `.eml` is parsed; `downloading` while the
 * proving artefacts are fetched and hash-checked; `proving` while the witness is generated and the
 * proof built; `submitting` while `POST /itinerary-proofs` is in flight; and the three terminal
 * states `accepted`, `error` and `cancelled` (the user aborted, or left the screen).
 */
export type ProofFlowStatus =
  | 'idle'
  | 'reading'
  | 'downloading'
  | 'proving'
  | 'submitting'
  | 'accepted'
  | 'error'
  | 'cancelled';

/**
 * The whole of the proof flow's client state, per AAP 0.5.5. The stay dates a screen shows come
 * from `GET /v1/me` or from the `ProofAccepted` response `submitProof` returns; none of them is
 * held here.
 *
 * A snapshot is frozen. Read it through {@link useProofState} in a component or through
 * {@link getProofSnapshot} outside React.
 */
export interface ProofState {
  /** The step the attempt is on, or `idle` when no attempt is running. */
  readonly status: ProofFlowStatus;

  /**
   * The circuit `issuerId` of the registry entry this attempt proved against — an integer from the
   * registry or from `GET /v1/zk/config`, never a domain or a display name taken from the email.
   * Kept across the phases of one attempt once known, and absent from an idle state.
   */
  readonly issuerId?: number;

  /**
   * The `snake_case` code of a failure: `unsupported_issuer`, `dkim_missing`, `field_not_found`,
   * `proof_invalid`, `nullifier_used`, `network_error` or `prover_unavailable`, to name the ones
   * the flow raises itself. Present only while `status` is `error`, and at most 64 characters of
   * `[a-z0-9_]`: anything else a caller hands over, an exception's message included, becomes
   * `unknown_error`.
   */
  readonly errorCode?: string;

  /**
   * How far the artefacts download has got, from 0 to 1, for the screen's progress bar. Present
   * only while `status` is `downloading`, clamped into range, and absent — rather than `NaN` — when
   * the reported value is not finite.
   */
  readonly downloadProgress?: number;
}

/**
 * Every key a snapshot can hold, in the order {@link set} builds them. The intake test asserts that
 * `Object.keys(getProofSnapshot())` is a subset of this list, and the setters below accept only
 * these values, so no other data can reach the snapshot (AAP 0.5.5).
 */
export const PROOF_STATE_KEYS = ['status', 'issuerId', 'errorCode', 'downloadProgress'] as const;

/**
 * The only error codes accepted as given. Anything else is reduced to {@link UNKNOWN_ERROR_CODE},
 * so free text from an exception message or a field value cannot reach the snapshot or a screen.
 */
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** The code an `errorCode` argument that is not a `snake_case` code is replaced by. */
const UNKNOWN_ERROR_CODE = 'unknown_error';

/** The statuses in which an attempt is running. See {@link isProofBusy}. */
const BUSY_STATUSES: readonly ProofFlowStatus[] = [
  'reading',
  'downloading',
  'proving',
  'submitting',
];

/** The state the store starts in and that {@link resetProof} returns to. Frozen and shared. */
const IDLE_STATE: ProofState = Object.freeze({ status: 'idle' });

/**
 * The writable shape a snapshot is built in before it is frozen. Its fields are exactly the keys of
 * {@link PROOF_STATE_KEYS}, and every one of them is assigned from a validated primitive.
 */
interface ProofStateDraft {
  status: ProofFlowStatus;
  issuerId?: number;
  errorCode?: string;
  downloadProgress?: number;
}

let snapshot: ProofState = IDLE_STATE;
const listeners = new Set<() => void>();

/** Keeps a non-negative safe integer and drops everything else — a negative, fractional or non-finite value. */
function asIssuerId(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Clamps a reported progress into 0-1 and drops a non-finite one, so a screen can bind it directly. */
function asDownloadProgress(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** Compares the four known fields, so that republishing an unchanged state notifies no subscriber. */
function isSameState(a: ProofState, b: ProofState): boolean {
  return (
    a.status === b.status &&
    a.issuerId === b.issuerId &&
    a.errorCode === b.errorCode &&
    a.downloadProgress === b.downloadProgress
  );
}

/**
 * The single write path. It builds a new state field by field from validated primitives — it never
 * spreads or `Object.assign`s a caller-supplied object — so no key outside {@link PROOF_STATE_KEYS}
 * can enter a snapshot, and it freezes what it stores.
 */
function set(
  status: ProofFlowStatus,
  issuerId?: number,
  errorCode?: string,
  downloadProgress?: number,
): void {
  const next: ProofStateDraft = { status };
  if (issuerId !== undefined) next.issuerId = issuerId;
  if (errorCode !== undefined) next.errorCode = errorCode;
  if (downloadProgress !== undefined) next.downloadProgress = downloadProgress;

  const frozen = Object.freeze(next);
  if (isSameState(snapshot, frozen)) return;
  snapshot = frozen;
  // Iterate a copy: a listener that subscribes from inside a notification is not called by it.
  for (const listener of [...listeners]) listener();
}

/**
 * The current state. The reference is stable until the state actually changes, which is what
 * `useSyncExternalStore` and a render bail-out rely on.
 */
export function getProofSnapshot(): ProofState {
  return snapshot;
}

/** Subscribes to state changes and returns the function that unsubscribes. */
export function subscribeProof(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current state as a React value, re-rendering the component when a setter publishes one. */
export function useProofState(): ProofState {
  return useSyncExternalStore(subscribeProof, getProofSnapshot, getProofSnapshot);
}

/**
 * Moves the flow to a non-error step. The issuer id already known is kept — so the screens can name
 * the issuer across the phases of an attempt — unless a valid one is supplied with this call, and
 * any error code is cleared. Download progress is kept while `downloading` (a call that only
 * re-announces the phase, or that reports a value which cannot be stored, must not empty the bar)
 * and dropped on every other step.
 *
 * `idle` is the step before and after an attempt, so it carries neither an issuer id nor progress.
 */
export function setProofStatus(
  status: Exclude<ProofFlowStatus, 'error'>,
  extra?: { issuerId?: number; downloadProgress?: number },
): void {
  const previous = snapshot;
  const knownIssuerId = asIssuerId(extra?.issuerId) ?? previous.issuerId;
  const knownProgress = asDownloadProgress(extra?.downloadProgress) ?? previous.downloadProgress;

  set(
    status,
    status === 'idle' ? undefined : knownIssuerId,
    undefined,
    status === 'downloading' ? knownProgress : undefined,
  );
}

/**
 * Moves the flow to `error` with a `snake_case` code and, when the failed attempt had already
 * resolved its issuer, that issuer's id.
 *
 * An `errorCode` outside {@link ERROR_CODE_PATTERN} becomes `unknown_error`, and a non-integer or
 * negative `issuerId` is dropped, so a message or a value cannot be carried into a snapshot.
 */
export function setProofError(errorCode: string, issuerId?: number): void {
  const code = ERROR_CODE_PATTERN.test(errorCode) ? errorCode : UNKNOWN_ERROR_CODE;
  set('error', asIssuerId(issuerId), code);
}

/**
 * Returns the flow to `{ status: 'idle' }`. The generate screen calls it on mount and after
 * leaving, so nothing from an earlier attempt is shown over a new one.
 */
export function resetProof(): void {
  set('idle');
}

/** True while an attempt is running, which is when the proof screens hold back navigation. */
export function isProofBusy(state: ProofState): boolean {
  return BUSY_STATUSES.includes(state.status);
}
