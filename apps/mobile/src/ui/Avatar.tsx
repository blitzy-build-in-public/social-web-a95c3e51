/**
 * `Avatar` — a traveler's picture: a pattern generated from the avatar seed the API assigned, with the tier-2 profile
 * photo drawn over it when the API reported one (AAP 0.1.1, AAP 0.5.4, AAP 0.8.1).
 *
 * What is drawn follows from the API and never from the client: `hasPhoto` is used exactly as it arrived and the bytes
 * are requested only for it, because disclosure is enforced at field level by the API (AAP 0.5.4, criterion 5). The
 * pattern is a pure function of `avatarSeed`, so one traveler draws the same mosaic in every render and nothing is
 * stored, uploaded or fetched for a profile without a photo (AAP 0.1.1). Colours, radius and size come from
 * `@tablemate/shared`'s tokens, and the palette names only pairs recorded in `CONTRAST_PAIRS`.
 *
 * Only native can send a header with an image, so the photo loads differently per platform: native hands the bearer
 * token to `Image`, while react-native-web cannot and the effect fetches the bytes and shows them from an object URL it
 * revokes. A load refused with `401` joins the session's one rotation and is retried once with the token that rotation
 * installed (AAP 0.3.3, AAP 0.5.4); a load that then fails falls back to the pattern silently, with nothing about the
 * failure logged (AAP 0.5.5).
 *
 * The web load is deferred by viewport distance, because the browser's own `loading="lazy"` cannot apply here: the
 * bytes are fetched with the bearer header and shown from an object URL, so no attribute on the drawn element defers
 * the effect's own request. A frame starts its fetch only once it comes within `LAZY_ROOT_MARGIN` of the viewport, so a
 * list of avatars requests the rows a reader can reach rather than every row at mount.
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
  /**
   * Whether the API reported a photo: pass the profile's own `hasPhoto` through unchanged (AAP 0.5.4).
   */
  hasPhoto?: boolean;
  /** Whether a parent already names the traveler; a decorative avatar is hidden from screen readers. */
  decorative?: boolean;
  /** Test handle, forwarded to the frame (`avatar-<userId>`, ...). */
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

/**
 * The palette a generated avatar paints from.
 *
 * Every entry is a pair `CONTRAST_PAIRS` records, so a tile is legible on the fill it sits on and no
 * unmeasured pair is painted: `primary` on `surface` 6.59:1, `danger` on `surface` 5.83:1, `success`
 * on `surface` 6.43:1, `warning` on `surface` 6.39:1, `onPrimary` on `primary` 7.3:1, `onDanger` on
 * `danger` 6.47:1, `onPrimary` on `text` 17.21:1.
 */
const PALETTE = [
  { background: 'surface', foreground: 'primary' },
  { background: 'surface', foreground: 'danger' },
  { background: 'surface', foreground: 'success' },
  { background: 'surface', foreground: 'warning' },
  { background: 'primary', foreground: 'onPrimary' },
  { background: 'danger', foreground: 'onDanger' },
  { background: 'text', foreground: 'onPrimary' },
] as const satisfies readonly AvatarPaletteEntry[];

/**
 * Hashes a seed to an unsigned 32-bit value with FNV-1a over its UTF-16 code units.
 *
 * `Math.imul` keeps every step in 32-bit integer arithmetic, where a plain `*` would round the low bits away above
 * 2^53 and draw a different pattern per engine; nothing here reads the clock, a random source or the platform.
 */
function hashSeed(seed: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Derives the avatar a seed draws: one palette entry and one symmetrical 5 × 5 grid.
 *
 * Pure and deterministic, so the same seed returns the same pattern in every call and on every platform: the low 15
 * bits of the hash fill the left three columns of each row, the right-hand two mirror them, and the palette is taken
 * from the bits above those.
 */
export function avatarPattern(seed: string): {
  background: ColorToken;
  foreground: ColorToken;
  cells: boolean[];
} {
  const hash = hashSeed(seed);
  // `noUncheckedIndexedAccess` reads an indexed tuple as possibly absent; the modulo bounds the
  // index inside the tuple, so the fallback is unreachable and exists only to satisfy the type.
  const palette = PALETTE[(hash >>> PALETTE_BITS) % PALETTE.length] ?? PALETTE[0];
  const cells: boolean[] = [];
  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      // Columns beyond the mirrored three read the bit of the column they mirror, so a flipped bit
      // fills two cells and every pattern is left-right symmetrical.
      const source = column < MIRRORED_COLUMNS ? column : GRID - 1 - column;
      cells.push(((hash >>> (row * MIRRORED_COLUMNS + source)) & 1) === 1);
    }
  }
  // One seed in 32,768 selects no cell at all, which would paint a bare circle: the middle cell
  // stands in, so every avatar carries a pattern.
  if (!cells.some((filled) => filled)) {
    cells[CENTRE_CELL] = true;
  }
  return { background: palette.background, foreground: palette.foreground, cells };
}

