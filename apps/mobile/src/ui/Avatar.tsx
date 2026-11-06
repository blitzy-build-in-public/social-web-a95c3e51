/**
 * `Avatar` — a traveler's picture: a pattern generated from the avatar seed the API assigned, with
 * the tier-2 profile photo drawn over it when the API reported one (AAP 0.1.1, AAP 0.5.4, AAP 0.8.1).
 *
 * What is drawn follows from the API and never from the client: `hasPhoto` is used exactly as it
 * arrived and the bytes are requested only for it, because disclosure is enforced at field level by
 * the API (AAP 0.5.4, criterion 5) and a tier-1 profile carries no such field. The pattern is a pure
 * function of `avatarSeed`, so one traveler draws the same mosaic in every render and nothing is
 * stored, uploaded or fetched for a profile without a photo (AAP 0.1.1).
 *
 * Only native can send a header with an image, so the photo loads differently per platform: native
 * hands the bearer token to `Image`, while react-native-web cannot and the effect fetches the bytes
 * and shows them from an object URL it revokes. A load that fails — a `404` after the viewer's tier
 * dropped, a network error, bytes that do not decode — falls back to the pattern silently, with
 * nothing about the failure logged (AAP 0.5.5). Colours, radius and size come from
 * `@tablemate/shared`'s tokens, and the palette names only pairs recorded in `CONTRAST_PAIRS`.
 */
import { useEffect, useMemo, useState } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import type { ImageSourcePropType, ViewProps } from 'react-native';
import { Rect, Svg } from 'react-native-svg';
import { colors, radii } from '@tablemate/shared';
import type { ColorToken } from '@tablemate/shared';

import { userPhotoRequest } from '../api/client';

/**
 * Props of {@link Avatar}.
 */
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
   * Whether the API reported a photo: pass the profile's own `hasPhoto` through unchanged
   * (AAP 0.5.4). Absent or false draws the generated pattern.
   */
  hasPhoto?: boolean;

  /** Whether a parent already names the traveler; a decorative avatar is hidden from screen readers. */
  decorative?: boolean;

  /** Test handle, forwarded to the frame (`avatar-<userId>`, ...). */
  testID?: string;
}

/** The frame's side in points / CSS px when the caller names none. */
const DEFAULT_SIZE = 40;

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
 * `Math.imul` keeps every step in 32-bit integer arithmetic, where a plain `*` would round the low
 * bits away above 2^53 and draw a different pattern per engine; nothing here reads the clock, a
 * random source or the platform, so one seed draws one pattern everywhere.
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
 * Pure and deterministic, so the same seed returns the same pattern in every call and on every
 * platform. The low 15 bits of the hash fill the left three columns of each row, the right-hand two
 * mirror them, and the palette is taken from the bits above those.
 *
 * @param seed - The profile's `avatarSeed`, exactly as the API returned it.
 * @returns The colours and the cells to paint.
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
 * A standalone avatar is one image named `Avatar of <handle>`: React Native reads `role="img"` as the
 * image trait on iOS and as its image role on Android, and react-native-web renders `role="img"` with
 * `aria-label`, so it is announced once, under the same name, on all three. A decorative avatar — one
 * inside a row that already names the traveler — leaves the accessibility tree instead; React Native
 * maps `aria-hidden` onto `accessibilityElementsHidden` and
 * `importantForAccessibility="no-hide-descendants"`, and naming the second one states the Android
 * intent where the frame is written.
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
 * Hides the drawn picture from assistive technology, so the frame is announced once rather than once
 * more from inside it.
 *
 * Native reads a different prop per platform — `accessibilityElementsHidden` on iOS,
 * `importantForAccessibility` on Android — while react-native-web renders the ARIA attribute alone.
 * The two React Native props are left off web on purpose: react-native-svg's web element would
 * otherwise emit them into the DOM as invalid attributes, which React reports as a warning on every
 * render of every avatar.
 */
const HIDDEN_FROM_ASSISTIVE_TECH: Pick<
  ViewProps,
  'aria-hidden' | 'accessibilityElementsHidden' | 'importantForAccessibility'
> =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no' };

/**
 * The photo request for a traveler, or `null` when the API origin is not configured.
 *
 * {@link userPhotoRequest} reads the configured origin, a build-time value `app.config.ts` validates;
 * a build that shipped without it makes that call throw, and a missing photo URL then costs the photo
 * rather than the row it is drawn in.
 */
function photoRequest(userId: string): { url: string; headers: Record<string, string> } | null {
  try {
    return userPhotoRequest(userId);
  } catch {
    return null;
  }
}

/**
 * Renders a traveler's avatar: the generated pattern, or the API's photo once it has loaded.
 *
 * The photo is requested only for what the API itself reported — `hasPhoto` exactly as it arrived, and
 * an id to request the bytes with — and a load that fails falls back to the pattern with nothing logged
 * (AAP 0.3.2, AAP 0.5.4, AAP 0.5.5). On web the bytes are fetched with the bearer header and shown from
 * an object URL, which the effect revokes when the traveler changes or the component unmounts.
 *
 * The frame reserves exactly `size` × `size` and clips to a circle, so a list of avatars lines up on
 * whatever is drawn inside, and no text in it has to follow the reader's font size.
 *
 * @param props - {@link AvatarProps}.
 * @returns The avatar element.
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

  // Web holds the fetched bytes as an object URL, tagged with the traveler it belongs to, so a
  // previous row's photo is never drawn over the next one's pattern while it loads.
  const [webPhoto, setWebPhoto] = useState<{ userId: string; url: string } | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || photoUserId === null) return undefined;
    const request = photoRequest(photoUserId);
    if (request === null) return undefined;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let live = true;
    void fetch(request.url, { headers: request.headers, signal: controller.signal })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!live || blob === null) return;
        objectUrl = URL.createObjectURL(blob);
        setWebPhoto({ userId: photoUserId, url: objectUrl });
      })
      // Silent by design: a refused or failed load leaves the generated pattern in place, and
      // neither the id, the URL, the token nor the status reaches a log (AAP 0.5.5).
      .catch(() => undefined);
    return () => {
      // Abandoned when the traveler changes and released on unmount: no request outlives the render
      // that asked for it, and no object URL is left for the browser to hold.
      live = false;
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [photoUserId]);

  // The source to draw, or null for the pattern. Native carries the bearer token on the source, which
  // React Native sends on iOS and Android; web shows the object URL the effect built, because
  // react-native-web cannot send a header on an image.
  const photoSource: ImageSourcePropType | null = useMemo(() => {
    if (photoUserId === null || failedPhotoUserId === photoUserId) return null;
    if (Platform.OS === 'web') {
      return webPhoto !== null && webPhoto.userId === photoUserId ? { uri: webPhoto.url } : null;
    }
    const request = photoRequest(photoUserId);
    return request === null ? null : { uri: request.url, headers: request.headers };
  }, [failedPhotoUserId, photoUserId, webPhoto]);

  return (
    <View
      {...frameAccessibility(decorative, handle)}
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
          onError={() => setFailedPhotoUserId(photoUserId)}
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
    // a 40-point list row to a 96-point profile header.
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
