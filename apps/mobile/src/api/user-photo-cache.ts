/**
 * The session-scoped cache of counterpart photos: one download per distinct traveler, shared by every frame that
 * draws them.
 *
 * `GET /users/:userId/photo` answers `cache-control: private, no-store` deliberately, because the tier that released
 * the bytes belongs to one viewer-and-target pair and a block can revoke it, so no HTTP cache may hold them and the
 * API decides entitlement again on every render (AAP 0.5.4, AAP 0.5.7). This module takes nothing from that decision:
 * it holds no profile field and no bytes, only the object URL of a Blob the API already served this viewer in this
 * session. What it removes is what the client used to pay for that decision — a Meetups list drawing one counterpart
 * in twenty rows downloaded their photo twenty times and minted twenty object URLs for bytes that cannot change
 * within a session.
 *
 * What is cached is dropped wherever the client can observe the bytes or the entitlement changing: `forgetUserPhoto`
 * after the viewer's own photo is replaced or removed, and after a block; and `clearUserPhotos` wherever the session
 * itself is cleared, which is also what keeps one account's photos from being drawn for the next (AAP 0.5.2). A load
 * that never reached the API is recorded nowhere, so a later mount tries again; one refused with `401` joins the
 * session's single-flight rotation and is retried once with the request that rotation rebuilt (AAP 0.3.3), a refused
 * rotation giving up the photo alone (AAP 0.3.2). Nothing on this path is logged: not the traveler's id, not the URL,
 * not the token, not the status (AAP 0.5.5).
 *
 * The module imports neither React nor React Native: `../ui/Avatar.tsx` subscribes to it through
 * `useSyncExternalStore`, and a Node unit suite imports it directly.
 */
import { refreshSession, userPhotoRequest } from './client';
import { isApiError } from './errors';

/**
 * What is known about one traveler's photo: the object URL a frame may draw, `null` when the API serves nothing
 * drawable for them, and `undefined` while nothing has been asked or an answer is still on its way.
 *
 * Primitive on purpose: `useSyncExternalStore` compares what it reads between renders, so a snapshot built per call
 * would re-render every subscriber on every pass.
 */
export type UserPhotoState = string | null | undefined;

/** The resolved entries: the object URL of a traveler's photo, or `null` where the API serves nothing drawable. */
const photos = new Map<string, string | null>();

/**
 * One traveler's load while it runs, so a second frame joins the first instead of starting its own. `stale` marks a
 * load whose entry was dropped while it ran: its answer is neither stored nor minted into a URL.
 */
interface PhotoLoad {
  stale: boolean;
}

/** The loads running now, keyed by traveler. */
const loads = new Map<string, PhotoLoad>();

/** The subscribers `useSyncExternalStore` installed, notified as entries resolve and as they are dropped. */
const listeners = new Set<() => void>();

/** The one status a session rotation recovers from: an access token the API no longer accepts. */
const UNAUTHORIZED = 401;
/** The refusal a spent session ends a rotation with, and the only one that means there is nothing left to ask with. */
const SPENT_SESSION = 'token_invalid';

/**
 * What a load ended with: the bytes, the absent state for a traveler the API serves nothing drawable for, or the
 * failed state for a request that never reached the API, which is recorded nowhere so a later mount may retry.
 */
type PhotoLoadResult =
  | { readonly kind: 'photo'; readonly bytes: Blob }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed' };

/** The absent state, shared because it carries nothing. */
const ABSENT: PhotoLoadResult = { kind: 'absent' };
/** The failed state, shared because it carries nothing. */
const FAILED: PhotoLoadResult = { kind: 'failed' };

/**
 * Tells every subscriber that an entry resolved or was dropped.
 *
 * Iterates a copy, so a listener that subscribes from inside a notification is not called by it.
 */
function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * The photo request for a traveler, or null when this build has no API origin: `userPhotoRequest` reads a build-time
 * value `app.config.ts` validates, and a build that shipped without one makes that call throw, which is a photo this
 * client cannot ask for rather than a failure of the API.
 *
 * @param userId - The traveler whose photo is requested.
 * @returns The request, or null when none can be built.
 */
