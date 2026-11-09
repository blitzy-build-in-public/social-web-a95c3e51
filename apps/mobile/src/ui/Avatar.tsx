/**
 * `Avatar` — a traveler's picture: a pattern generated from the avatar seed the API assigned, with the tier-2 profile
 * photo drawn over it when the API reported one (AAP 0.1.1, AAP 0.5.4).
 *
 * What is drawn follows from the API and never from the client: `hasPhoto` is used exactly as it arrived, because
 * disclosure is enforced at field level by the API. The pattern is a pure function of `avatarSeed`, so one traveler
 * draws the same mosaic in every render and nothing is stored, uploaded or fetched for a profile without a photo.
 * Only native can send a header with an image, so the photo loads differently per platform: native hands the bearer
 * token to `Image`, while react-native-web cannot and the effect fetches the bytes. A load refused with `401` joins the
 * session's one rotation and is retried once with the token that rotation installed (AAP 0.3.3); a load that then fails
 * falls back to the pattern silently, with nothing logged (AAP 0.5.5). On web the load is deferred by viewport distance
 * — the browser's own `loading="lazy"` cannot apply with the bearer header — so a frame starts its fetch only once it
 * comes within `LAZY_ROOT_MARGIN` of the viewport.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import type { ImageSourcePropType, ViewProps } from 'react-native';
import { Rect, Svg } from 'react-native-svg';
import { colors, componentSizes, radii } from '@tablemate/shared';
import type { ColorToken } from '@tablemate/shared';
import { refreshSession, userPhotoRequest } from '../api/client';

export interface AvatarProps {
  /** The seed the API assigned to this traveler; the whole pattern derives from it. */
  avatarSeed: string;
  /** The traveler's handle, used only as the accessible name: `Avatar of <handle>`. */
  handle: string;
  /** The frame's side in points on native and CSS px on web. Defaults to {@link DEFAULT_SIZE}. */
  size?: number;
  /** The traveler's id, which the photo request needs; without it no photo is attempted. */
  userId?: string;
  /** Whether the API reported a photo: pass the profile's own `hasPhoto` through unchanged (AAP 0.5.4). */
  hasPhoto?: boolean;
  /** Whether a parent already names the traveler; a decorative avatar is hidden from screen readers. */
  decorative?: boolean;
  testID?: string;
}

/** The frame's side in points / CSS px when the caller names none. */
const DEFAULT_SIZE = componentSizes.avatarSmall;
/** Side of the generated grid, in cells. */
const GRID = 5;
/** Columns the seed's bits fill: the rest mirror them, so 15 bits carry all 25 cells. */
const MIRRORED_COLUMNS = 3;
/** Row-major index of the middle cell, filled when a seed selects no other cell. */
const CENTRE_CELL = 12;
/** Bit offset the palette is selected from: the low 15 bits already carry the grid. */
const PALETTE_BITS = 15;
/** FNV-1a's 32-bit offset basis and prime. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** One palette entry: the fill the frame paints and the tile colour drawn over it. */
interface AvatarPaletteEntry {
  readonly background: ColorToken;
  readonly foreground: ColorToken;
}

const PALETTE = [
  { background: 'surface', foreground: 'primary' },
  { background: 'surface', foreground: 'danger' },
  { background: 'surface', foreground: 'success' },
  { background: 'surface', foreground: 'warning' },
  { background: 'primary', foreground: 'onPrimary' },
  { background: 'danger', foreground: 'onDanger' },
  { background: 'text', foreground: 'onPrimary' },
] as const satisfies readonly AvatarPaletteEntry[];

function hashSeed(seed: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), FNV_PRIME);
  }
  return hash >>> 0;
}

export function avatarPattern(seed: string): {
  background: ColorToken;
  foreground: ColorToken;
  cells: boolean[];
} {
  const hash = hashSeed(seed);
  // `noUncheckedIndexedAccess` reads an indexed tuple as possibly absent; the modulo bounds the index inside the tuple, so the fallback exists only to satisfy the type.
  const palette = PALETTE[(hash >>> PALETTE_BITS) % PALETTE.length] ?? PALETTE[0];
  const cells: boolean[] = [];
  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      // Columns beyond the mirrored three read the bit of the column they mirror, so a flipped bit fills two cells and every pattern is left-right symmetrical.
      const source = column < MIRRORED_COLUMNS ? column : GRID - 1 - column;
      cells.push(((hash >>> (row * MIRRORED_COLUMNS + source)) & 1) === 1);
    }
  }
  // One seed in 32,768 selects no cell at all, which would paint a bare circle: the middle cell stands in, so every avatar carries a pattern.
  if (!cells.some((filled) => filled)) {
    cells[CENTRE_CELL] = true;
  }
  return { background: palette.background, foreground: palette.foreground, cells };
}

