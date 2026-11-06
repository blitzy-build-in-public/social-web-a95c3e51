/**
 * Proof generation — the second half of the proof-import flow (`/proof/generate`, AAP 0.5.5, AAP
 * 0.5.8, criterion 3): the staged booking confirmation read on this device, the proving data it needs,
 * the proof with its progress and its Cancel, and the one state each outcome leaves the traveller in.
 *
 * The email never reaches a render: the file is taken once from the import screen into a ref,
 * `importAndProve` releases it on every path once it owns it, this screen releases it when the attempt
 * never starts, and only an error code, the proof's public stay outputs, a download fraction and the
 * artefact plan's own three fields enter state (AAP 0.5.5, AAP 0.12.2). Proving never moves to the
 * server either: this screen holds no proving call, and an engine the build lacks is stated as its own
 * state before any file is read (AAP 0.2.4, AAP 0.12.2).
 */
import { useQuery } from '@tanstack/react-query';
import { Redirect, Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { colors, fontWeights, typography } from '@tablemate/shared';
import type { CityDto, ProofAccepted, ZkConfig } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import {
  EMAIL_STAYS_ON_DEVICE,
  UNSUPPORTED_ISSUER,
  formatCalendarDate,
  supportedIssuersText,
} from '../../src/copy/strings';
import { queryClient, queryKeys } from '../../src/state/meetup-store';
import { resetProof, useProofState } from '../../src/state/proof-store';
import type { ProofFlowStatus } from '../../src/state/proof-store';
import { Banner, Button, Card, Screen, announce } from '../../src/ui';
import {
  errorCodeOf,
  importAndProve,
  issuerSupport,
  platformArtifactStore,
  platformEngine,
  takePendingEml,
} from '../../src/zk/prover.ts';
import type {
  ArtifactPlan,
  ArtifactStore,
  EmlHandle,
  ProofErrorCode,
} from '../../src/zk/prover.ts';

/** The header before and after an attempt; the running one turns the back gesture off. */
const FLOW_TITLE = 'Verify my stay';
const RUNNING_TITLE = 'Verifying your stay';

/** The three safe-area edges claimed below the navigator header. */
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

const PREPARING = 'Preparing verification…';
const UNVERIFIABLE = "On-device verification isn't available in this build.";
const NOT_SUPPORTED_PREFIX = 'Not yet supported: ';

/** Every control's visible label, which is also its accessible name (AAP 0.5.8). */
const START_LABEL = 'Download and verify';
const START_CACHED_LABEL = 'Start verification';
const CANCEL_LABEL = 'Cancel';
const RETRY_LABEL = 'Try again';
const BACK_LABEL = 'Back';
const CHOOSE_LABEL = 'Choose another file';
const DISCOVER_LABEL = 'Find travelers';
const CHOOSE_HINT = 'Opens the file picker to choose the booking confirmation again.';

/** What the artefact plan means before anything is downloaded (AAP 0.5.5). */
const PLAN_SIZE_PREFIX = 'Verification files to download: ';
const PLAN_SIZE_SUFFIX = ' MB';
const PLAN_WIFI = 'We recommend Wi-Fi.';
const PLAN_KEEP_OPEN_NATIVE = 'Keep the app open until verification finishes.';
const PLAN_KEEP_OPEN_WEB = 'Keep this tab open until verification finishes.';
const PLAN_CELLULAR = "You're on mobile data. This download is large.";
const PLAN_CACHED = 'Verification files are ready on this device.';

/** 1 MB as AAP 0.5.5 counts it, so the size a traveller reads matches the download it describes. */
const BYTES_PER_MEGABYTE = 1_000_000;

/** The steps in which an attempt is running (AAP 0.5.5). */
const RUNNING_STATUSES: readonly ProofFlowStatus[] = [
  'reading',
  'downloading',
  'proving',
  'submitting',
];

/**
 * Every code this client raises for an attempt the API did not answer — the input generator's, the
 * proving flow's and the native module's — derived from `ProofErrorCode` rather than listed again, so
 * a code added there fails the exhaustiveness of {@link FLOW_MESSAGES} instead of reaching a
 * traveller as no sentence at all (AAP 0.5.8). The API's codes keep `userMessageFor` as their source.
 */
type FlowErrorCode = Exclude<ProofErrorCode, ClientErrorCode> | 'unknown_error';

/** The app's own sentence for a failure code, never the server's text (AAP 0.11.1). */
const FLOW_MESSAGES = {
  eml_malformed: 'That file is not a booking confirmation we can read. Export it again as .eml.',
  dkim_missing: "This email isn't digitally signed, so the stay in it cannot be verified.",
  dkim_unsupported: "This confirmation is signed in a way Tablemate can't check yet.",
  unsupported_issuer: "Tablemate can't verify bookings from this site yet.",
  header_too_long: "This confirmation's signed header is longer than Tablemate can verify.",
  body_hash_mismatch: "This confirmation's body doesn't match its signature.",
  field_not_found: "We couldn't find your stay dates and city in this confirmation.",
  field_ambiguous: 'Your stay details appear more than once in this confirmation.',
  field_invalid: "Your stay dates or city aren't written in a way Tablemate can read.",
  city_not_supported: "Tablemate doesn't cover the city in this confirmation yet.",
  registry_mismatch: "Tablemate's verification data is out of date. Update the app and try again.",
  eml_read_failed: "We couldn't read that file. Choose the booking confirmation saved as .eml.",
  share_intake_unsupported: 'This device cannot hand a file to Tablemate. Choose the file instead.',
  artifact_download_failed: "We couldn't download the proving data. Check your connection.",
  artifact_hash_mismatch: "The proving data didn't match its published checksum. Try again.",
  artifact_insufficient_storage: 'There is not enough free space for the proving data.',
  artifact_storage_unavailable: "This device can't store the proving data. Restart the app.",
  prover_unavailable: "This build can't generate proofs. Update the app and try again.",
  worker_unavailable: 'This browser cannot generate the proof. Try an up-to-date browser.',
  worker_failed: 'Generating the proof stopped unexpectedly. Try again.',
  out_of_memory: 'This device ran out of memory while proving. Close other apps and try again.',
  proof_output_invalid: "The proof couldn't be put together correctly. Import your booking again.",
  proof_in_progress: 'A proof is already being generated. Wait for it to finish.',
  cancelled: 'The proof was stopped before it finished.',
  zkey_missing: 'The proving key is missing on this device. Try the download again.',
  inputs_invalid: "The details in this confirmation couldn't be turned into a proof.",
  prover_failed: 'Generating the proof failed on this device. Try again.',
  file_missing: 'The booking file is no longer available. Choose it again.',
  hash_failed: 'The proving data failed its integrity check. Try the download again.',
  unknown_error: 'Something went wrong while generating the proof. Try again.',
} as const satisfies Record<FlowErrorCode, string>;

/** The record above indexed by code; a code absent from it is an API code `userMessageFor` owns. */
const FLOW_MESSAGES_BY_CODE: Partial<Record<string, string>> = FLOW_MESSAGES;

/** The sentence to show for a failure code from either source (AAP 0.5.4, AAP 0.5.8). */
function failureMessage(code: ProofErrorCode | 'unknown_error'): string {
  return FLOW_MESSAGES_BY_CODE[code] ?? userMessageFor(code);
}

/**
 * The sentence the status line shows for one step of an attempt. Every status has one, so the line is
 * never empty and a test can wait on it in any state; the percentage is printed as text rather than
 * left to a bar or a colour (WCAG 1.4.1).
 */
function statusText(status: ProofFlowStatus, progress: number | undefined): string {
  switch (status) {
    case 'idle':
      return 'Ready to verify your stay.';
    case 'reading':
      return 'Reading your booking email on this device…';
    case 'downloading':
      return `Downloading verification files… ${percentText(progress)}%`;
    case 'proving':
      return 'Creating your proof on this device. This can take a minute or two…';
    case 'submitting':
      return 'Sending the proof — not your email — to Tablemate…';
    case 'accepted':
      return 'Your stay is verified.';
    case 'error':
      return "Verification didn't finish.";
    case 'cancelled':
      return 'Verification cancelled.';
  }
}

/** A reported 0-1 download fraction as the whole percentage the status line prints. */
function percentText(progress: number | undefined): number {
  return Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100);
}

