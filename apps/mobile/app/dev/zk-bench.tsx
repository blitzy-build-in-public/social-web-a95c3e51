/**
 * The device proving benchmark and the native smoke check (`/dev/zk-bench`, AAP 0.5.5, AAP 0.8.2,
 * success criterion 4).
 *
 * One screen serves both jobs, because they are the same run with a different sample count. The
 * **benchmark** (AAP 0.5.5, criterion 4) proves the fixture `.eml` twice for warm-up and then 30
 * times, and reports the p50, p95 and maximum of `ProveTimings.totalMs` — input construction through
 * witness generation and proving — against the p95 ≤ 90 s target on iPhone 13 class and Pixel 7 class
 * devices. The **native smoke check** (AAP 0.2.4, AAP 0.8.2) runs this identical code with `runs=1`
 * through `packages/circuits/scripts/native-smoke.sh`, and the single proof it produces is verified on
 * the host with `snarkjs groth16 verify` against the `verification_key.json` that no client holds.
 *
 * The screen calls no API and needs no session: `tablemate://dev/zk-bench?runs=…&artifactsUrl=…`
 * reaches it on a fresh install of a bench build, reads the committed test registry and test issuer
 * from `config/`, and fetches only the artefact manifest and the proving key from the compose
 * `artifacts` service. The test issuer is the synthetic key the fixture is signed with and never
 * reaches production (AAP 0.5.5).
 *
 * Reachability is the bench flag alone, read on the literal `process.env.EXPO_PUBLIC_ZK_BENCH`
 * reference because that is the form `babel-preset-expo` inlines: `1` in a Release `bench` build,
 * and every other build redirects to `/`. The two output texts are the contract with
 * `apps/mobile/e2e/maestro/zk-bench.yaml` and its `collect-bench.js` — `zk-bench-status` holds exactly
 * `running`, `done` or `error`, and `zk-bench-result` holds one line of JSON with the samples, the
 * percentiles and the last run's proof and public signals.
 *
 * Nothing else about an attempt is rendered or logged: the fixture bytes, the private inputs and every
 * field value stay in local variables for the length of one run, and a failure is reported as one code
 * (AAP 0.5.5, AAP 0.11.1).
 */
import { Asset } from 'expo-asset';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { base64ToBytes } from '@tablemate/circuits';
import {
  ArtifactsManifest,
  FieldElement,
  IssuerConfig,
  RegistryFile,
  colors,
  fontWeights,
  typography,
} from '@tablemate/shared';

import { Banner, Screen } from '../../src/ui';
import { artifactStore } from '../../src/zk/artifacts';
import { artifactsFromManifest, errorCodeOf, prove } from '../../src/zk/prover.ts';
import type { DownloadProgress, ProveConfig, ProveTimings } from '../../src/zk/prover.ts';

import testIssuerJson from '../../../../config/issuers/tablemate-test.json';
import testRegistryJson from '../../../../config/registry/test.json';

/* --- Fixed values ----------------------------------------------------------------------------- */

/** The page heading. The root layout hides the Stack header for this route. */
const SCREEN_TITLE = 'Proving benchmark';

/** What the result reports for a device field this platform does not give. */
const UNKNOWN = 'unknown';

/** Measured runs when the deep link names none, and the one run of the native smoke check. */
const DEFAULT_RUNS = 30;
const MAX_RUNS = 100;

/** Warm-up proofs discarded before the measured runs; a single-run smoke check needs none. */
const WARMUPS = 2;

/** Where the compose `artifacts` service serves the manifest and the proving key. */
const DEFAULT_ARTIFACTS_URL = 'http://localhost:8070';
const MANIFEST_FILE = 'artifacts.manifest.json';

/**
 * The circuit's public `nullifierSalt` when the deep link names none. It is a public input and
 * nothing is submitted, so any field element works and the host's verification holds.
 */
const DEFAULT_SALT = '1';

/** One to three digits: the run counts the deep link may name, rejected before `Number` sees them. */
const RUNS_PARAM = /^\d{1,3}$/;

/**
 * An `http:` or `https:` URL. Matched by pattern rather than by `new URL`, whose support under
 * Hermes is partial, and the base URL is never fetched with anything but the manifest path appended.
 */
