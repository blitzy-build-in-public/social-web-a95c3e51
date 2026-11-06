/**
 * Proof generation — the second half of the proof-import flow (`/proof/generate`, AAP 0.5.5,
 * AAP 0.5.8, success criterion 3): the staged booking confirmation read once, the download it needs,
 * the proof itself with its progress and its Cancel, and the state each outcome leaves the traveller
 * in. Exactly one outcome shows, in the order the flow reaches it, and each is this app's own
 * sentence for a code rather than the server's text (AAP 0.11.1).
 *
 * The booking file never reaches a render: it is taken once into a ref, released by `importAndProve`
 * once that call owns it and by this screen's unmount while the attempt never started, and the
 * configuration the attempt runs against is latched in a ref, so a refetch cannot move it.
 * `submitting` is not cancellable: the proof has left the device, the API may already have spent its
 * nullifier, and its answer is the only way to learn whether it did (AAP 0.5.5).
 *
 * Reads, in order: the published configuration over the cached `queryKeys.zkConfig`, so the import
 * screen's answer is reused rather than asked for twice (AAP 0.5.4), and the configured cities once
 * a proof is accepted — which is why the accepted sentence is announced only once that read has
 * settled, with the city's name rather than its slug.
 */
import { useQuery } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { CircuitInputErrorCode } from '@tablemate/circuits';
import { colors, fontWeights, typography } from '@tablemate/shared';
import type { CityDto, ProofAccepted, ZkConfig } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { userMessageFor } from '../../src/api/errors';
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
import { artifactStore } from '../../src/zk/artifacts';
import { errorCodeOf, importAndProve, issuerSupport, takePendingEml } from '../../src/zk/prover.ts';
import type {
  ArtifactPlan,
  EmlHandle,
  ProofErrorCode,
  ZkClientErrorCode,
} from '../../src/zk/prover.ts';

const FLOW_TITLE = 'Verify my stay';
const RUNNING_TITLE = 'Generating your proof';
const ACCEPTED_TITLE = 'Stay verified';
const CANCELLED_TITLE = 'Proving stopped';
const PREPARING = 'Preparing…';

const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

const EMPTY_TITLE = 'No booking email chosen';
const EMPTY_TEXT =
  'Choose an exported booking confirmation to prove where and when you are staying.';
const CANCELLED_TEXT = 'The proof was stopped before it finished, so no stay was verified.';

/** Every control's visible label, which is also its accessible name (AAP 0.5.8). */
const CHOOSE_LABEL = 'Choose a booking email';
const CANCEL_LABEL = 'Cancel';
const RETRY_LABEL = 'Try again';
const DISCOVER_LABEL = 'Go to Discover';

const CHOOSE_AGAIN = { label: CHOOSE_LABEL, onPress: (): void => router.replace('/proof/import') };
const GO_TO_DISCOVER = { label: DISCOVER_LABEL, onPress: (): void => router.replace('/discover') };

const PLAN_CACHED = 'The proving data is already on this device, so nothing needs downloading.';
const PLAN_RECHECK = 'The proving data on this device is checked again before it is used.';
const PLAN_WIFI = 'Use Wi-Fi if you can.';
const PLAN_CELLULAR = "You're on cellular data, so this download counts against your plan.";

const BYTES_PER_KILOBYTE = 1000;
const BYTES_PER_MEGABYTE = 1000 * BYTES_PER_KILOBYTE;
const BYTES_PER_GIGABYTE = 1000 * BYTES_PER_MEGABYTE;

type RunningStatus = Exclude<ProofFlowStatus, 'idle' | 'accepted' | 'error' | 'cancelled'>;

/** The steps in which an attempt is running, in the store's own order (AAP 0.5.5). */
const RUNNING: readonly RunningStatus[] = ['reading', 'downloading', 'proving', 'submitting'];

const STATUS_TEXT: Partial<Record<ProofFlowStatus, string>> = {
  reading: 'Reading your booking confirmation…',
  downloading: 'Downloading the proving data…',
  proving: 'Generating the proof on this device. This is the slow step, and it can take a minute.',
  submitting: 'Sending your proof…',
} as const satisfies Record<RunningStatus, string>;

type FlowErrorCode =
  | CircuitInputErrorCode
  | ZkClientErrorCode
  | 'zkey_missing'
  | 'inputs_invalid'
  | 'prover_failed'
  | 'file_missing'
  | 'hash_failed'
  | 'unknown_error';