/** The download size in megabytes with one decimal, as AAP 0.5.5 asks the screen to show it. */
function megabytes(bytes: number): string {
  return (bytes / BYTES_PER_MEGABYTE).toFixed(1);
}

/** What the artefact plan means for the traveller, before anything is downloaded (AAP 0.5.5). */
function planText(plan: ArtifactPlan): string {
  if (plan.cached) return PLAN_CACHED;
  const keepOpen = Platform.OS === 'web' ? PLAN_KEEP_OPEN_WEB : PLAN_KEEP_OPEN_NATIVE;
  const size = `${PLAN_SIZE_PREFIX}${megabytes(plan.downloadBytes)}${PLAN_SIZE_SUFFIX}`;
  return `${size} ${PLAN_WIFI} ${keepOpen}`;
}

/** The city's own name from `GET /cities`, or its slug before that read has settled. */
function cityNameOf(cities: readonly CityDto[] | undefined, cityId: string): string {
  return cities?.find((city) => city.id === cityId)?.name ?? cityId;
}

/** The stay the server confirmed, narrowed to the three public outputs a screen may hold. */
type VerifiedStay = Pick<ProofAccepted, 'cityId' | 'arrivalDate' | 'departureDate'>;

/** Whether an attempt is running, which is when it can be stopped and the back gesture is off. */
function isRunning(status: ProofFlowStatus): boolean {
  return RUNNING_STATUSES.includes(status);
}

