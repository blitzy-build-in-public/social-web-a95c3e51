/**
 * Tablemate Expo app configuration. The Expo CLI evaluates this file for `expo start`, `expo config`, `expo prebuild`,
 * `expo export` and `eas build`, and it validates the build-time environment there, so a build fails with the name of
 * the variable it needs instead of producing a bundle that cannot reach the API.
 *
 * Required: `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_WS_URL`. Optional: `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
 * `EXPO_PUBLIC_ZK_BENCH` and `EAS_PROJECT_ID`, which is the one value that reaches the config object.
 * The file stays self-contained on purpose: the config loader transpiles this one file, so no workspace package and no
 * schema library is in reach of it. Validated values are deliberately not copied into `extra`: `babel-preset-expo`
 * inlines `process.env.EXPO_PUBLIC_*` into the bundle, and the client reads them there.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';
/**
 * Treating unset, empty and whitespace-only values alike: compose and EAS both pass `""` for a variable they
 * leave unset, and an empty string must not reach a check as a value.
 */
function readEnv(name: string): string | undefined {
  // Narrowed by hand: under the Expo program's types an environment read arrives as `any`, and
  // `typeof` is what makes a compose-supplied empty string a missing value rather than a value.
  const raw: unknown = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/** Reads a required variable. Every message names the variable, never the value it holds. */
function requireEnv(name: string, hint: string): string {
  const value = readEnv(name);
  if (value === undefined) {
    throw new Error(`${name} is required: ${hint}`);
  }
  return value;
}

/**
 * The clients append to both service bases (`<api>/v1/...` and `<ws>/v1/chat`), so a configured path, query or
 * fragment would silently move every route.
 */
function assertOrigin(
  name: string,
  value: string,
  protocols: readonly string[],
  hint: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} ${hint}`);
  }
  const hasOriginForm = parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  if (!protocols.includes(parsed.protocol) || !hasOriginForm) {
    throw new Error(`${name} ${hint}`);
  }
}

/** Stripe publishable keys are the only Stripe material the app ever holds. */
const STRIPE_PUBLISHABLE_KEY = /^pk_(test|live)_[A-Za-z0-9_]+$/;
/**
 * Optional. The default local stack runs `STRIPE_MODE=mock`, where no card can be confirmed and the card
 * screens say that payments are not configured; with Stripe in test mode the key is required for a hold to
 * authorize in the UI. A secret key is rejected outright rather than merely failing the pattern: it must never
 * reach a device bundle or a web page.
 */
function assertStripePublishableKey(value: string | undefined): void {
  if (value === undefined) return;
  if (/^(sk|rk)_/.test(value)) {
    throw new Error(
      'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY must not be a Stripe secret key; the app holds only the publishable key',
    );
  }
  if (!STRIPE_PUBLISHABLE_KEY.test(value)) {
    throw new Error(
      'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY must be a Stripe publishable key, e.g. pk_test_replace_me',
    );
  }
}

/**
 * Optional, `'0'` or `'1'`, absent means `'0'`. `'1'` belongs to the `bench` build profile alone: it exposes
 * the device proving-benchmark screen and is what permits cleartext artefact downloads from a release build.
 */
function readZkBenchFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value !== '0' && value !== '1') {
    throw new Error("EXPO_PUBLIC_ZK_BENCH must be '0' or '1'");
  }
  return value === '1';
}

/**
 * Throws on the first invalid variable, and returns only what the config itself consumes.
 */
function readBuildEnv(): { zkBench: boolean } {
  assertOrigin(
    'EXPO_PUBLIC_API_URL',
    requireEnv('EXPO_PUBLIC_API_URL', 'set it to the API origin, e.g. http://localhost:3000'),
    ['http:', 'https:'],
    'must be the API origin, e.g. http://localhost:3000',
  );
  assertOrigin(
    'EXPO_PUBLIC_WS_URL',
    requireEnv(
      'EXPO_PUBLIC_WS_URL',
      'set it to the WebSocket base the client appends /v1/chat to, e.g. ws://localhost:3000',
    ),
    ['ws:', 'wss:'],
    'must be the WebSocket base, e.g. ws://localhost:3000',
  );
  assertStripePublishableKey(readEnv('EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY'));
  return { zkBench: readZkBenchFlag(readEnv('EXPO_PUBLIC_ZK_BENCH')) };
}

/**
 * `config` is whatever static config the loader merged in (this app is configured here alone, so it is empty)
 * and every field below is applied on top of it.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const { zkBench } = readBuildEnv();
  const easProjectId = readEnv('EAS_PROJECT_ID');
  return {
    ...config,
    name: 'Tablemate',
    slug: 'tablemate',
    version: '0.1.0',
    // Magic links arrive at tablemate://auth/verify?token=… and the benchmark screen
    // is reached at tablemate://dev/zk-bench.
    scheme: 'tablemate',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    // Expo SDK 52's default for a new app, and the architecture the native prover
    // module is built against.
    newArchEnabled: true,
    // No app icon, splash or adaptive icon: the native targets ship no image assets,
    // so Expo's own defaults stand in. The web export does serve a favicon, copied
    // verbatim from `apps/mobile/public/favicon.ico` into the export's root.
    ios: {
      bundleIdentifier: 'com.tablemate.app',
      supportsTablet: false,
      infoPlist: {
        // "Open in" from Mail or Files hands the .eml to the proof import screen.
        CFBundleDocumentTypes: [
          {
            CFBundleTypeName: 'Email message',
            CFBundleTypeRole: 'Viewer',
            LSHandlerRank: 'Alternate',
            LSItemContentTypes: ['public.email-message'],
          },
        ],
        // iOS then copies a file opened from another app into Documents/Inbox/ instead
        // of handing over the original. That copy is app-owned, and the .eml intake
        // deletes it after every attempt, on success, failure and cancel alike.
        LSSupportsOpeningDocumentsInPlace: false,
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      },
    },
    android: {
      package: 'com.tablemate.app',
      intentFilters: [
        {
          action: 'VIEW',
          category: ['DEFAULT'],
          data: [
            { scheme: 'content', mimeType: 'message/rfc822' },
            { scheme: 'file', mimeType: 'message/rfc822' },
          ],
        },
      ],
      // Location is read only on the check-in screen and nothing records audio, so
      // these are blocked rather than merely unused: no library manifest may add them
      // back. Each is merged into the manifest with tools:node="remove".
      blockedPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.ACCESS_BACKGROUND_LOCATION',
      ],
    },
    // A single-page export: the nginx image answers every route with index.html, and
    // static rendering would execute the native-only screens at export time. Single-page output is how
    // a route is served, not how the graph behind it is built: the web graph splits by route, which is
    // the `extra.router` note below.
    web: { bundler: 'metro', output: 'single' },
    experiments: { typedRoutes: false },
    plugins: [
      'expo-router',
      // Android target 34 and Xcode 16.4 sit below the current Play Store (target API 36)
      // and App Store (Xcode 26) minimums. This app builds for development and internal
      // distribution only; raising those floors is not part of this build.
      [
        'expo-build-properties',
        {
          ios: { deploymentTarget: '16.0' },
          android: {
            minSdkVersion: 29,
            compileSdkVersion: 35,
            targetSdkVersion: 34,
            buildToolsVersion: '35.0.0',
            usesCleartextTraffic: zkBench,
          },
        },
      ],
      // Share-sheet intake of one .eml. The filter is declared here even though the
      // plugin's type union lists only the text/*, image/*, video/* and */* families:
      // it writes each value through as android:mimeType unchanged.
      [
        'expo-share-intent',
        {
          iosActivationRules: { NSExtensionActivationSupportsFileWithMaxCount: 1 },
          androidIntentFilters: ['message/rfc822'],
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission: 'Tablemate uses the camera only to scan the venue check-in code.',
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Tablemate checks your location only when you check in, to confirm you are at the venue.',
          isIosBackgroundLocationEnabled: false,
          isAndroidBackgroundLocationEnabled: false,
          isAndroidForegroundServiceEnabled: false,
        },
      ],
      'expo-notifications',
      [
        'expo-image-picker',
        {
          photosPermission:
            'Tablemate lets you choose a profile photo. Location data is removed before upload.',
          microphonePermission: false,
        },
      ],
      ['@stripe/stripe-react-native', { merchantIdentifier: [], enableGooglePay: false }],
    ],
    // Only the EAS project id and the router's split setting belong here, and no secret does: the app
    // holds the Stripe publishable key and nothing else.
    //
    // `asyncRoutes` is read per platform, which is why it is stated per platform. The web export turns
    // it on, so every route under `app/` becomes its own chunk and a chunk is fetched when its route is
    // entered: the first load then carries the entry route's own code and the app shell, instead of the
    // operator dashboard, the proving client and the payment screens as well. Native keeps the default
    // `false`, because a React Native bundle cannot split its route graph. The runtime that fetches a
    // split chunk is `@expo/metro-runtime`, a dependency of this app, and an exported chunk is loaded
    // by injecting a same-origin `<script>` element.
    extra: {
      ...(easProjectId === undefined ? {} : { eas: { projectId: easProjectId } }),
      router: { asyncRoutes: { web: true, default: false } },
    },
  };
};
