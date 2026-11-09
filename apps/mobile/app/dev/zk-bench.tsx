/**
 * The device proving benchmark and the native smoke check (`/dev/zk-bench`, AAP 0.5.5, AAP 0.8.2,
 * success criterion 4).
 */
import { Asset } from 'expo-asset';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import {
  ARTIFACTS_MANIFEST_FILE,
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
import { loadCircuitApi } from '../../src/zk/circuits';
import { artifactsFromManifest, errorCodeOf, prove } from '../../src/zk/prover.ts';
import type { DownloadProgress, ProveConfig, ProveTimings } from '../../src/zk/prover.ts';
import testIssuerJson from '../../../../config/issuers/tablemate-test.json';
import testRegistryJson from '../../../../config/registry/test.json';

const UNKNOWN = 'unknown';
const RUNS_PARAM = /^\d{1,3}$/;
const HTTP_URL = /^https?:\/\/\S+$/;
const PHASE_DOWNLOAD = 'Downloading proving key';
/* The device-conditions note (AAP 0.5.5); it is stated, never enforced. */
const CONDITIONS_TITLE = 'Benchmark conditions (not enforced)';
const CONDITIONS_NOTE =
  'Battery above 50%, with the proving key downloaded and verified before the measured runs. Results are recorded in docs/zk-performance.md.';
type BenchStatus = 'running' | 'done' | 'error';
class BenchError extends Error {
  constructor(readonly code: BenchErrorCode) {
    super(code);
    this.name = 'ZkClientError';
    Object.setPrototypeOf(this, BenchError.prototype);
  }
}
type BenchErrorCode =
  | 'invalid_params'
  | 'asset_load_failed'
  | 'config_invalid'
  | 'manifest_fetch_failed'
  | 'manifest_invalid'
  | 'aborted';
function benchCodeOf(error: unknown): string {
  return error instanceof BenchError ? error.code : errorCodeOf(error);
}
export function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);
  return sorted[rank - 1] ?? 0;
}
type BenchPlan = Readonly<{ runs: number; warmups: number; artifactsUrl: string; salt: string }>;
type PlanResult = { readonly ok: true; readonly plan: BenchPlan } | { readonly ok: false };
function firstValue(raw: unknown): string {
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}
function parseRuns(raw: string): number | null {
  if (raw === '') return 30;
  const runs = Number(raw);
  return RUNS_PARAM.test(raw) && runs >= 1 && runs <= 100 ? runs : null;
}
function parseArtifactsUrl(raw: string): string | null {
  const value = raw === '' ? 'http://localhost:8070' : raw.replace(/\/$/, '');
  return HTTP_URL.test(value) ? value : null;
}
function planFor(runsParam: string, artifactsUrlParam: string, saltParam: string): PlanResult {
  const runs = parseRuns(runsParam);
  const artifactsUrl = parseArtifactsUrl(artifactsUrlParam);
  if (runs === null || artifactsUrl === null) return { ok: false };
  const salt = saltParam === '' ? '1' : saltParam;
  if (!FieldElement.safeParse(salt).success) return { ok: false };
  return { ok: true, plan: { runs, warmups: runs === 1 ? 0 : 2, artifactsUrl, salt } };
}
function emlFixture(): number | null {
  if (process.env.EXPO_PUBLIC_ZK_BENCH !== '1') return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro asset module (bench fixture)
  return require('../../../../packages/circuits/fixtures/test-issuer/valid.eml') as number;
}
const EML_ASSET = emlFixture();
async function loadFixtureBytes(): Promise<Uint8Array> {
  if (EML_ASSET === null) throw new BenchError('asset_load_failed');
  try {
    const asset = Asset.fromModule(EML_ASSET);
    await asset.downloadAsync();
    if (Platform.OS === 'web') {
      const response = await fetch(asset.uri);
      if (!response.ok) throw new BenchError('asset_load_failed');
      return new Uint8Array(await response.arrayBuffer());
    }
    const encoded = await FileSystem.readAsStringAsync(asset.localUri ?? asset.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    // The decoder comes from the circuit API, never from a static import of the package: the bench
    // route and the proving flow are two chunks, and a package both of them import is hoisted into the
    // entry chunk they are both meant to stay out of.
    const { base64ToBytes } = await loadCircuitApi();
    return base64ToBytes(encoded);
  } catch (error: unknown) {
    throw error instanceof BenchError ? error : new BenchError('asset_load_failed');
  }
}
async function fetchManifest(artifactsUrl: string): Promise<ArtifactsManifest> {
  const response = await fetch(`${artifactsUrl}/${ARTIFACTS_MANIFEST_FILE}`).catch(() => {
    throw new BenchError('manifest_fetch_failed');
  });
  if (!response.ok) throw new BenchError('manifest_fetch_failed');
  const body: unknown = await response.json().catch(() => {
    throw new BenchError('manifest_invalid');
  });
  const parsed = ArtifactsManifest.safeParse(body);
  if (!parsed.success) throw new BenchError('manifest_invalid');
  return parsed.data;
}
function downloadPhase(progress: DownloadProgress): string {
  const { receivedBytes, totalBytes } = progress;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return PHASE_DOWNLOAD;
  const percent = Math.min(100, Math.max(0, Math.round((receivedBytes / totalBytes) * 100)));
  return `${PHASE_DOWNLOAD}: ${percent}%`;
}
type BenchSample = Readonly<{
  inputMs: number;
  witnessMs: number;
  proveMs: number;
  totalMs: number;
}>;
type BenchResult = Readonly<{
  platform: string;
  model: string;
  osVersion: string;
  buildId: string;
  runs: number;
  warmups: number;
  samples: readonly BenchSample[];
  p50: number;
  p95: number;
  max: number;
  proof: unknown;
  publicSignals: unknown;
}>;
function deviceBuildId(): string {
  const config = Constants.expoConfig;
  const version = config?.version ?? '0';
  if (Platform.OS === 'ios') return `${version}+${config?.ios?.buildNumber ?? UNKNOWN}`;
  const code = config?.android?.versionCode;
  if (Platform.OS !== 'android') return `${version}+${UNKNOWN}`;
  return `${version}+${typeof code === 'number' ? String(code) : UNKNOWN}`;
}
const sampleOf = (timings: ProveTimings): BenchSample => ({
  inputMs: Math.round(timings.inputMs),
  witnessMs: Math.round(timings.witnessMs),
  proveMs: Math.round(timings.proveMs),
  totalMs: Math.round(timings.totalMs),
});
type Proved = Readonly<{ proof: unknown; publicSignals: unknown }>;
function benchResult(
  plan: BenchPlan,
  samples: readonly BenchSample[],
  proved: Proved,
): BenchResult {
  const sorted = samples.map((sample) => sample.totalMs).sort((a, b) => a - b);
  return {
    platform: Platform.OS,
    model: Device.modelName ?? UNKNOWN,
    osVersion: Device.osVersion ?? UNKNOWN,
    buildId: deviceBuildId(),
    runs: plan.runs,
    warmups: plan.warmups,
    samples,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    proof: proved.proof,
    publicSignals: proved.publicSignals,
  };
}
export default function ZkBenchRoute(): ReactElement {
  if (process.env.EXPO_PUBLIC_ZK_BENCH !== '1') return <Redirect href="/" />;
  return <ZkBench />;
}
function ZkBench(): ReactElement {
  const params = useLocalSearchParams();
  const runsParam = firstValue(params.runs);
  const artifactsUrlParam = firstValue(params.artifactsUrl);
  const saltParam = firstValue(params.salt);
  const plan = useMemo(
    () => planFor(runsParam, artifactsUrlParam, saltParam),
    [artifactsUrlParam, runsParam, saltParam],
  );
  const [status, setStatus] = useState<BenchStatus>('running');
  const [result, setResult] = useState('');
  const [phase, setPhase] = useState('Starting');
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async (): Promise<void> => {
      try {
        if (!plan.ok) throw new BenchError('invalid_params');
        const { artifactsUrl, runs, salt, warmups } = plan.plan;
        setPhase('Loading fixture');
        const emlBytes = await loadFixtureBytes();
        const registry = RegistryFile.safeParse(testRegistryJson);
        const issuer = IssuerConfig.safeParse(testIssuerJson);
        if (!registry.success || !issuer.success || issuer.data.template === null) {
          throw new BenchError('config_invalid');
        }
        const { displayName, issuerId, keys, template } = issuer.data;
        const artifacts = artifactsFromManifest(await fetchManifest(artifactsUrl), artifactsUrl);
        setPhase(PHASE_DOWNLOAD);
        const onProgress = (progress: DownloadProgress): void => setPhase(downloadPhase(progress));
        const resolved = await artifactStore.ensureArtifacts(artifacts, onProgress, signal);
        const config: ProveConfig = {
          issuers: [{ displayName, issuerId, keys, template }],
          registry: registry.data,
          nullifierSalt: salt,
          artifacts,
        };
        const samples: BenchSample[] = [];
        let latest: Proved = { proof: null, publicSignals: null };
        for (let index = 0; index < warmups + runs; index += 1) {
          if (signal.aborted) throw new BenchError('aborted');
          const measured = index - warmups;
          setPhase(
            measured < 0 ? `Warm-up ${index + 1}/${warmups}` : `Run ${measured + 1}/${runs}`,
          );
          const proved = await prove(emlBytes, config, { artifacts: resolved, signal });
          if (measured < 0) continue;
          samples.push(sampleOf(proved.timings));
          latest = proved;
        }
        if (signal.aborted) return;
        setResult(JSON.stringify(benchResult(plan.plan, samples, latest)));
        setPhase('');
        setStatus('done');
      } catch (error: unknown) {
        if (signal.aborted) return;
        setPhase('');
        setStatus('error');
        setResult(JSON.stringify({ error: benchCodeOf(error) }));
        console.warn('zk-bench', benchCodeOf(error));
      }
    })();
    return () => controller.abort();
  }, [plan]);
  return (
    <Screen title="Proving benchmark" testID="zk-bench-screen">
      {/* The three lines below change while the screen is open, so each one is a polite live region
          (WCAG 4.1.3): react-native-web renders the prop as `aria-live="polite"` on web, Android
          reads it as its live region, and iOS has no equivalent in React Native, which is why
          `polite` is the right setting. */}
      <Text
        testID="zk-bench-status"
        accessibilityLiveRegion="polite"
        style={styles.status}
        children={status}
      />
      <Text
        testID="zk-bench-result"
        accessibilityLiveRegion="polite"
        selectable
        style={styles.result}
        children={result}
      />
      <Text accessibilityLiveRegion="polite" style={styles.phase} children={phase} />
      <Banner tone="info" title={CONDITIONS_TITLE} message={CONDITIONS_NOTE} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  status: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  result: { ...typography.caption, color: colors.textMuted },
  phase: { ...typography.caption, color: colors.textMuted },
});