function photoRequest(userId: string): { url: string; headers: Record<string, string> } | null {
  try {
    return userPhotoRequest(userId);
  } catch {
    return null;
  }
}

/**
 * Sends one photo request.
 *
 * @param request - The photo route's URL and the bearer headers it is sent with.
 * @returns The status the API answered with and the bytes it carried, or null when the request never reached the API
 * — a lost connection, or bytes that could not be read — which the caller leaves uncached.
 */
async function fetchBytes(request: {
  url: string;
  headers: Record<string, string>;
}): Promise<{ readonly status: number; readonly bytes: Blob | null } | null> {
  try {
    const answer = await fetch(request.url, { headers: request.headers });
    if (!answer.ok) return { status: answer.status, bytes: null };
    return { status: answer.status, bytes: await answer.blob() };
  } catch {
    return null;
  }
}

/** The bytes as the state they record, or the absent state when the answer carried none. */
function bytesOrAbsent(bytes: Blob | null): PhotoLoadResult {
  return bytes === null ? ABSENT : { kind: 'photo', bytes };
}

/**
 * Whether a failed rotation means the session is spent: the API refused the refresh token, which is a decision only a
 * fresh sign-in undoes. Every other failure — a lost connection, a storage that could not be read — reached nothing.
 *
 * @param error - What `refreshSession` rejected with.
 * @returns True for the refusal a spent session answers with.
 */
function isSpentSession(error: unknown): boolean {
  return isApiError(error) && error.status === UNAUTHORIZED && error.code === SPENT_SESSION;
}

/**
 * Loads one traveler's photo (AAP 0.3.3).
 *
 * A `401` joins the session's single-flight rotation and is retried exactly once with the request that rotation
 * rebuilt, so one spent access token costs one rotation whatever the caller. A rotation refused because the session
 * is spent gives up the photo alone, which is the absent state (AAP 0.3.2); one that failed without reaching the API
 * at all is the failed state, so nothing is recorded and a later mount asks again. Every other answer — a tier that
 * released nothing, a block, a traveler with no stored photo, all of them the route's own `404` — is the absent state.
 *
 * @param userId - The traveler whose photo is requested.
 * @returns What the load ended with.
 */
async function loadPhotoBytes(userId: string): Promise<PhotoLoadResult> {
  const first = photoRequest(userId);
  if (first === null) return ABSENT;
  const answer = await fetchBytes(first);
  if (answer === null) return FAILED;
  if (answer.status !== UNAUTHORIZED) return bytesOrAbsent(answer.bytes);
  try {
    await refreshSession();
  } catch (error) {
    return isSpentSession(error) ? ABSENT : FAILED;
  }
  const rotated = photoRequest(userId);
  if (rotated === null) return ABSENT;
  const retry = await fetchBytes(rotated);
  if (retry === null) return FAILED;
  return bytesOrAbsent(retry.bytes);
}

/**
 * Turns bytes into the object URL a frame draws, or null when this browser refuses to mint one for them: bytes that
 * can never be given a URL are exactly the absent state, and the generated pattern stands in for them.
 *
 * @param bytes - The photo bytes the API answered with.
 * @returns The object URL, or null.
 */
function objectUrlFor(bytes: Blob): string | null {
  try {
    return URL.createObjectURL(bytes);
  } catch {
    return null;
  }
}

/**
 * Records what a load ended with: the object URL of the bytes, or the absent state.
 *
 * A load that failed records nothing, so a later mount asks again; and one whose entry was dropped while it ran —
 * forgotten, or cleared with the session — is dropped here too, so an answer nobody waits for is neither stored nor
 * minted into a URL that nothing would ever revoke.
 *
 * @param userId - The traveler the load was for.
 * @param entry - The in-flight record the load was started with.
 * @param result - What the load ended with.
 */
function publishPhoto(userId: string, entry: PhotoLoad, result: PhotoLoadResult): void {
  if (entry.stale || result.kind === 'failed') return;
  photos.set(userId, result.kind === 'photo' ? objectUrlFor(result.bytes) : null);
  notify();
}

