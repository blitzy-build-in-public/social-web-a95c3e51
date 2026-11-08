# Platform notes

Client platform targets, the settings that hold them, and every deviation from the request's
capability list, each with what differs, why, and the fallback the request permits. Proving and
verification measurements are in [`zk-performance.md`](./zk-performance.md), and the criteria these
notes feed are in [`acceptance.md`](./acceptance.md).

## Targets

| Platform | Floor                                                                                            | Enforced by                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| iOS      | 16.0                                                                                             | `ios.deploymentTarget` in `apps/mobile/app.config.ts`, through `expo-build-properties` 0.13.3                |
| Android  | 10 (API 29)                                                                                      | `android.minSdkVersion` there, and `minSdkVersion` in `modules/tablemate-prover/android/build.gradle`        |
| Web      | desktop Chrome, Firefox and Safari, each at its current stable release and previous stable major | the `chromium`, `firefox` and `webkit` projects of `apps/mobile/playwright.config.ts`, plus the manual check |

The request's "two latest" browser versions are read as the desktop releases of those three browsers,
because the native apps serve phones (AAP 0.3.4), and the pair is the current one at a validation run.
Local proving is required on every one of them: a browser that cannot complete it is a defect against
the capability, never a permitted exception, and proving never moves to the server.

## Build settings

From the `expo-build-properties` entry in `apps/mobile/app.config.ts`: iOS deployment target 16.0, and
Android `minSdkVersion` 29, `compileSdkVersion` 35, `targetSdkVersion` 34 (the Expo SDK 52 values) and
`buildToolsVersion` 35.0.0. The New Architecture is on (`newArchEnabled: true`), which is what the native
prover module is built against, and the web build is a single-page Metro export
(`web: { bundler: 'metro', output: 'single' }`) whose nginx headers carry `worker-src 'self' blob:` and
`'wasm-unsafe-eval'` for the proving Worker and snarkjs.

Toolchain: Xcode 16.4 (`packages/circuits/scripts/native-smoke.sh`), Android NDK 26.1.10909125
(`packages/circuits/scripts/build-native.sh`), JDK 17 (Temurin 17.0.21+9) for the React Native 0.76.9
build, and Node.js 22.23.4 (`.nvmrc`, the root `engines`). Android removes `RECORD_AUDIO` and
`ACCESS_BACKGROUND_LOCATION` from the merged manifest, and iOS sets
`LSSupportsOpeningDocumentsInPlace: false`, so a document opened from another app is copied into
`Documents/Inbox/` — a copy the `.eml` intake owns and deletes.

Native builds are development and internal ones, from the three `build` profiles `apps/mobile/eas.json`
defines and no others: `development` (development client, internal, iOS simulator, Android `apk`,
`EXPO_PUBLIC_ZK_BENCH=0`), `bench` (no development client, iOS `Release` on the simulator, Android
`:app:assembleRelease`, `EXPO_PUBLIC_ZK_BENCH=1`), and `bench-device` (extends `bench` with
`ios.simulator: false`, so it needs Apple signing).

## Capability matrix

| Capability        | iOS                                                                                                                                                                                           | Android                                                                                                     | Web                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `.eml` import     | `expo-document-picker` 13.0.3 with `copyToCacheDirectory: false`, plus the share sheet and "Open in" through `expo-share-intent` 3.2.3 and `CFBundleDocumentTypes` for `public.email-message` | the same picker and share intake, with `VIEW` intent filters for `message/rfc822` over `content` and `file` | the picker's file input only, accepting `message/rfc822` and `.eml`; with no share target, `fromShareIntent` answers `share_intake_unsupported` |
| On-device proving | the autolinked `tablemate-prover` module: `generateProof` over rapidsnark and `rust-witness`, plus `sha256File`                                                                               | the same module for `arm64-v8a` and `x86_64`; `isProverAvailable()` is false on any other ABI               | snarkjs 0.7.6 in the dedicated Web Worker `src/zk/prover.worker.ts`                                                                             |
| Code scan         | `expo-camera` 16.0.18 (`CameraView`, `barcodeTypes: ['qr']`) beside the 6-digit field                                                                                                         | the same scanner beside the same field                                                                      | manual 6-digit entry alone: no scanner is rendered when `Platform.OS === 'web'`                                                                 |
| Location          | `expo-location` 18.0.10, foreground permission only, requested on the check-in screen and nowhere else                                                                                        | the same                                                                                                    | the same package's web module over `navigator.geolocation`, with the browser's own prompt                                                       |
| Notifications     | Expo push over APNs, one `getExpoPushTokenAsync()` token posted to `POST /v1/me/push-tokens`                                                                                                  | Expo push over FCM, the same registration                                                                   | email from the workers' SMTP sender; `src/notifications/register.web.ts` is a no-op with no request                                             |
| Card holds        | PaymentSheet in setup mode (`initPaymentSheet` with customer id, ephemeral key and SetupIntent secret, then `presentPaymentSheet`), then `handleNextAction`                                   | the same                                                                                                    | Payment Element in setup mode over Stripe.js, then `stripe.handleNextAction({ clientSecret })`                                                  |