const HTTP_URL = /^https?:\/\/\S+$/;

/* The phase line's texts. They are the screen's own prose and hold no contract test identifier. */
const PHASE_STARTING = 'Starting';
const PHASE_FIXTURE = 'Loading fixture';
const PHASE_DOWNLOAD = 'Downloading proving key';

/* The device-conditions note (AAP 0.5.5). It is stated, never enforced. */
const CONDITIONS_TITLE = 'Benchmark conditions (not enforced)';
const CONDITIONS_NOTE =
  'Battery above 50%, with the proving key downloaded and verified before the measured runs. Results are recorded in docs/zk-performance.md.';

/** The status field's three words, which `zk-bench-status` renders verbatim. */
type BenchStatus = 'running' | 'done' | 'error';

/* --- One failure, as one code ------------------------------------------------------------------ */

/**
 * A failure this screen raises. Its `message` is the code itself and its `name` is the shape the
 * proving client already raises, so {@link errorCodeOf} reads it and no path, URL, byte or message
 * can travel out of a run (AAP 0.5.5).
 */
class BenchError extends Error {
  /** What ended the run. */
  readonly code: BenchErrorCode;

  constructor(code: BenchErrorCode) {
    super(code);
    this.name = 'ZkClientError';
    this.code = code;
    // Metro transpiles classes with Babel, which does not preserve the prototype chain of a built-in
    // subclass; restoring it keeps `instanceof BenchError` true in the app.
    Object.setPrototypeOf(this, BenchError.prototype);
  }
}

/** The codes this screen raises itself; anything else comes from {@link errorCodeOf}. */
type BenchErrorCode =
  | 'invalid_params'
  | 'asset_load_failed'
  | 'config_invalid'
  | 'manifest_fetch_failed'
  | 'manifest_invalid'
  | 'aborted';

/** The code of anything a run can throw: this screen's own, or the proving client's. */
function benchCodeOf(error: unknown): string {
  return error instanceof BenchError ? error.code : errorCodeOf(error);
}

/* --- Percentiles ------------------------------------------------------------------------------- */

/**
 * The nearest-rank percentile of a list sorted ascending: `rank = ceil(p / 100 × n)`, and its value.
 *
 * Nearest-rank is used because it always reports a measured span rather than an interpolation between
 * two of them, and because it is the definition `docs/zk-performance.md` records: for the samples 1
 * to 30 the median is the 15th value and p95 the 29th. `p` is clamped to 1…n, so `p = 0` reports the
 * minimum and an out-of-range `p` the maximum.
 *
 * @param sorted - The samples in ascending order, as a copy the caller owns.
 * @param p - The percentile to report, 0 to 100.
 * @returns The sample at that rank, or 0 for an empty list.
 */
export function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;

  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);
  return sorted[rank - 1] ?? 0;
}

/* --- The deep link's parameters (AAP 0.5.5) ----------------------------------------------------- */

/** What one run was asked for, once the deep link's parameters have been parsed and defaulted. */
interface BenchPlan {
  /** Measured runs, the samples the percentiles are computed from. */
  readonly runs: number;

  /** Warm-up proofs, run and discarded before the measured ones. */
  readonly warmups: number;

  /** The origin the artefact manifest and the proving key are fetched from. */
  readonly artifactsUrl: string;

  /** The circuit's public `nullifierSalt`. */
  readonly salt: string;
}

/** The parse of the deep link: a plan, or the `invalid_params` failure the screen renders. */
type PlanResult = { readonly ok: true; readonly plan: BenchPlan } | { readonly ok: false };

/**
 * One parameter as `useLocalSearchParams` can hand it over: Expo Router gives a repeated query
 * parameter a `string[]`, so the first entry is taken, and anything else — absent, not a string,
 * whitespace alone — is the empty string that means "not given".
 */
