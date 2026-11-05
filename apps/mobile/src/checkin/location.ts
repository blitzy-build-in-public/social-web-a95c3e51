/**
 * Device coordinates for witnessed check-in (AAP 0.3.4, AAP 0.5.1, AAP 0.5.7).
 *
 * This module is the app's only reader of the device position, and it reads one only when the user
 * submits a check-in. The coordinates are returned and leave no trace: nothing here persists them
 * (no AsyncStorage, SecureStore, `localStorage` or file), nothing logs them, and no module-level
 * variable holds them, so a fix lives for exactly the one awaited call (AAP 0.1.1, AAP 0.12.2).
 *
 * The 150 m geofence and the window from 15 minutes before to 45 minutes after the meetup's start
 * are decided by the server alone (AAP 0.5.7). This module reports what the device says and never
 * pre-checks the distance, so a fix from the wrong place fails the check-in as
 * `422 outside_geofence` instead of a submit button that never appears.
 *
 * Permission is foreground only. The usage strings come from the `expo-location` config plugin in
 * `app.config.ts`, which also keeps background location blocked; no call here requests background
 * access.
 *
 * One implementation serves iOS, Android and web, because `expo-location` already ships a web
 * module over `navigator.geolocation`: the browser shows its own prompt, geolocation needs a
 * secure context (HTTPS or localhost), and the Playwright criterion 1 walk grants the permission
 * and sets the venue coordinates on the browser context.
 */
import * as Location from 'expo-location';

import type { LatLng } from '@tablemate/shared';

/**
 * Why a position could not be read. Each value is also the `snake_case` code a screen can map to
 * its own copy; only `location_denied` is something the user can resolve.
 */
export type LocationErrorCode = 'location_denied' | 'location_unavailable' | 'location_timeout';

/**
 * The only rejection {@link currentCoords} produces. It carries a code and nothing else — no
 * coordinate, no accuracy radius, no provider message — so a screen can render it and a log record
 * it without leaking a position.
 */
export class LocationError extends Error {
  /** Which failure this is; always equal to {@link Error.message}. */
  readonly code: LocationErrorCode;

  constructor(code: LocationErrorCode) {
    super(code);
    this.name = 'LocationError';
    this.code = code;
    // Babel compiles a class to a function whose prototype chain `new.target` does not walk, so
    // `instanceof LocationError` would be false in a Metro bundle without this line.
    Object.setPrototypeOf(this, LocationError.prototype);
  }
}

/**
 * How long one fresh fix is awaited before the attempt fails with `location_timeout`.
 *
 * The check-in window closes 45 minutes after the meetup starts (AAP 0.5.7), so a fix that has not
 * arrived in 15 seconds is not worth holding the screen for: the user can retry at once, and the
 * server re-reads the same window on every attempt.
 */
export const LOCATION_TIMEOUT_MS = 15_000;

/** The numeric `GeolocationPositionError.PERMISSION_DENIED` a browser rejects with. */
const PERMISSION_DENIED_CODE = 1;

/**
 * The current device position, as the `lat`/`lng` pair `CheckInRequest` carries.
 *
 * Called only by the check-in screen (`app/meetups/[id]/check-in.tsx`), at the moment the user
 * submits, because submitting is the only point at which the app may ask for location
 * (AAP 0.3.4). The server range-checks both numbers and measures the pair against the venue's
 * 150 m geofence, so this function reads and returns a fix without judging it.
 *
 * @returns A new coordinate pair; nothing else about the fix is exposed, and neither the pair nor
 *   any part of the underlying position object is stored or logged.
 * @throws LocationError with code `location_denied` when the foreground permission is refused,
 *   `location_unavailable` when location services are off or the device reports no usable fix, and
 *   `location_timeout` when no fix arrives within {@link LOCATION_TIMEOUT_MS}.
 */
export async function currentCoords(): Promise<LatLng> {
  const granted = await probePasses(
    async () => (await Location.requestForegroundPermissionsAsync()).granted,
  );
  if (!granted) {
    throw new LocationError('location_denied');
  }

  const servicesOn = await probePasses(() => Location.hasServicesEnabledAsync());
  if (!servicesOn) {
    throw new LocationError('location_unavailable');
  }

  const { latitude, longitude } = (await positionWithinTimeout()).coords;
  // A provider that answers with a non-finite value gets no further than here: the server would
  // reject such a pair, and a screen showing "not a number" is worse than a retry prompt.
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new LocationError('location_unavailable');
  }

  return { lat: latitude, lng: longitude };
}

/**
 * Reads a pre-flight probe — may this app read the position, are location services on — as a
 * go/no-go answer, where a probe that cannot answer at all counts as go.
 *
 * `expo-location`'s web module answers the permission query only where `navigator.permissions`
 * exists, and a browser may refuse a query for a permission name it does not support. Treating
 * that as a refusal would block check-in on a browser that does support geolocation. The request
 * for the fix below is the real decision: it prompts the browser, and a refusal arrives from it as
 * a denial, which {@link toLocationError} maps.
 *
 * @param ask - The probe, resolved to its boolean answer.
 * @returns The probe's answer, or `true` when the probe threw.
 */
async function probePasses(ask: () => Promise<boolean>): Promise<boolean> {
  try {
    return await ask();
  } catch {
    return true;
  }
}

/**
 * One fresh fix, awaited by no longer than {@link LOCATION_TIMEOUT_MS}.
 *
 * `getCurrentPositionAsync` takes no timeout option, so the bound is a race against a timer that
 * the `finally` clears on every path. The device's last known position is deliberately neither
 * requested nor consulted: a cached fix can be hours old, and check-in asks where the user is now.
 *
 * @returns The position object, as `expo-location` reports it.
 * @throws LocationError `location_timeout` when the timer wins, or whatever
 *   {@link toLocationError} makes of the provider's failure.
 */
async function positionWithinTimeout(): Promise<Location.LocationObject> {
  const position = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  // A fix that lands after the timer won — or a provider failure that lands with it — is discarded
  // silently. Without a handler the rejection would surface as an unhandled promise rejection.
  void position.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LocationError('location_timeout')), LOCATION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([position, expiry]);
  } catch (error) {
    throw toLocationError(error);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Turns a failure from the position request into a {@link LocationError}, dropping the provider's
 * own error: its message may name a provider, a device setting or a network, and none of that
 * belongs in a client error or in a log line.
 *
 * A refusal is recognised by its code — Expo reports `E_LOCATION_UNAUTHORIZED`-shaped string codes,
 * a browser reports the numeric `PERMISSION_DENIED` constant — and every other failure, including
 * an unknown shape, becomes `location_unavailable`.
 *
 * @param error - The caught value, of unknown shape.
 * @returns A LocationError, never the value it was given.
 */
function toLocationError(error: unknown): LocationError {
  if (error instanceof LocationError) {
    return error;
  }

  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /UNAUTHORIZED|PERMISSION/.test(code)) {
    return new LocationError('location_denied');
  }
  if (code === PERMISSION_DENIED_CODE) {
    return new LocationError('location_denied');
  }

  return new LocationError('location_unavailable');
}