## Deviations

### Web share sheet

**Deviation:** a browser has no file share target, so web import is the picker alone and
`fromShareIntent` there answers `share_intake_unsupported`. **Reason:** no browser API hands a file to a
page from another application. **Permitted fallback:** the request offers the picker or the share sheet,
so the picker satisfies it on web; the share sheet runs on iOS and Android.

### Web code scanning

**Deviation:** the check-in screen offers the 6-digit field alone on web, with no camera scanner.
**Reason:** Safari and Firefox ship no dependable barcode-detection API, so a scanner would work on one
engine and not the others. **Permitted fallback:** the request allows an attendee to "scan or enter";
manual entry is the guaranteed path on all three engines, and the code is validated on the server clock.

### Web proving memory

**Deviation:** none, but the memory profile is recorded as a risk — the complete proving key is resident
in the Worker's memory while it proves, with the witness and prover buffers on top. **Reason:** snarkjs
0.7.6 reads a key through fastfile, whose `bigMem` form holds the whole file, so OPFS can stream the
download but not feed the prover page by page. **Handling:** the Worker streams the circuit WASM and the
key into OPFS, hashing each with `@noble/hashes` as it arrives, then reads the key in 4 MiB pages
(`1 << 22`, fastfile's own page size) into one `bigMem` object for `groth16.prove` and builds the witness
with `wtns.calculate` over a `mem`-form WASM. The page's main thread never holds the key, and it
terminates the Worker after every attempt or cancellation. A browser that cannot finish the proof is
recorded `fail` in [`zk-performance.md`](./zk-performance.md) — WebKit is in that state today.

### Web notifications

**Deviation:** the web client registers no push token; `registerForNotifications` resolves at once with
no device token and no request. **Reason:** the web has no push service here and the app registers no
service worker of its own. **Permitted fallback:** the request names email for web, which the workers'
SMTP sender delivers; native builds use Expo push over APNs and FCM.

### Native prover requires development builds

**Deviation:** native proving works only in a `development` or `bench` build; Expo Go cannot run it.
**Reason:** `tablemate-prover` is a local Expo module carrying the Rust prover through JNI and CocoaPods,
and Expo Go loads no custom native module. **Permitted fallback:** the Expo SDK 52 integration of mopro
0.3.7 with `rust-witness` and rapidsnark is gated by `packages/circuits/scripts/native-smoke.sh`, whose
per-platform `pass` is what permits further native-prover work (AAP 0.2.4). A platform whose check has not
passed stays `pending` and its users stay unverified.

### Store submission gap

**Deviation:** the shipped configuration misses current store minimums, so the app produces development
and internal builds only. **Reason:** Google Play requires target API 36 for new apps and updates from
2026-08-31, and App Store Connect requires Xcode 26 and the iOS 26 SDK from 2026-04-28, while this build
uses the Expo SDK 52 values (target API 34, Xcode 16.4) the request pins; whether SDK 52 builds and runs
correctly with raised targets or Xcode 26 is unverified. **Permitted fallback:** the request's delivery
form is local, so images, EAS development builds and internal distributions are what this run produces,
and store submission is out of scope (AAP 0.7.2). `apps/mobile/app.config.ts` records the same limits
beside the plugin that sets them.

## Build workarounds

- **The web proving Worker is a Metro entry of its own.** SDK 52's Metro does not bundle
  `new Worker(new URL('./prover.worker.ts', import.meta.url))` — Worker bundling arrived with SDK 53 and
  `import.meta` is not transformed in 52. `apps/mobile/src/zk/artifacts.web.ts` owns the URL, and the app's
  `export:worker` script emits the file separately — `expo export:embed --platform web --entry-file` with
  `src/zk/prover.worker.ts` and `--bundle-output public/prover.worker.js` — before `export:web` copies it
  in. In development the same file loads from Metro's own bundle of that entry.
- **Metro package exports.** `apps/mobile/metro.config.cjs` sets `unstable_enablePackageExports = true`
  and prepends `tablemate-source` to `unstable_conditionNames`, so workspace packages resolve to their
  TypeScript source and the web bundle takes snarkjs's `browser` condition; it also adds `eml` to
  `resolver.assetExts` for the benchmark's fixture. No Node built-in shim or `extraNodeModules` polyfill
  is configured, so a native bundle reaching `snarkjs` fails on its Node build rather than resolving one.
- **Module layout.** `pnpm-workspace.yaml` sets `nodeLinker: hoisted`, because Expo SDK 52's Metro and
  native autolinking do not work with pnpm's isolated layout, and `metro.config.cjs` and
  `babel.config.cjs` carry their extensions because `apps/mobile/package.json` declares `"type": "module"`.