/**
 * Builds the frame's accessibility attributes: its own name as an image, or its total suppression.
 *
 * A standalone avatar is one image named `Avatar of <handle>`: React Native reads `role="img"` as the image trait on
 * iOS and as its image role on Android, and react-native-web renders it with `aria-label`, so it is announced once,
 * under the same name, on all three. A decorative avatar — one inside a row that already names the traveler — leaves
 * the accessibility tree instead, which is what `aria-hidden` maps onto on native.
 */
function frameAccessibility(
  decorative: boolean,
  handle: string,
): Pick<ViewProps, 'role' | 'aria-label' | 'aria-hidden' | 'importantForAccessibility'> {
  return decorative
    ? { 'aria-hidden': true, importantForAccessibility: 'no-hide-descendants' }
    : { role: 'img', 'aria-label': `Avatar of ${handle}` };
}

/**
 * Hides the drawn picture from assistive technology, so the frame is announced once rather than once more from inside
 * it.
 *
 * Native reads a different prop per platform — `accessibilityElementsHidden` on iOS, `importantForAccessibility` on
 * Android — while react-native-web renders the ARIA attribute alone. The two React Native props are left off web on
 * purpose: react-native-svg's web element would otherwise emit them into the DOM as invalid attributes, which React
 * reports as a warning on every render of every avatar.
 */
const HIDDEN_FROM_ASSISTIVE_TECH: Pick<
  ViewProps,
  'aria-hidden' | 'accessibilityElementsHidden' | 'importantForAccessibility'
> =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no' };

/**
 * The photo request for a traveler, or `null` when the API origin is not configured: {@link userPhotoRequest} reads a
 * build-time value `app.config.ts` validates, and a build that shipped without it makes that call throw, so a missing
 * photo URL costs the photo rather than the row it is drawn in.
 */
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
 * How far outside the viewport a frame may sit and still start its web photo request, in CSS px: a list row of lead-in,
 * so the rows below the fold are never requested.
 */
const LAZY_ROOT_MARGIN = '200px';

