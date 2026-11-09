/**
 * The proof flow's client-side status store (AAP 0.5.5, AAP 0.5.8).
 *
 * An attempt keeps only `{ status, issuerId?, errorCode? }` and a numeric download progress, and never
 * email bytes, a file name or URI, an extracted field value, a circuit input, witness data, a proof or
 * public signals: the setters' signatures make that structural, and nothing here logs or persists
 * anything (`apps/mobile/test/eml-intake.test.ts` enforces the same rule). These statuses are
 * deliberately not the shared `ProofStatus` enum of `MeDto.proof.status`, which is the server's record
 * of a stored proof rather than the transient steps of one local attempt.
 */
import { useSyncExternalStore } from 'react';

/**
 * One step of a local proving attempt, as the proof screens render it: `idle` before an attempt and
 * after {@link resetProof}, `reading` while the picked `.eml` is parsed, `downloading` while the proving
 * artefacts are fetched and hash-checked, `proving` while the witness is generated and the proof built,
 * `submitting` while `POST /itinerary-proofs` is in flight, and the three terminal states.
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
 * A snapshot is frozen; the stay dates a screen shows come from `GET /v1/me` or the `ProofAccepted`
 * response and are none of them held here. Read it through {@link useProofState} in a component or
 * {@link getProofSnapshot} outside React.
 */
export interface ProofState {
  readonly status: ProofFlowStatus;
  /**
   * An integer from the registry or from `GET /v1/zk/config`, never a domain or a display name taken
   * from the email. Kept across the phases of one attempt once known, and absent from an idle state.
   */
  readonly issuerId?: number;
  /** Present only while `status` is `error`, and at most 64 characters of `[a-z0-9_]`. */
  readonly errorCode?: string;
  /** Present only while `status` is `downloading`, clamped into range, and absent when not finite. */
  readonly downloadProgress?: number;
}

/**
 * The intake test asserts that `Object.keys(getProofSnapshot())` is a subset of this list, and the
 * setters below accept only these values, so no other data can reach the snapshot (AAP 0.5.5).
 */
export const PROOF_STATE_KEYS = ['status', 'issuerId', 'errorCode', 'downloadProgress'] as const;

/** Anything else is reduced to {@link UNKNOWN_ERROR_CODE}, so free text from an exception cannot reach a snapshot or a screen. */
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

const UNKNOWN_ERROR_CODE = 'unknown_error';

const BUSY_STATUSES: readonly ProofFlowStatus[] = [
  'reading',
  'downloading',
  'proving',
  'submitting',
];

const IDLE_STATE: ProofState = Object.freeze({ status: 'idle' });

/** Its fields are exactly the keys of {@link PROOF_STATE_KEYS}, each assigned from a validated primitive. */
interface ProofStateDraft {
  status: ProofFlowStatus;
  issuerId?: number;
  errorCode?: string;
  downloadProgress?: number;
}

let snapshot: ProofState = IDLE_STATE;
const listeners = new Set<() => void>();

function asIssuerId(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asDownloadProgress(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function isSameState(a: ProofState, b: ProofState): boolean {
  return (
    a.status === b.status &&
    a.issuerId === b.issuerId &&
    a.errorCode === b.errorCode &&
    a.downloadProgress === b.downloadProgress
  );
}

/**
 * Builds a new state field by field from validated primitives — never spreading or `Object.assign`ing a
 * caller-supplied object — so no key outside {@link PROOF_STATE_KEYS} can enter a snapshot, and it
 * freezes what it stores.
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
  for (const listener of [...listeners]) listener();
}

/** The reference is stable until the state actually changes, which is what `useSyncExternalStore` and a render bail-out rely on. */
export function getProofSnapshot(): ProofState {
  return snapshot;
}

export function subscribeProof(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useProofState(): ProofState {
  return useSyncExternalStore(subscribeProof, getProofSnapshot, getProofSnapshot);
}

/**
 * The issuer id already known is kept — so the screens can name the issuer across the phases of an
 * attempt — unless a valid one is supplied with this call, and any error code is cleared. Download
 * progress is kept while `downloading`, because a call that only re-announces the phase must not empty
 * the bar, and dropped on every other step.
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
 * An `errorCode` outside {@link ERROR_CODE_PATTERN} becomes `unknown_error`, and a non-integer or
 * negative `issuerId` is dropped, so a message or a value cannot be carried into a snapshot.
 */
export function setProofError(errorCode: string, issuerId?: number): void {
  const code = ERROR_CODE_PATTERN.test(errorCode) ? errorCode : UNKNOWN_ERROR_CODE;
  set('error', asIssuerId(issuerId), code);
}

/** The generate screen calls it on mount and after leaving, so nothing from an earlier attempt is shown over a new one. */
export function resetProof(): void {
  set('idle');
}

export function isProofBusy(state: ProofState): boolean {
  return BUSY_STATUSES.includes(state.status);
}