/** The app's own sentence for a failure code, never the server's text (AAP 0.11.1). */
const FLOW_MESSAGES = {
  eml_malformed:
    'That file is not a booking confirmation we can read. Export it again as an .eml file.',
  dkim_missing: "This email isn't digitally signed, so the stay in it cannot be verified.",
  dkim_unsupported: "This confirmation is signed in a way Tablemate can't check yet.",
  unsupported_issuer: "Tablemate can't verify bookings from this site yet.",
  header_too_long: "This confirmation's signed header is longer than Tablemate can verify.",
  body_hash_mismatch:
    "This confirmation's body doesn't match its signature, so it can't be verified.",
  field_not_found: "We couldn't find your stay dates and city in this confirmation.",
  field_ambiguous: 'Your stay details appear more than once in this confirmation.',
  field_invalid: "Your stay dates or city aren't written in a way Tablemate can read.",
  city_not_supported: "Tablemate doesn't cover the city in this confirmation yet.",
  registry_mismatch: "Tablemate's verification data is out of date. Update the app and try again.",
  eml_read_failed:
    "We couldn't read that file. Choose the booking confirmation saved as an .eml file.",
  share_intake_unsupported:
    'This device cannot hand a file to Tablemate. Choose the .eml file instead.',
  artifact_download_failed:
    "We couldn't download the proving data. Check your connection and try again.",
  artifact_hash_mismatch:
    "The proving data didn't match its published checksum. Try the download again.",
  artifact_insufficient_storage:
    'There is not enough free space for the proving data. Free some up and try again.',
  artifact_storage_unavailable:
    "This device can't store the proving data. Restart the app and try again.",
  prover_unavailable: "This build can't generate proofs. Update the app and try again.",
  worker_unavailable: 'This browser cannot generate the proof. Try again in an up-to-date browser.',
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

const FLOW_MESSAGES_BY_NAME: Partial<Record<string, string>> = FLOW_MESSAGES;

function failureMessage(code: ProofErrorCode | 'unknown_error'): string {
  return FLOW_MESSAGES_BY_NAME[code] ?? userMessageFor(code);
}

function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GIGABYTE) return `${(bytes / BYTES_PER_GIGABYTE).toFixed(1)} GB`;
  return `${Math.round(bytes / BYTES_PER_MEGABYTE)} MB`;
}

function planText(plan: ArtifactPlan): string {
  if (plan.cached) return PLAN_CACHED;
  const size =
    plan.downloadBytes > 0
      ? `About ${formatBytes(plan.downloadBytes)} of proving data has to be downloaded once.`
      : PLAN_RECHECK;
  const cellular = plan.connection === 'cellular' ? [PLAN_CELLULAR] : [];
  return [size, PLAN_WIFI, ...cellular].join(' ');
}

function percentageText(fraction: number | undefined): string {
  const bounded = Math.min(1, Math.max(0, fraction ?? 0));
  return `${Math.round(bounded * 100)}%`;
}

function progressText(status: ProofFlowStatus): string | null {
  return STATUS_TEXT[status] ?? null;
}

/** Whether the attempt can still be stopped: `submitting` is past the point of no return. */
function isCancellable(status: ProofFlowStatus): boolean {
  return status !== 'submitting' && RUNNING.some((running) => running === status);
}

function cityName(cities: readonly CityDto[] | undefined, cityId: string): string {
  return cities?.find((city) => city.id === cityId)?.name ?? cityId;
}

/** The stay the proof placed the traveller in, both dates as calendar days and never a time zone. */
function acceptedText(accepted: ProofAccepted, city: string): string {
  return `Your stay in ${city} from ${formatCalendarDate(accepted.arrivalDate)} to ${formatCalendarDate(
    accepted.departureDate,
  )} is verified.`;
}

type StatusLineProps = { testID: string; text: string | null };
function StatusLine({ testID, text }: StatusLineProps): ReactElement | null {
  return text === null ? null : (
    <Text testID={testID} style={styles.status}>
      {text}
    </Text>
  );
}

function screenTitle(running: boolean, verified: boolean, stopped: boolean): string {
  if (running) return RUNNING_TITLE;
  if (verified) return ACCEPTED_TITLE;
  return stopped ? CANCELLED_TITLE : FLOW_TITLE;
}