/**
 * Runs one traveler's load to its end and releases its in-flight entry, whichever way it ended.
 *
 * Releasing compares the entry, so a load started after this one was dropped — by a block, by a replaced photo, by
 * the session ending — keeps its own slot, and the entry this one owned is gone either way: a settled load is never
 * joined by a later caller, and a retry starts a fresh one.
 *
 * @param userId - The traveler the load is for.
 * @param entry - The in-flight record this load owns.
 */
async function runLoad(userId: string, entry: PhotoLoad): Promise<void> {
  try {
    publishPhoto(userId, entry, await loadPhotoBytes(userId));
  } finally {
    if (loads.get(userId) === entry) loads.delete(userId);
  }
}

/**
 * Asks for a traveler's photo, starting one shared load where none is running and none has resolved.
 *
 * A no-op for an empty id, for a traveler whose entry is already resolved — bytes to draw, or an absent answer — and
 * for one whose load is already in flight: the first caller's request is the one every later caller joins.
 *
 * @param userId - The traveler whose photo is requested.
 */
export function requestUserPhoto(userId: string): void {
  if (userId === '' || photos.has(userId) || loads.has(userId)) return;
  const entry: PhotoLoad = { stale: false };
  loads.set(userId, entry);
  // The load answers no caller: it publishes what it found to every subscriber, which is the whole of what it owes.
  // A listener that throws is not allowed to surface as an unhandled rejection here.
  void runLoad(userId, entry).catch(() => undefined);
}

/**
 * What is known about a traveler's photo, for `useSyncExternalStore`.
 *
 * @param userId - The traveler to read, or the empty string where the caller has no id.
 * @returns The object URL to draw, null for a traveler the API serves nothing drawable for, and undefined while
 * nothing has been asked or an answer is still on its way.
 */
export function userPhotoSnapshot(userId: string): UserPhotoState {
  return userId === '' ? undefined : photos.get(userId);
}

/**
 * Subscribes to the cache, as `useSyncExternalStore` does.
 *
 * @param listener - Called as a traveler's entry resolves and as it is dropped.
 * @returns Removes this subscription.
 */
export function subscribeUserPhotos(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Records that the bytes behind an object URL do not decode, and drops that entry: a browser that refused the bytes
 * it was handed has nothing drawable for that traveler, which is the absent state (AAP 0.5.4).
 *
 * Only the URL the frame was drawing is acted on: an error that arrives after the entry was forgotten or replaced
 * must not revoke whatever is stored now.
 *
 * @param userId - The traveler whose photo failed to draw.
 * @param url - The object URL the frame was drawing.
 */
export function discardUserPhoto(userId: string, url: string): void {
  if (photos.get(userId) !== url) return;
  photos.set(userId, null);
  URL.revokeObjectURL(url);
  notify();
}

/**
 * Drops a traveler's entry and revokes the URL it held, so the next render asks the API for the photo again: the
 * bytes behind it changed, or the right to see them did (AAP 0.5.4, AAP 0.5.7).
 *
 * A load running for that traveler is marked stale and dropped with it, so the answer it is already on its way to
 * returning is neither stored nor minted, and a later request starts a fresh load.
 *
 * @param userId - The traveler whose cached photo no longer applies.
 */
export function forgetUserPhoto(userId: string): void {
  const url = photos.get(userId);
  const load = loads.get(userId);
  photos.delete(userId);
  if (load !== undefined) {
    load.stale = true;
    loads.delete(userId);
  }
  if (url === undefined) return;
  // Nothing is drawn for that traveler again until it is asked for.
  if (url !== null) URL.revokeObjectURL(url);
  notify();
}

/**
 * Empties the cache: every stored URL is revoked and both maps are cleared, so nothing a finished session saw is
 * drawn for the session that follows it. Called wherever the session itself is cleared.
 */
export function clearUserPhotos(): void {
  for (const url of photos.values()) {
    if (url !== null) URL.revokeObjectURL(url);
  }
  photos.clear();
  for (const load of loads.values()) load.stale = true;
  loads.clear();
  // Every subscriber re-reads, so a frame still mounted draws the pattern rather than a URL whose bytes were revoked.
  notify();
}