function frameAccessibility(
  decorative: boolean,
  handle: string,
): Pick<ViewProps, 'role' | 'aria-label' | 'aria-hidden' | 'importantForAccessibility'> {
  return decorative
    ? { 'aria-hidden': true, importantForAccessibility: 'no-hide-descendants' }
    : { role: 'img', 'aria-label': `Avatar of ${handle}` };
}

// Hides the drawn picture from assistive technology, so the frame is announced once rather than once more from inside it.
const HIDDEN_FROM_ASSISTIVE_TECH: Pick<
  ViewProps,
  'aria-hidden' | 'accessibilityElementsHidden' | 'importantForAccessibility'
> =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no' };

// The photo request for a traveler, or null when the API origin is not configured: `userPhotoRequest` reads a
// build-time value `app.config.ts` validates, and a build that shipped without it makes that call throw.
function photoRequest(userId: string): { url: string; headers: Record<string, string> } | null {
  try {
    return userPhotoRequest(userId);
  } catch {
    return null;
  }
}

/** The one refusal a session rotation recovers from: an access token the API no longer accepts. */
const UNAUTHORIZED = 401;
/**
 * How far outside the viewport a frame may sit and still start its web photo request, in CSS px: a list row of
 * lead-in, so the rows below the fold are never requested.
 */
const LAZY_ROOT_MARGIN = '200px';

async function fetchPhotoBytes(
  request: { url: string; headers: Record<string, string> },
  signal: AbortSignal,
): Promise<{ status: number; bytes: Blob | null } | null> {
  try {
    const answer = await fetch(request.url, { headers: request.headers, signal });
    if (!answer.ok) return { status: answer.status, bytes: null };
    return { status: answer.status, bytes: await answer.blob() };
  } catch {
    return null;
  }
}

/**
 * Loads a traveler's photo bytes, joining the session's single-flight rotation once when the bearer token the request
 * carried is refused with `401` (AAP 0.3.3).
 *
 * @param userId - The traveler whose photo is requested.
 * @param signal - Aborts the request when the render that asked for it ends.
 * @returns The bytes, or null when the API has none for that traveler.
 */
async function loadPhotoBytes(userId: string, signal: AbortSignal): Promise<Blob | null> {
  const first = photoRequest(userId);
  if (first === null) return null;
  const answer = await fetchPhotoBytes(first, signal);
  if (answer === null) return null;
  if (answer.status !== UNAUTHORIZED) return answer.bytes;
  try {
    await refreshSession();
  } catch {
    // A refused rotation means the session is spent; this load only gives up on the photo (AAP 0.3.2).
    return null;
  }
  const rotated = photoRequest(userId);
  if (rotated === null) return null;
  const retry = await fetchPhotoBytes(rotated, signal);
  return retry === null ? null : retry.bytes;
}

/**
 * Renders a traveler's avatar: the generated pattern, or the API's photo once it has loaded.
 *
 * @param props - {@link AvatarProps}.
 * @returns The frame, with the pattern under the photo it draws over it.
 */
