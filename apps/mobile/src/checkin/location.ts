/**
 * Device coordinates for witnessed check-in (AAP 0.3.4, AAP 0.5.1, AAP 0.5.7).
 *
 * The app's only reader of the device position, read only when the user submits a check-in. The coordinates leave no
 * trace: nothing here persists them, nothing logs them and no module-level variable holds them, so a fix lives for
 * exactly the one awaited call.
 * The 150 m geofence and the window from 15 minutes before to 45 minutes after the meetup's start are the server's own
 * decision, so a fix from the wrong place fails the check-in as `422 outside_geofence` rather than meeting a submit
 * button that never appears. Permission is foreground only, from the `expo-location` config plugin in `app.config.ts`,
 * which also keeps background location blocked; one implementation serves all three platforms, because that package
 * already ships a web module over `navigator.geolocation`.
 */
import * as Location from 'expo-location';
import type { LatLng } from '@tablemate/shared';
export type LocationErrorCode = 'location_denied' | 'location_unavailable' | 'location_timeout';

export class LocationError extends Error {
  readonly code: LocationErrorCode;
  constructor(code: LocationErrorCode) {
    super(code);
    this.name = 'LocationError';
    this.code = code;
    Object.setPrototypeOf(this, LocationError.prototype);
  }
}

export const LOCATION_TIMEOUT_MS = 15_000;
const PERMISSION_DENIED_CODE = 1;
/**
 * Called only by the check-in screen, at the moment the user submits, because submitting is the only
 * point at which the app may ask for location (AAP 0.3.4). The server range-checks both numbers and
 * measures the pair against the venue's 150 m geofence, so this reads and returns a fix without
 * judging it, and neither the pair nor any part of the position object is stored or logged.
 *
 * @throws LocationError `location_denied` when the foreground permission is refused,
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
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new LocationError('location_unavailable');
  }
  return { lat: latitude, lng: longitude };
}

/**
 * A probe that cannot answer at all counts as go: `expo-location`'s web module answers the permission
 * query only where `navigator.permissions` exists, and a browser may refuse a query for a permission
 * name it does not support, which read as a refusal would block check-in on a browser that does
 * support geolocation. The request for the fix below is the real decision.
 */
async function probePasses(ask: () => Promise<boolean>): Promise<boolean> {
  try {
    return await ask();
  } catch {
    return true;
  }
}

/**
 * `getCurrentPositionAsync` takes no timeout option, so the bound is a race against a timer the
 * `finally` clears on every path. The device's last known position is deliberately neither requested
 * nor consulted: a cached fix can be hours old, and check-in asks where the user is now.
 */
async function positionWithinTimeout(): Promise<Location.LocationObject> {
  const position = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
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
 * Drops the provider's own error: its message may name a provider, a device setting or a network,
 * and none of that belongs in a client error or a log line. A refusal is recognised by its code —
 * Expo reports `E_LOCATION_UNAUTHORIZED`-shaped strings, a browser the numeric
 * `PERMISSION_DENIED` constant — and every other failure becomes `location_unavailable`.
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