/**
 * Whether an attempt can still be stopped. `submitting` is not stoppable: the proof has left the
 * device and the API may already have spent its nullifier, so no control is offered that could not
 * change the outcome.
 */
function isCancellable(status: ProofFlowStatus): boolean {
  return isRunning(status) && status !== 'submitting';
}

/**
 * The generate screen: `/proof/generate`.
 *
 * The staged file decides whether the screen stays at all — with none it redirects to
 * `/proof/import` — and the engine decides whether it can offer anything: a build without a prover
 * releases the file at once and says so, instead of failing after the email has been read.
 */
export default function ProofGenerateScreen(): ReactElement {
  const proof = useProofState();
  const handleRef = useRef<EmlHandle | null>(null);
  const storeRef = useRef<ArtifactStore | null>(null);
  const configRef = useRef<ZkConfig | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const tookRef = useRef(false);
  const [entry, setEntry] = useState<'pending' | 'absent' | 'present'>('pending');
  const [provable, setProvable] = useState(false);
  const [plan, setPlan] = useState<ArtifactPlan | null>(null);
  const [planFailed, setPlanFailed] = useState(false);
  const [started, setStarted] = useState(false);
  const [failure, setFailure] = useState<ProofErrorCode | 'unknown_error' | null>(null);
  const [verified, setVerified] = useState<VerifiedStay | null>(null);

  const zkConfig = useQuery({
    queryKey: queryKeys.zkConfig,
    queryFn: () => apiClient.getZkConfig(),
    enabled: entry === 'present',
  });

  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    enabled: verified !== null,
  });

  /*
   * Taking the staged file, once. The app root mounts no React StrictMode (`app/_layout.tsx`), so this
   * effect runs a single time; if that ever changes the release below has to move to a microtask a
   * remount cancels, or the development double-mount would drop the file the import screen staged. A
   * build that cannot prove releases it here and now, holding nothing for an attempt that cannot run.
   *
   * Nothing below navigates: a cold load of this route reaches the picker through the `<Redirect>`
   * the render draws instead, because expo-router refuses a navigation issued from a child screen's
   * first effect, before its root layout has mounted (`assertIsReady`).
   */
  useEffect(() => {
    if (tookRef.current) return;
    tookRef.current = true;
    resetProof();
    const handle = takePendingEml();
    if (handle === null) {
      // Published from a microtask rather than the effect body, which React reserves for
      // synchronising external systems: a synchronous setState would cascade a render before the
      // first paint, and the staged file is the only external thing this effect reads.
      void Promise.resolve().then(() => setEntry('absent'));
      return;
    }
    const engine = platformEngine() ?? null;
    const store = platformArtifactStore() ?? null;
    storeRef.current = store;
    const able = engine?.available() === true && store !== null;
    if (able) handleRef.current = handle;
    else void handle.release().catch(() => {});
    void Promise.resolve().then(() => {
      setProvable(able);
      setEntry('present');
    });
  }, []);

  /*
   * Leaving stops the attempt and releases a file no attempt ever took. Once `importAndProve` owns the
   * handle it releases it on every path — success, failure and cancellation alike — so the ref is
   * already empty by then (AAP 0.5.5).
   */
  useEffect(
    () => () => {
      controllerRef.current?.abort();
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle !== null) void handle.release().catch(() => {});
    },
    [],
  );

  /* Latched: a refetch must not move the registry root, the salt or the artefacts mid-attempt. */
  useEffect(() => {
    if (zkConfig.data !== undefined) configRef.current ??= zkConfig.data;
  }, [zkConfig.data]);

  const configKnown = zkConfig.data !== undefined;

  /* What a download would cost, asked once the configuration and the engine are both known. */
  useEffect(() => {
    const store = storeRef.current;
    const artifacts = configRef.current?.artifacts;
    if (!provable || store === null || artifacts === undefined || plan !== null || planFailed)
      return;
    let active = true;
    void store.plan(artifacts).then(
      (next) => {
        if (active) setPlan(next);
      },
      () => {
        // A store that cannot answer must not withhold the start: the attempt downloads for real and
        // reports its own failure if that is what happens.
        if (active) setPlanFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [configKnown, plan, planFailed, provable]);

  const start = useCallback((): void => {
    const handle = handleRef.current;
    const config = configRef.current;
    if (handle === null || config === null) return;
    // Emptied first: from here `importAndProve` releases this handle on every path, and the unmount
    // cleanup above must never release it a second time.
    handleRef.current = null;
    const controller = new AbortController();
    controllerRef.current = controller;
    setStarted(true);
    void (async (): Promise<void> => {
      try {
        const result = await importAndProve(handle, config, { signal: controller.signal });
        // Only the proof's public outputs are kept: not the proof id, the proof or the public signals.
        const { cityId, arrivalDate, departureDate } = result.accepted;
        setVerified({ cityId, arrivalDate, departureDate });
        // Discover, Lodgings and Propose read the proof state from `GET /me` (AAP 0.5.8).
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      } catch (error: unknown) {
        const code = errorCodeOf(error);
        // An attempt the traveller stopped is `cancelled`, which the store already holds.
        if (code !== 'cancelled') setFailure(code);
      }
    })();
  }, []);

  const cancel = useCallback((): void => controllerRef.current?.abort(), []);

  /* Re-reads `GET /zk/config` after a failed read; the staged file is still held for it. */
  const retryConfig = (): void => void zkConfig.refetch();

  /* `router.back()` where a screen is behind; the profile is the fallback for a cold start. */
  const goBack = useCallback((): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/profile');
  }, []);

  const running = isRunning(proof.status);
  const cancelled = proof.status === 'cancelled';
  const unsupported = failure === 'unsupported_issuer';
  const configError = zkConfig.error === null ? null : userMessageFor(errorCodeOf(zkConfig.error));
  const support = zkConfig.data === undefined ? null : issuerSupport(zkConfig.data);
  const notSupported =
    support === null || support.unsupported.length === 0
      ? null
      : `${NOT_SUPPORTED_PREFIX}${support.unsupported.join(', ')}.`;
  const unsupportedText =
    support === null
      ? failureMessage('unsupported_issuer')
      : notSupported === null
        ? supportedIssuersText(support.supported)
        : `${supportedIssuersText(support.supported)} ${notSupported}`;
  const statusSentence = statusText(proof.status, proof.downloadProgress);
  const planLine = plan === null ? null : planText(plan);
  const planReady = plan !== null || planFailed;
  const canStart = provable && configKnown && planReady;
  const acceptedSentence =
    verified === null
      ? null
      : `Your stay in ${cityNameOf(cities.data?.items, verified.cityId)} from ${formatCalendarDate(
          verified.arrivalDate,
        )} to ${formatCalendarDate(verified.departureDate)} is verified.`;

  /*
   * Each distinct sentence is spoken once, and only the states that ask for attention: every error,
   * the unsupported booking site included, plus the verified and stopped outcomes (AAP 0.5.8).
   */
  const spoken =
    verified !== null
      ? 'Your stay is verified.'
      : unsupported
        ? unsupportedText
        : failure !== null
          ? failureMessage(failure)
          : cancelled
            ? 'Verification cancelled.'
            : configError;
  useEffect(() => {
    if (spoken !== null) announce(spoken);
  }, [spoken]);

  /** Back to the picker: the file an attempt used has been released, so a retry starts from a choice. */
  const chooseAgain = (testID: string): ReactElement => (
    <Button label={CHOOSE_LABEL} hint={CHOOSE_HINT} onPress={goToImport} testID={testID} />
  );

  const unverifiable = !provable ? (
    <>
      <Banner tone="warning" message={UNVERIFIABLE} testID="proof-generate-error" />
      <Button label={BACK_LABEL} onPress={goBack} testID="proof-generate-back" />
    </>
  ) : null;

  const unreadable =
    provable && configError !== null ? (
      <Banner
        tone="error"
        message={configError}
        action={{ label: RETRY_LABEL, onPress: retryConfig, testID: 'proof-generate-retry' }}
        testID="proof-generate-error"
      />
    ) : null;

  const preparing = !configKnown && configError === null;

  const attempt =
    provable && verified === null && failure === null && !cancelled ? (
      <>
        {preparing ? (
          <Text testID="proof-generate-preparing" style={styles.muted}>
            {PREPARING}
          </Text>
        ) : null}
        {planLine === null ? null : (
          <Text testID="proof-generate-plan" style={styles.body}>
            {planLine}
          </Text>
        )}
        {plan?.connection === 'cellular' ? (
          <Banner tone="warning" message={PLAN_CELLULAR} testID="proof-generate-cellular" />
        ) : null}
        {started ? null : (
          <Button
            label={plan?.cached === true ? START_CACHED_LABEL : START_LABEL}
            disabled={!canStart}
            onPress={start}
            testID="proof-generate-start"
          />
        )}
        {isCancellable(proof.status) ? (
          <Button
            variant="secondary"
            label={CANCEL_LABEL}
            onPress={cancel}
            testID="proof-generate-cancel"
          />
        ) : null}
      </>
    ) : null;

  const accepted =
    verified !== null ? (
      <>
        <Card testID="proof-accepted">
          {acceptedSentence === null ? null : <Text style={styles.body}>{acceptedSentence}</Text>}
        </Card>
        <Button label={DISCOVER_LABEL} onPress={goToDiscover} testID="proof-generate-discover" />
      </>
    ) : null;

  const unsupportedIssuer = unsupported ? (
    <>
      <Banner
        tone="warning"
        title={UNSUPPORTED_ISSUER}
        message={unsupportedText}
        testID="proof-unsupported"
      />
      {chooseAgain('proof-generate-choose-unsupported')}
    </>
  ) : null;

  const failed =
    failure !== null && !unsupported ? (
      <>
        <Banner tone="error" message={failureMessage(failure)} testID="proof-generate-error" />
        {chooseAgain('proof-generate-choose')}
      </>
    ) : null;

  const stopped =
    cancelled && failure === null ? chooseAgain('proof-generate-choose-stopped') : null;

  // One outcome at a time, in the order the flow reaches them, the attempt itself last: the status
  // line above carries the step either way. Nothing shows before the hand-off has been read.
  const states = [unverifiable, unreadable, accepted, unsupportedIssuer, failed, stopped, attempt];
  const state = entry === 'present' ? (states.find((block) => block !== null) ?? null) : null;
  // One stable object: a fresh options literal on every render would re-issue `setOptions` each time.
  const screenOptions = useMemo(
    () => ({ title: running ? RUNNING_TITLE : FLOW_TITLE, gestureEnabled: !running }),
    [running],
  );

  return (
    <>
      {entry === 'absent' ? <Redirect href="/proof/import" /> : null}
      <Stack.Screen options={screenOptions} />
      <Screen edges={SCREEN_EDGES} testID="proof-generate">
        <Card testID="proof-generate-privacy">
          <Text style={styles.statement}>{EMAIL_STAYS_ON_DEVICE}</Text>
        </Card>
        <Text
          testID="proof-generate-status"
          accessibilityLiveRegion="polite"
          aria-live="polite"
          style={styles.status}
        >
          {statusSentence}
        </Text>
        {state}
      </Screen>
    </>
  );
}

/** Back to the picker, where another booking confirmation can be chosen. */
function goToImport(): void {
  router.replace('/proof/import');
}

/** On to the city list a verified stay unlocks (AAP 0.5.8). */
function goToDiscover(): void {
  router.replace('/discover');
}

const styles = StyleSheet.create({
  statement: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  status: { ...typography.body, color: colors.text },
  body: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted },
});