export function Avatar({
  avatarSeed,
  handle,
  size = DEFAULT_SIZE,
  userId,
  hasPhoto,
  decorative = false,
  testID,
}: AvatarProps): JSX.Element {
  const pattern = useMemo(() => avatarPattern(avatarSeed), [avatarSeed]);
  // Disclosure is the API's decision, repeated here: the photo is attempted only where the API reported one and the profile carries an id to ask with (AAP 0.5.4).
  const photoUserId = hasPhoto === true && userId !== undefined && userId !== '' ? userId : null;
  // A native load that failed, remembered by traveler so the next one still gets an attempt.
  const [failedPhotoUserId, setFailedPhotoUserId] = useState<string | null>(null);
  // The one rotation-joined retry a native load gets, remembered by traveler: the source memo below rebuilds the
  // request once a fresh token is installed. `null` until a load fails.
  const [nativeRetry, setNativeRetry] = useState<{ userId: string; rotations: number } | null>(
    null,
  );
  // Web holds the fetched bytes as an object URL, tagged with the traveler it belongs to, so a
  // previous row's photo is never drawn over the next one's pattern while it loads.
  const [webPhoto, setWebPhoto] = useState<{ userId: string; url: string } | null>(null);
  // Whether this frame has come near the viewport, which defers the web fetch below. Starts true off web, where nothing is deferred.
  const [nearViewport, setNearViewport] = useState(Platform.OS !== 'web');
  // The frame the observer watches: react-native-web forwards a ref to the DOM node the frame renders.
  const frame = useRef<View | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || photoUserId === null || nearViewport) return undefined;
    // `View`'s ref is the host node on web and React Native's own handle on native; only the web branch reads it.
    const node = frame.current as unknown as Element | null;
    // Neither an observer to measure with nor a node to watch: the photo loads as it always has, because a deferral is never worth losing the photo over.
    if (typeof IntersectionObserver === 'undefined' || node === null) {
      setNearViewport(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        // One load is the whole of what this frame wants, and the cleanup below disconnects the rest.
        observer.disconnect();
      },
      { rootMargin: LAZY_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nearViewport, photoUserId]);
  useEffect(() => {
    if (Platform.OS !== 'web' || photoUserId === null || !nearViewport) return undefined;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let live = true;
    // Recovery-aware: a load refused with `401` joins the session's rotation and is retried once with the token that
    // rotation installed (AAP 0.3.3). `live` keeps a rotation that finishes after the traveler changed from drawing
    // its photo over the next one's pattern.
    void loadPhotoBytes(photoUserId, controller.signal)
      .then((bytes) => {
        if (!live || bytes === null) return;
        objectUrl = URL.createObjectURL(bytes);
        setWebPhoto({ userId: photoUserId, url: objectUrl });
      })
      // Silent by design: a refused, failed or undecodable load leaves the generated pattern in
      // place, and neither the id, the URL, the token nor the status reaches a log (AAP 0.5.5).
      .catch(() => undefined);
    return () => {
      // Abandoned when the traveler changes and released on unmount: no request outlives the render that asked for it, and no object URL is left for the browser to hold.
      live = false;
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [nearViewport, photoUserId]);
  const retryNativePhoto = (): void => {
    if (photoUserId === null) return;
    if (nativeRetry !== null && nativeRetry.userId === photoUserId) {
      // This traveler's one retry is spent and the reload failed too: the pattern stands in.
      setFailedPhotoUserId(photoUserId);
      return;
    }
    setNativeRetry({ userId: photoUserId, rotations: 0 });
    void refreshSession().then(
      () => setNativeRetry({ userId: photoUserId, rotations: 1 }),
      () => setFailedPhotoUserId(photoUserId),
    );
  };
  // The source to draw, or null for the pattern: native carries the bearer token on the source, which React Native
  // sends on iOS and Android, while web shows the object URL the effect built, because react-native-web cannot send
  // a header on an image.
  const photoSource: ImageSourcePropType | null = useMemo(() => {
    if (photoUserId === null || failedPhotoUserId === photoUserId) return null;
    if (Platform.OS === 'web') {
      return webPhoto !== null && webPhoto.userId === photoUserId ? { uri: webPhoto.url } : null;
    }
    // A retry whose rotation is still running draws the pattern: the source memo below rebuilds the request from the
    // token the rotation installed, and drawing nothing until then replaces the failed image rather than re-offering
    // it the same stale header.
    if (nativeRetry !== null && nativeRetry.userId === photoUserId && nativeRetry.rotations === 0) {
      return null;
    }
    const request = photoRequest(photoUserId);
    return request === null ? null : { uri: request.url, headers: request.headers };
  }, [failedPhotoUserId, nativeRetry, photoUserId, webPhoto]);
  return (
    <View
      {...frameAccessibility(decorative, handle)}
      ref={frame}
      style={[
        styles.frame,
        { backgroundColor: colors[pattern.background], height: size, width: size },
      ]}
      testID={testID}
    >
      {photoSource === null ? (
        <Svg
          {...HIDDEN_FROM_ASSISTIVE_TECH}
          height={size}
          viewBox={`0 0 ${GRID} ${GRID}`}
          width={size}
        >
          <Rect fill={colors[pattern.background]} height={GRID} width={GRID} x={0} y={0} />
          {pattern.cells.map((filled, index) =>
            filled ? (
              <Rect
                fill={colors[pattern.foreground]}
                height={1}
                key={index}
                width={1}
                x={index % GRID}
                y={Math.floor(index / GRID)}
              />
            ) : null,
          )}
        </Svg>
      ) : (
        <Image
          {...HIDDEN_FROM_ASSISTIVE_TECH}
          onError={() => {
            if (Platform.OS === 'web' || photoUserId === null) {
              // Web recovered inside the loader, so an error here is bytes that do not decode: the pattern is the fallback, as for a native retry that failed twice.
              setFailedPhotoUserId(photoUserId);
              return;
            }
            retryNativePhoto();
          }}
          resizeMode="cover"
          source={photoSource}
          style={[styles.photo, { height: size, width: size }]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    // A pill radius on a square frame is half its side, so one static value rounds every avatar from the smallest frame a list row draws to the largest a profile header does.
    borderRadius: radii.pill,
    // Clips the pattern and the photo to that circle on both platforms. Android needs a fill for the clip to apply, which the frame paints from the pattern's own background token.
    overflow: 'hidden',
  },
  photo: {
    // Shows while a photo is still loading, and under one whose bytes the image loader cannot decode, in place of an empty frame.
    backgroundColor: colors.surface,
  },
});