export default function ProofGenerateScreen(): ReactElement {
  const proof = useProofState();
  const handleRef = useRef<EmlHandle | null>(null);
  const takenRef = useRef(false);
  const startedRef = useRef(false);
  const configRef = useRef<ZkConfig | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [staged, setStaged] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<ArtifactPlan | null>(null);
  const [failure, setFailure] = useState<ProofErrorCode | 'unknown_error' | null>(null);
  const [accepted, setAccepted] = useState<ProofAccepted | null>(null);
  const zkConfig = useQuery({
    queryKey: queryKeys.zkConfig,
    queryFn: () => apiClient.getZkConfig(),
    enabled: staged === true,
  });
  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    enabled: accepted !== null,
  });
  const configKnown = zkConfig.data !== undefined;
  useEffect(() => {
    resetProof();
    if (takenRef.current) return;
    takenRef.current = true;
    handleRef.current = takePendingEml();
    void Promise.resolve().then(() => setStaged(handleRef.current !== null));
  }, []);
  useEffect(
    () => () => {
      if (startedRef.current || handleRef.current === null) return;
      void handleRef.current.release().catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (zkConfig.data === undefined) return;
    configRef.current ??= zkConfig.data;
  }, [zkConfig.data]);
  useEffect(() => {
    const artifacts = configRef.current?.artifacts;
    if (artifacts === undefined) return;
    void artifactStore.plan(artifacts).then(setPlan, () => {});
  }, [configKnown]);
  useEffect(() => {
    if (staged !== true || !configKnown || startedRef.current) return undefined;
    const stagedFile = handleRef.current;
    const config = configRef.current;
    if (stagedFile === null || config === null) return undefined;
    startedRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    void (async (): Promise<void> => {
      try {
        const result = await importAndProve(stagedFile, config, { signal });
        setAccepted(result.accepted);
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      } catch (error: unknown) {
        if (signal.aborted) return;
        setFailure(errorCodeOf(error));
      }
    })();
    return () => {
      controller.abort();
      resetProof();
    };
  }, [configKnown, staged]);
  const runningText = progressText(proof.status);
  const cancellable = isCancellable(proof.status);
  const percentage = proof.status === 'downloading' ? percentageText(proof.downloadProgress) : null;
  const planLine = plan === null ? null : planText(plan);
  const cancelled = proof.status === 'cancelled';
  const issuerUnsupported = failure === 'unsupported_issuer';
  const acceptedSentence =
    accepted === null
      ? null
      : acceptedText(accepted, cityName(cities.data?.items, accepted.cityId));
  const supportedText =
    zkConfig.data === undefined ? '' : supportedIssuersText(issuerSupport(zkConfig.data).supported);
  const title = screenTitle(runningText !== null, accepted !== null, cancelled);
  // Each distinct sentence is spoken once; the accepted one waits for the cities read to settle.
  const spoken =
    accepted !== null
      ? cities.isPending
        ? null
        : acceptedSentence
      : issuerUnsupported
        ? UNSUPPORTED_ISSUER
        : failure !== null
          ? failureMessage(failure)
          : cancelled
            ? CANCELLED_TEXT
            : zkConfig.error === null
              ? null
              : failureMessage(errorCodeOf(zkConfig.error));
  useEffect(() => {
    if (spoken !== null) announce(spoken);
  }, [spoken]);
  const cancel = (): void => controllerRef.current?.abort();
  const retryNow = (): void => void zkConfig.refetch();
  const cancelButton = { variant: 'secondary' as const, label: CANCEL_LABEL, onPress: cancel };
  const empty =
    staged === false ? (
      <>
        <Card testID="proof-generate-empty" title={EMPTY_TITLE}>
          <Text style={styles.body}>{EMPTY_TEXT}</Text>
        </Card>
        <Button {...CHOOSE_AGAIN} testID="proof-generate-choose" />
      </>
    ) : null;
  const verified =
    accepted !== null ? (
      <>
        <Card testID="proof-generate-accepted">
          {acceptedSentence === null ? null : <Text style={styles.body}>{acceptedSentence}</Text>}
        </Card>
        <Button {...GO_TO_DISCOVER} testID="proof-generate-discover" />
      </>
    ) : null;
  const stopped = cancelled ? (
    <>
      <Card testID="proof-generate-cancelled">
        <Text style={styles.body}>{CANCELLED_TEXT}</Text>
      </Card>
      <Button {...CHOOSE_AGAIN} testID="proof-generate-cancelled-choose" />
    </>
  ) : null;
  const unsupportedIssuer = issuerUnsupported ? (
    <>
      <Banner
        tone="warning"
        title={UNSUPPORTED_ISSUER}
        message={supportedText}
        testID="proof-generate-unsupported"
      />
      <Button {...CHOOSE_AGAIN} testID="proof-generate-unsupported-choose" />
    </>
  ) : null;
  const failed =
    failure !== null && !issuerUnsupported ? (
      <>
        <Banner tone="error" message={failureMessage(failure)} testID="proof-generate-failed" />
        <Button {...CHOOSE_AGAIN} testID="proof-generate-failed-choose" />
      </>
    ) : null;
  const unreadable =
    zkConfig.error !== null ? (
      <Banner
        tone="error"
        message={failureMessage(errorCodeOf(zkConfig.error))}
        action={{ label: RETRY_LABEL, onPress: retryNow, testID: 'proof-generate-config-retry' }}
        testID="proof-generate-config-error"
      />
    ) : null;
  const running =
    runningText !== null ? (
      <>
        <StatusLine testID="proof-generate-plan" text={planLine} />
        <StatusLine testID="proof-generate-status" text={runningText} />
        <StatusLine testID="proof-generate-percent" text={percentage} />
        {cancellable ? <Button {...cancelButton} testID="proof-generate-cancel" /> : null}
      </>
    ) : null;
  const shown = [empty, verified, stopped, unsupportedIssuer, failed, unreadable, running];
  return (
    <>
      <Stack.Screen options={{ title }} />
      <Screen edges={SCREEN_EDGES} testID="proof-generate">
        <Card testID="proof-generate-privacy">
          <Text style={styles.statement}>{EMAIL_STAYS_ON_DEVICE}</Text>
        </Card>
        {shown.find((state) => state !== null) ?? (
          <Text testID="proof-generate-preparing" style={styles.muted}>
            {PREPARING}
          </Text>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  statement: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  status: { ...typography.body, color: colors.text },
  body: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted },
});