function firstValue(raw: unknown): string {
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

/** The measured run count, or null when the parameter is present but not an integer from 1 to 100. */
function parseRuns(raw: string): number | null {
  if (raw === '') return DEFAULT_RUNS;
  if (!RUNS_PARAM.test(raw)) return null;

  const runs = Number(raw);
  return runs >= 1 && runs <= MAX_RUNS ? runs : null;
}

/** The artefact origin, with one trailing slash dropped, or null when it is not an http(s) URL. */
function parseArtifactsUrl(raw: string): string | null {
  const value = raw === '' ? DEFAULT_ARTIFACTS_URL : raw.replace(/\/$/, '');
  return HTTP_URL.test(value) ? value : null;
}

/**
 * Reads the deep link into a plan, or reports that a parameter was unusable. `runs=1` is the native
 * smoke check: it takes no warm-up, because one measured proof is the whole of what it establishes.
 */
function planFor(runsParam: string, artifactsUrlParam: string, saltParam: string): PlanResult {
  const runs = parseRuns(runsParam);
  const artifactsUrl = parseArtifactsUrl(artifactsUrlParam);
  if (runs === null || artifactsUrl === null) return { ok: false };

  const salt = saltParam === '' ? DEFAULT_SALT : saltParam;
  if (!FieldElement.safeParse(salt).success) return { ok: false };

  return { ok: true, plan: { runs, warmups: runs === 1 ? 0 : WARMUPS, artifactsUrl, salt } };
}

/* --- The fixture and the manifest -------------------------------------------------------------- */

/**
 * The signed test-issuer fixture, as the module id Metro resolves it to, or null in any build that is
 * not the bench build. The flag is written as the literal reference `babel-preset-expo` inlines, so a
 * production bundle can fold the fixture away; correctness rests on the redirect in
 * {@link ZkBenchRoute}, never on that folding.
 */
function emlFixture(): number | null {
  if (process.env.EXPO_PUBLIC_ZK_BENCH !== '1') return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro asset module (bench fixture)
  return require('../../../../packages/circuits/fixtures/test-issuer/valid.eml') as number;
}

/** This build's fixture module id, resolved once at first load. */
const EML_ASSET = emlFixture();

/**
 * The fixture's bytes, in memory for the length of one run and nowhere else.
 *
 * `expo-file-system` cannot read on the web, so the web path fetches the asset's own URL, while
 * native downloads the asset and reads it as base64 — which is what `base64ToBytes` decodes, because
 * no platform codec is available under Hermes. Every failure is `asset_load_failed`.
 */
async function loadFixtureBytes(): Promise<Uint8Array> {
  const moduleId = EML_ASSET;
  if (moduleId === null) throw new BenchError('asset_load_failed');

  try {
    const asset = Asset.fromModule(moduleId);
    await asset.downloadAsync();

    if (Platform.OS === 'web') {
      const response = await fetch(asset.uri);
      if (!response.ok) throw new BenchError('asset_load_failed');
      return new Uint8Array(await response.arrayBuffer());
    }

    const encoded = await FileSystem.readAsStringAsync(asset.localUri ?? asset.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return base64ToBytes(encoded);
  } catch (error: unknown) {
    throw error instanceof BenchError ? error : new BenchError('asset_load_failed');
  }
}

/**
 * The artefact manifest the service publishes, or the code of the reason it could not be read: a
 * refused or unreachable request is `manifest_fetch_failed` and a body the schema rejects —
 * unparseable JSON included — is `manifest_invalid`.
 */
async function fetchManifest(artifactsUrl: string): Promise<ArtifactsManifest> {
  let response: Response;
  try {
    response = await fetch(`${artifactsUrl}/${MANIFEST_FILE}`);
  } catch {
    throw new BenchError('manifest_fetch_failed');
  }
  if (!response.ok) throw new BenchError('manifest_fetch_failed');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BenchError('manifest_invalid');
  }

  const parsed = ArtifactsManifest.safeParse(body);
  if (!parsed.success) throw new BenchError('manifest_invalid');
  return parsed.data;
}

/** The phase line while the proving key downloads: a percentage once a total is known. */
function downloadPhase(progress: DownloadProgress): string {
  const { receivedBytes, totalBytes } = progress;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return PHASE_DOWNLOAD;

  const percent = Math.min(100, Math.max(0, Math.round((receivedBytes / totalBytes) * 100)));
  return `${PHASE_DOWNLOAD}: ${percent}%`;
}

/* --- What a run reports ------------------------------------------------------------------------ */

/** One measured run, rounded to whole milliseconds, in the order `collect-bench.js` reads it. */
interface BenchSample {
  readonly inputMs: number;
  readonly witnessMs: number;
  readonly proveMs: number;
  readonly totalMs: number;
}

/**
 * The one line of JSON `zk-bench-result` carries, in this key order: where the run happened, what it
 * was asked for, the measured samples, the nearest-rank percentiles of `totalMs`, and the last
 * measured run's proof and public signals — the Groth16 proof and the seven decimal signals the host
 * verifies with `snarkjs groth16 verify`.
 */
interface BenchResult {
  readonly platform: string;
  readonly model: string;
  readonly osVersion: string;
  readonly buildId: string;
  readonly runs: number;
  readonly warmups: number;
  readonly samples: readonly BenchSample[];
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly proof: unknown;
  readonly publicSignals: unknown;
}

/**
 * The app version plus the native build number. A native build version is a property of
 * `expo-application`, which this app does not declare, so the value the Expo config carries is read
 * instead: `ios.buildNumber` on iOS, `android.versionCode` on Android, `unknown` off them.
 */
function deviceBuildId(): string {
  const config = Constants.expoConfig;
  const version = config?.version ?? '0';

  if (Platform.OS === 'ios') return `${version}+${config?.ios?.buildNumber ?? UNKNOWN}`;
  if (Platform.OS === 'android') {
    const versionCode = config?.android?.versionCode;
    return `${version}+${typeof versionCode === 'number' ? String(versionCode) : UNKNOWN}`;
  }
  return `${version}+${UNKNOWN}`;
}

/** One measured run's timings, rounded to whole milliseconds as the result JSON reports them. */
function sampleOf(timings: ProveTimings): BenchSample {
  return {
    inputMs: Math.round(timings.inputMs),
    witnessMs: Math.round(timings.witnessMs),
    proveMs: Math.round(timings.proveMs),
    totalMs: Math.round(timings.totalMs),
  };
}

/** The measured samples, the run count and the last proof, as the result JSON reports them. */
function benchResult(parts: {
  runs: number;
  warmups: number;
  samples: readonly BenchSample[];
  proof: unknown;
  publicSignals: unknown;
}): BenchResult {
  const sorted = parts.samples.map((sample) => sample.totalMs).sort((a, b) => a - b);

  return {
    platform: Platform.OS,
    model: Device.modelName ?? UNKNOWN,
    osVersion: Device.osVersion ?? UNKNOWN,
    buildId: deviceBuildId(),
    runs: parts.runs,
    warmups: parts.warmups,
    samples: parts.samples,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    proof: parts.proof,
    publicSignals: parts.publicSignals,
  };
}

/* --- The screen -------------------------------------------------------------------------------- */

/**
 * The route: the benchmark screen in a bench build, and a redirect to `/` in every other build.
 *
 * The screen measures what this device takes to prove the fixture `.eml` — 2 warm-ups and 30 measured
 * runs for criterion 4, or the single run `runs=1` gives the native smoke check (AAP 0.2.4, AAP 0.5.5)
 * — and reports the run's samples, their p50, p95 and maximum, and the last proof with its public
 * signals. It reaches the API for nothing: the registry, the issuer and the fixture are the committed
 * ones, so the run is the prover, the artefact service and this device alone, which is what lets the
 * smoke check and the device benchmark run without a server. The gate is the bench flag, so a
 * production build redirects instead of proving a fixture.
 *
 * @returns The benchmark screen, or the redirect out of a build that has no benchmark.
 */
export default function ZkBenchRoute(): ReactElement {
  if (process.env.EXPO_PUBLIC_ZK_BENCH !== '1') return <Redirect href="/" />;
  return <ZkBench />;
}

/**
 * The benchmark itself, holding every hook so that {@link ZkBenchRoute} can branch before one runs.
 *
 * One effect owns the run. It loads the fixture, parses the committed registry and issuer, reads the
 * artefact manifest, downloads and verifies the proving key — never as part of a sample — and then
 * proves the same in-memory bytes `warmups + runs` times in sequence, keeping only the last measured
 * proof. Every await takes the effect's abort signal, so a run the screen left stops at the next step
 * and reports nothing.
 *
 * @returns The benchmark screen's element.
 */
function ZkBench(): ReactElement {
  const params = useLocalSearchParams<{
    runs?: string | string[];
    artifactsUrl?: string | string[];
    salt?: string | string[];
  }>();

  const runsParam = firstValue(params.runs);
  const artifactsUrlParam = firstValue(params.artifactsUrl);
  const saltParam = firstValue(params.salt);
  const plan = useMemo(
    () => planFor(runsParam, artifactsUrlParam, saltParam),
    [artifactsUrlParam, runsParam, saltParam],
  );

  const [status, setStatus] = useState<BenchStatus>('running');
  const [result, setResult] = useState('');
  const [phase, setPhase] = useState(PHASE_STARTING);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    void (async (): Promise<void> => {
      try {
        if (!plan.ok) throw new BenchError('invalid_params');
        const { artifactsUrl, runs, salt, warmups } = plan.plan;

        setPhase(PHASE_FIXTURE);
        const emlBytes = await loadFixtureBytes();

        const registry = RegistryFile.safeParse(testRegistryJson);
        const issuer = IssuerConfig.safeParse(testIssuerJson);
        // A template-less issuer is one still awaiting real confirmation emails: it names no registry
        // leaf, so nothing could be extracted from the fixture with it (AAP 0.5.5).
        if (!registry.success || !issuer.success || issuer.data.template === null) {
          throw new BenchError('config_invalid');
        }
        const { displayName, issuerId, keys, template } = issuer.data;

        const manifest = await fetchManifest(artifactsUrl);
        const artifacts = artifactsFromManifest(manifest, artifactsUrl);

        setPhase(PHASE_DOWNLOAD);
        const resolved = await artifactStore.ensureArtifacts(
          artifacts,
          (progress) => {
            setPhase(downloadPhase(progress));
          },
          signal,
        );

        // The shape `GET /v1/zk/config` returns, assembled from the committed files instead: the run
        // needs the test registry, the test issuer and the local artefact links, and no request.
        const config: ProveConfig = {
          issuers: [{ displayName, issuerId, keys, template }],
          registry: registry.data,
          nullifierSalt: salt,
          artifacts,
        };

        const samples: BenchSample[] = [];
        let proof: unknown = null;
        let publicSignals: unknown = null;

        for (let index = 0; index < warmups + runs; index += 1) {
          if (signal.aborted) throw new BenchError('aborted');

          const measured = index - warmups;
          setPhase(
            measured < 0 ? `Warm-up ${index + 1}/${warmups}` : `Run ${measured + 1}/${runs}`,
          );

          const proved = await prove(emlBytes, config, { artifacts: resolved, signal });
          if (measured < 0) continue;

          samples.push(sampleOf(proved.timings));
          // The last measured run alone: 30 proofs held at once would be 30 proofs nobody reads.
          proof = proved.proof;
          publicSignals = proved.publicSignals;
        }

        if (signal.aborted) return;
        setResult(JSON.stringify(benchResult({ runs, warmups, samples, proof, publicSignals })));
        setPhase('');
        setStatus('done');
      } catch (error: unknown) {
        // A run the screen left — the development double-mount, or a route the user left — reports
        // nothing: the component is gone, and its half-finished code would outlive it.
        if (signal.aborted) return;

        const code = benchCodeOf(error);
        // The phase line reports progress, so a finished run clears it: nothing is still loading.
        setPhase('');
        setStatus('error');
        setResult(JSON.stringify({ error: code }));
        console.warn('zk-bench', code);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [plan]);

  return (
    <Screen title={SCREEN_TITLE} testID="zk-bench-screen">
      {/* The contract with `zk-bench.yaml`: one of these three words, nothing else in the text. */}
      <Text testID="zk-bench-status" style={styles.status}>
        {status}
      </Text>
      {/* The contract with `collect-bench.js`: one line of JSON, empty until a run ends, and never
          truncated — the samples with the proof run to several kilobytes. */}
      <Text testID="zk-bench-result" selectable style={styles.result}>
        {result}
      </Text>
      <Text style={styles.phase}>{phase}</Text>
      <Banner tone="info" title={CONDITIONS_TITLE} message={CONDITIONS_NOTE} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  status: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  // The result is a machine-read line of JSON: a small token type, muted, and no line clamp.
  result: {
    ...typography.caption,
    color: colors.textMuted,
  },
  phase: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
