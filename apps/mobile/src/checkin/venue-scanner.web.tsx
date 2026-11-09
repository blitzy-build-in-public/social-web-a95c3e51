/**
 * The venue scanner, web half of the `venue-scanner` platform pair (AAP 0.3.2, AAP 0.3.4, AAP 0.5.8).
 *
 * Metro resolves the check-in screen's extensionless `../../../src/checkin/venue-scanner` to this
 * file in the browser, and this half renders no scanner: the screen's manual 6-digit field is the
 * whole of the browser's code entry, which is the guaranteed path on every browser (AAP 0.3.4,
 * "Web code scanning").
 *
 * It renders nothing rather than opening the camera because `expo-camera` 16.0.18's web scanner
 * cannot start in this app's own delivered configuration. That build evaluates, at module load,
 * `createWorkerAsyncFunction(qrWorkerMethod, ['https://cdn.jsdelivr.net/npm/jsqr@1.2.0/dist/jsQR.min.js'])`,
 * so importing it constructs a Blob worker whose first statement is `importScripts` of that CDN
 * URL and posts it to `new Worker(...)`. `infra/nginx/web.conf` serves the app
 * `worker-src 'self' blob:` with `script-src 'self' …`, so the load is refused and every visit to
 * the check-in screen would log an uncaught `NetworkError: Failed to execute 'importScripts' …`.
 * Serving that worker instead would mean granting the page a third-party CDN the client otherwise
 * takes no runtime dependency on: the web client reaches the API, the proving artefacts and Stripe
 * and nothing else (AAP 0.3.2). Bundling a decoder of our own is the third option, and AAP 0.3.4
 * asks it of no browser: camera scanning is offered "where `expo-camera` web scanning works".
 *
 * Nothing here is a stub awaiting a later scanner. Manual entry is the guaranteed path on every
 * browser (AAP 0.3.4), so this half is the no-op that keeps the pair's one export resolving on the
 * web while the native half owns the camera.
 */
import type { VenueScannerComponent } from './venue-scanner.native';

/*
 * The types a screen may name are the native half's, re-exported rather than restated, so the two
 * halves of the pair cannot drift apart (AAP 0.5.1).
 */
export type { VenueScannerComponent, VenueScannerProps } from './venue-scanner.native';

/**
 * The web implementation of the pair's one export: it renders no scanner at all, so the manual
 * 6-digit field is the browser's only code entry (AAP 0.3.4). Nothing is drawn in its place,
 * because the field the screen already renders is the whole of what the web needs.
 *
 * The {@link VenueScannerComponent} annotation holds the two halves together at compile time: a
 * change that this half no longer implements fails the build here.
 */
export const VenueScanner: VenueScannerComponent = () => null;