/**
 * Sends one photo request and reads its answer as bytes.
 *
 * Only the fields this module reads are named, so the answer stays structural and the browser's and React Native's
 * `Response` both fit it. A `200` answers its bytes; any other status answers that status with no bytes, because only a
 * `401` is worth acting on; and an unreachable origin, a decode failure or an aborted signal answers `null`, keeping no
 * reason (AAP 0.5.5).
 */
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
 * carried is refused with `401` (AAP 0.3.3, AAP 0.5.4).
 *
 * The bytes cannot come through `./client`'s `request()`, which parses JSON, so the recovery that path performs is
 * repeated here on the same terms and through the same {@link refreshSession}: one rotation spends one refresh token,
 * and a second concurrent rotation would be read as reuse and revoke the whole session (AAP 0.11.2), which is why
 * exactly one join is made per load and no rotation is started for anything but a `401`. The retry re-reads the request
 * with {@link photoRequest} on purpose, so it carries what the rotation installed where the first attempt carried the
 * stale token. Everything else returns no photo — a non-`401` refusal, a second refusal after the retry, a rotation the
 * session refuses, an aborted signal and an unreachable origin all leave the generated pattern in place — and nothing
 * about them is logged (AAP 0.5.5, AAP 0.11.1).
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
    // A refused rotation means the session is spent; the next authenticated read signs the traveler
    // out. This load only gives up on the photo (AAP 0.3.2).
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
 * The photo is requested only for what the API itself reported — `hasPhoto` exactly as it arrived, and an id to request
 * the bytes with — and a load that fails falls back to the pattern with nothing logged (AAP 0.3.2, AAP 0.5.4,
 * AAP 0.5.5); one refused with `401` is recovered once by joining the session's shared rotation. On web the bytes are
 * fetched with the bearer header and shown from an object URL, which the effect revokes when the traveler changes or
 * the component unmounts.
 *
 * The frame reserves exactly `size` × `size` and clips to a circle, so a list of avatars lines up on whatever is drawn
 * inside, and no text in it has to follow the reader's font size. On web the photo request waits until the frame is
 * within `LAZY_ROOT_MARGIN` of the viewport, because the browser's `loading="lazy"` cannot defer a fetch the effect
 * performs itself.
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
  // Disclosure is the API's decision, repeated here: the photo is attempted only where the API
  // reported one and the profile carries an id to ask with (AAP 0.3.2, AAP 0.5.4).
  const photoUserId = hasPhoto === true && userId !== undefined && userId !== '' ? userId : null;
  // A native load that failed, remembered by traveler so the next one still gets an attempt.
  const [failedPhotoUserId, setFailedPhotoUserId] = useState<string | null>(null);
  // The one rotation-joined retry a native load gets, remembered by traveler: `rotations` is 0 while
  // the rotation it joined runs and 1 once a fresh token is installed, which is what makes the source
  // memo below rebuild the request. `null` until a load fails.
  const [nativeRetry, setNativeRetry] = useState<{ userId: string; rotations: number } | null>(
    null,
  );
  // Web holds the fetched bytes as an object URL, tagged with the traveler it belongs to, so a
  // previous row's photo is never drawn over the next one's pattern while it loads.
  const [webPhoto, setWebPhoto] = useState<{ userId: string; url: string } | null>(null);
  // Whether this frame has come near the viewport, which is what defers the web fetch below. Starts
  // true off web, where nothing is deferred and no native branch reads it.
  const [nearViewport, setNearViewport] = useState(Platform.OS !== 'web');
  // The frame the observer watches. react-native-web forwards a ref to the DOM node the frame renders,
  // which is the element an `IntersectionObserver` observes.
  const frame = useRef<View | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || photoUserId === null || nearViewport) return undefined;
    // `View`'s ref is the host node on web and React Native's own handle on native, and only the web
    // branch reads it, so the DOM element an observer needs is reached through this one assertion.
    const node = frame.current as unknown as Element | null;
    // Neither an observer to measure with nor a node to watch: the photo loads as it always has,
    // because a deferral is never worth losing the photo over.
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
    // Recovery-aware: a load refused with `401` joins the session's rotation and is retried once with
    // the token that rotation installed (AAP 0.3.3). `live` keeps a rotation that finishes after the
    // traveler changed from drawing its photo over the next one's pattern.
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
      // Abandoned when the traveler changes and released on unmount: no request outlives the render
      // that asked for it, and no object URL is left for the browser to hold.
      live = false;
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [nearViewport, photoUserId]);
  /**
   * Reacts to a native image load that failed, by joining the session's rotation once for this
   * traveler (AAP 0.3.3, AAP 0.5.4).
   *
   * An image load reports no status on iOS or Android, so a failed load is the only signal a stale
   * access token produces there, and that leaves a rotation as the one recovery available. The retry
   * is bounded to one per traveler per mount: the same traveler failing again falls through to the
   * generated pattern, and so does a rotation the session refuses. Because {@link refreshSession} is
   * single-flight, a list of avatars failing at once spends one rotation between them rather than one
   * each.
   */
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
  // The source to draw, or null for the pattern. Native carries the bearer token on the source, which
  // React Native sends on iOS and Android; web shows the object URL the effect built, because
  // react-native-web cannot send a header on an image.
  const photoSource: ImageSourcePropType | null = useMemo(() => {
    if (photoUserId === null || failedPhotoUserId === photoUserId) return null;
    if (Platform.OS === 'web') {
      return webPhoto !== null && webPhoto.userId === photoUserId ? { uri: webPhoto.url } : null;
    }
    // A retry whose rotation is still running draws the pattern: with `rotations` at 1 the request
    // below is rebuilt from the token the rotation installed, and drawing nothing until then is what
    // replaces the failed image instead of re-offering it the same stale header.
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
              // Web recovered inside the loader, so an error here is bytes that do not decode: the
              // pattern is the fallback, as it is for a native retry that failed twice.
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
    // A pill radius on a square frame is half its side, so one static value rounds every avatar from
    // the smallest frame a list row draws to the largest a profile header does.
    borderRadius: radii.pill,
    // Clips the pattern and the photo to that circle on both platforms. Android needs a fill for the
    // clip to apply, which the frame paints from the pattern's own background token.
    overflow: 'hidden',
  },
  photo: {
    // Shows while a photo is still loading, and under one whose bytes the image loader cannot
    // decode, in place of an empty frame.
    backgroundColor: colors.surface,
  },
});
