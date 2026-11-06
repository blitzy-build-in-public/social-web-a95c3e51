/**
 * Proof generation — the second half of the proof-import flow (`/proof/generate`, AAP 0.5.5,
 * AAP 0.5.8, success criterion 3).
 *
 * `app/proof/import.tsx` stages exactly one `.eml` and pushes here. This screen takes that file once,
 * reads the published `GET /v1/zk/config`, says what the proving data will cost, generates the proof
 * on the device and submits `{ proof, publicSignals }` — the whole of what the server learns about
 * the booking (AAP 0.12.2). The email itself is never held anywhere durable: the bytes live in the
 * staged handle for the length of one attempt, the handle is kept only in a ref, so no route
 * parameter, store field, snapshot or log line can carry it, and it is released on every path — by
 * `importAndProve` once that call owns it, and by this screen when the attempt never started
 * (AAP 0.5.5).
 *
 * One attempt runs at a time and each of its steps is a line the traveller reads: reading the file,
 * downloading the proving data with a percentage, generating the proof — the slow step, on this
 * device's own CPU — and submitting it. Cancel is offered while the proof is still being put
 * together and withheld once it has left the device, because from there the server's own answer is
 * the only way to learn whether the booking reference was already used (AAP 0.5.5). Every refusal is
 * this app's sentence for a code, never the server's text (AAP 0.11.1), and the promise the flow
 * rests on — {@link EMAIL_STAYS_ON_DEVICE} — is stated here, on the screen that reads the file, not
 * only after something has gone wrong (AAP 0.5.8). Nothing here logs (AAP 0.11.1).
 */
import { useQuery } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
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

// --- Constants -----------------------------------------------------------------------------------

/**
 * The header title of each state, and the page's only heading: the Stack renders it (AAP 0.5.8).
 *
 * The title names the state the traveller is in rather than the step the screen was opened for, so
 * it cannot contradict the body under it — a screen headed "Generating your proof" while the attempt
 * has stopped or the stay is verified reads as a stale page. The three settled states and the wait
 * before an attempt all share {@link FLOW_TITLE}, the capability's own name, which is the heading the
 * import screen carries too.
 */
const FLOW_TITLE = 'Verify my stay';
const RUNNING_TITLE = 'Generating your proof';
const ACCEPTED_TITLE = 'Stay verified';
const CANCELLED_TITLE = 'Proving stopped';

/** The edges this screen insets by: the Stack header already clears the status bar. */
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

/** Shown while `GET /zk/config` is in flight: the one wait with nothing of its own to report. */
const PREPARING = 'Preparing…';

/**
 * The four steps in which an attempt is running, derived from the store's own status type so a
 * status added there fails this file's type check rather than rendering no line at all.
 */
type RunningStatus = Exclude<ProofFlowStatus, 'idle' | 'accepted' | 'error' | 'cancelled'>;

/** One line per running step, from the store's status alone (AAP 0.5.5). */
const STATUS_TEXT = {
  reading: 'Reading your booking confirmation…',
  downloading: 'Downloading the proving data…',
  proving: 'Generating the proof on this device. This is the slow step, and it can take a minute.',
  submitting: 'Sending your proof…',
} as const satisfies Record<RunningStatus, string>;

/** The one state a first visit without a file reads; the header carries the flow's own name. */
const EMPTY_TITLE = 'No booking email chosen';
const EMPTY_TEXT =
  'Choose an exported booking confirmation to prove where and when you are staying.';
/** What the stopped state says, under the {@link CANCELLED_TITLE} header. */
const CANCELLED_TEXT = 'The proof was stopped before it finished, so no stay was verified.';

/** Every control's visible label, which is also its accessible name (AAP 0.5.8). */
const CHOOSE_LABEL = 'Choose a booking email';
const CANCEL_LABEL = 'Cancel';
const TRY_AGAIN_LABEL = 'Try again';
const DISCOVER_LABEL = 'Go to Discover';

/** The artefact plan's lines: the estimate, the recommendation and the one case that costs money. */
const PLAN_CACHED = 'The proving data is already on this device, so nothing needs downloading.';
const PLAN_RECHECK = 'The proving data on this device is checked again before it is used.';
const PLAN_WIFI = 'Use Wi-Fi if you can.';
const PLAN_CELLULAR = "You're on cellular data, so this download counts against your plan.";

/**
 * A kilobyte, a megabyte and a gigabyte as the estimate is rendered in, from bytes (AAP 0.5.5).
 *
 * Decimal steps, because that is what the label says and what the platforms that report a download
 * size use: a 1,420,000,000-byte download is the "1.4 GB" the traveller's phone shows for it, not the
 * 1.3 a binary division would print under a decimal label.
 */
const BYTES_PER_KILOBYTE = 1000;
const BYTES_PER_MEGABYTE = 1000 * BYTES_PER_KILOBYTE;
const BYTES_PER_GIGABYTE = 1000 * BYTES_PER_MEGABYTE;

// --- The sentences a failed attempt shows ---------------------------------------------------------

/**
 * Every code the proving flow raises itself: the input generator's, this client's, the five the
 * native module adds, and the one {@link errorCodeOf} falls back to. The API client's codes are
 * deliberately absent — `userMessageFor` owns those, and {@link failureMessage} reads one or the
 * other by name, so no code list is declared twice (AAP 0.11.1).
 */
type FlowErrorCode =
  | CircuitInputErrorCode
  | ZkClientErrorCode
  | 'zkey_missing'
  | 'inputs_invalid'
  | 'prover_failed'
  | 'file_missing'
  | 'hash_failed'
  | 'unknown_error';

/**
 * This screen's own sentence for each code the proving flow can end on (AAP 0.5.8, AAP 0.11.1).
 *
 * The record is complete over {@link FlowErrorCode}, so a code added to the flow fails this file's
 * type check rather than showing nothing. Every sentence is short, actionable and about the attempt
 * at hand: none names a field, an id, a path, a URL or a provider, repeats the server's own text, or
 * restates a fixed string of AAP 0.5.8 — the unsupported-issuer case renders that string itself.
 */
const FLOW_MESSAGES = {
  // The input generator (AAP 0.5.5).
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

  // This client's own proving flow (AAP 0.5.5).
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

  // The native prover module's own codes, and a failure that offered no code at all.
  zkey_missing: 'The proving key is missing on this device. Try the download again.',
  inputs_invalid: "The details in this confirmation couldn't be turned into a proof.",
  prover_failed: 'Generating the proof failed on this device. Try again.',
  file_missing: 'The booking file is no longer available. Choose it again.',
  hash_failed: 'The proving data failed its integrity check. Try the download again.',
  unknown_error: 'Something went wrong while generating the proof. Try again.',
} as const satisfies Record<FlowErrorCode, string>;

/**
 * The same sentences, read by name rather than by code: an attempt's code is a
 * {@link ProofErrorCode | code of the flow} and may belong to the API client instead, which
 * {@link failureMessage} answers from this screen's record when it can and from the client's own
 * mapping when it cannot.
 */
const FLOW_MESSAGES_BY_NAME: Partial<Record<string, string>> = FLOW_MESSAGES;

/** The sentence this screen shows for a failure: its own copy, or the API client's for a code it owns. */
function failureMessage(code: ProofErrorCode | 'unknown_error'): string {
  return FLOW_MESSAGES_BY_NAME[code] ?? userMessageFor(code);
}

// --- Pure helpers --------------------------------------------------------------------------------

/**
 * A byte count as the size a traveller recognises: `820 MB`, or `1.4 GB` at a gigabyte and above
 * (AAP 0.5.5). The figure is the published artefact length, so it is an estimate and never a
 * measurement of what the network will spend.
 */
function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GIGABYTE) return `${(bytes / BYTES_PER_GIGABYTE).toFixed(1)} GB`;
  return `${Math.round(bytes / BYTES_PER_MEGABYTE)} MB`;
}

/**
 * What the download would cost, said before it starts (AAP 0.5.5): the artefacts already on the
 * device, the bytes still to fetch with a Wi-Fi recommendation, or — when there is nothing left to
 * measure — the check the next attempt makes instead. A cellular connection is named, because that
 * is the one case the download costs the traveller something Wi-Fi would not.
 */
function planText(plan: ArtifactPlan): string {
  if (plan.cached) return PLAN_CACHED;

  const size =
    plan.downloadBytes > 0
      ? `About ${formatBytes(plan.downloadBytes)} of proving data has to be downloaded once.`
      : PLAN_RECHECK;
  const lines = [size, PLAN_WIFI];
  if (plan.connection === 'cellular') lines.push(PLAN_CELLULAR);
  return lines.join(' ');
}

/** A 0-1 download fraction as the whole percentage the traveller reads. */
function percentageText(fraction: number | undefined): string {
  const bounded = Math.min(1, Math.max(0, fraction ?? 0));
  return `${Math.round(bounded * 100)}%`;
}

/** The status line of a running step, or null when no attempt is running (AAP 0.5.5). */
function progressText(status: ProofFlowStatus): string | null {
  switch (status) {
    case 'reading':
    case 'downloading':
    case 'proving':
    case 'submitting':
      return STATUS_TEXT[status];
    default:
      return null;
  }
}

/**
 * Whether the attempt can still be stopped. `submitting` is deliberately not one of these: the proof
 * has left the device by then, so the API may already have spent its nullifier, and its answer is
 * the only way to learn whether it did (AAP 0.5.5).
 */
function isCancellable(status: ProofFlowStatus): boolean {
  return status === 'reading' || status === 'downloading' || status === 'proving';
}

/**
 * The display name of the city a proof named, from the cities read the Discover picker populates; the
 * slug itself when that read holds no such city, so an island whose configuration is unavailable
 * still shows the traveller where the proof placed them.
 */
function cityName(cities: readonly CityDto[] | undefined, cityId: string): string {
  return cities?.find((city) => city.id === cityId)?.name ?? cityId;
}

/**
 * The sentence the accepted state shows and speaks: the city the proof placed the traveller in, and
 * the stay it proved. Both dates arrive as `YYYY-MM-DD` and are formatted as calendar days, never
 * through a time zone (AAP 0.5.5).
 */
function acceptedText(accepted: ProofAccepted, city: string): string {
  return `Your stay in ${city} from ${formatCalendarDate(accepted.arrivalDate)} to ${formatCalendarDate(
    accepted.departureDate,
  )} is verified.`;
}

// --- The screen ----------------------------------------------------------------------------------

/**
 * The proof generation screen: the staged booking confirmation read once, the download it needs, the
 * proof itself with its progress and its Cancel, and the state each outcome leaves the traveller in
 * (AAP 0.5.5, AAP 0.5.8).
 *
 * Reading and focus order is source order — the promise of the flow, then the state, then its one
 * action — and every control is a `Button`, so each carries a role, an accessible name equal to its
 * visible label, a 44×44 target and a focus ring. Each error is both rendered in a `Banner`'s live
 * region and spoken with `announce`, and the accepted, cancelled, unsupported and failed states are
 * announced once each. Nothing is signalled by colour alone: an error or warning banner shows its
 * status word as its title (AAP 0.5.8).
 *
 * Reads made here, in order: the published configuration over the cached `queryKeys.zkConfig`, so the
 * import screen's answer is reused rather than requested twice; and, once a proof has been accepted,
 * the configured cities, for the one city name that sentence needs (AAP 0.5.4, AAP 0.5.5).
 *
 * @returns The generate screen's element.
 */
export default function ProofGenerateScreen(): ReactElement {
  const proof = useProofState();

  /** The staged file, this mount's one app-owned copy: in a ref, so no render can reach it. */
  const handleRef = useRef<EmlHandle | null>(null);

  /** True once the staged slot has been read, so no second effect run can take a later file. */
  const takenRef = useRef(false);

  /** True once the attempt owns the file: from there `importAndProve` releases it, not this screen. */
  const startedRef = useRef(false);

  /** The configuration the attempt was started against: written once, so a refetch cannot move it. */
  const configRef = useRef<ZkConfig | null>(null);

  /** The attempt's controller, so Cancel can abort the run this screen started. */
  const controllerRef = useRef<AbortController | null>(null);

  /**
   * Whether a file was staged for this visit: `null` until the staged slot has been read, so the
   * frame before that read shows neither the empty state nor progress. It is all a render is allowed
   * to know about the file, which stays in the ref below.
   */
  const [staged, setStaged] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<ArtifactPlan | null>(null);
  const [failure, setFailure] = useState<ProofErrorCode | 'unknown_error' | null>(null);
  const [accepted, setAccepted] = useState<ProofAccepted | null>(null);

  const zkConfig = useQuery({
    queryKey: queryKeys.zkConfig,
    queryFn: () => apiClient.getZkConfig(),
    // Enabled once a file is known to be staged: a deep link, a refresh or a second visit must not
    // read a configuration it has no use for (AAP 0.5.5).
    enabled: staged === true,
  });

  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    // The display name of the city an accepted proof named, usually already cached by Discover.
    enabled: accepted !== null,
  });

  /**
   * True from the first successful configuration read, and never false again: the effects below
   * depend on this rather than on the query's data, so a refetch while the proof is running cannot
   * abort the attempt or re-read the plan.
   */
  const configKnown = zkConfig.data !== undefined;

  // --- Effects ------------------------------------------------------------------------------------

  // The staged file, and the store it is proved into. The copy is taken here rather than during a
  // render, which React may run twice, and the read is latched: the slot empties the moment it is
  // read, so a second read would take the file staged for a later visit (AAP 0.5.5).
  useEffect(() => {
    // Cleared on mount, before the attempt starts: nothing an earlier attempt left in the store —
    // its error, its progress — may paint over this one (AAP 0.5.5).
    resetProof();

    if (takenRef.current) return;
    takenRef.current = true;
    handleRef.current = takePendingEml();
    const found = handleRef.current !== null;

    // Only whether a file was there reaches the render; the file itself stays in the ref. The mirror
    // is applied off the effect's own body, so the effect synchronizes with the staged slot and
    // nothing else, and a render state written from within that body is the cascading render React
    // asks an effect to avoid.
    void Promise.resolve().then(() => {
      setStaged(found);
    });
  }, []);

  // The app-owned copy is released here when this screen is left before the attempt starts: no other
  // path owns it then. Once `importAndProve` has been called it owns the file and releases it on
  // every path, so this cleanup must leave it alone (AAP 0.5.5).
  useEffect(
    () => () => {
      if (startedRef.current) return;
      const stagedFile = handleRef.current;
      if (stagedFile === null) return;
      void stagedFile.release().catch(() => {});
    },
    [],
  );

  // The configuration the attempt is built against, kept the moment it arrives: a refetch while the
  // proof is running must not move the configuration out from under it.
  useEffect(() => {
    if (zkConfig.data === undefined) return;
    configRef.current ??= zkConfig.data;
  }, [zkConfig.data]);

  // What the download would cost, asked for the moment the configuration is known — which is before
  // the artefacts are fetched, the wait this line exists for (AAP 0.5.5). It is advice only: a device
  // that cannot answer shows no estimate and goes on to prove, because an unreadable estimate is not
  // a failed attempt.
  useEffect(() => {
    const artifacts = configRef.current?.artifacts;
    if (artifacts === undefined) return;

    void (async (): Promise<void> => {
      try {
        setPlan(await artifactStore.plan(artifacts));
      } catch {
        // Intentionally ignored: see above — the estimate is advisory and never the outcome.
      }
    })();
  }, [configKnown]);

  // The attempt itself, started once, with a file and a configuration in hand.
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
        // `importAndProve` drives the store through `reading`, `downloading`, `proving` and
        // `submitting`, so the progress this screen shows comes from the store alone, and it
        // releases the file on every path (AAP 0.5.5).
        const result = await importAndProve(stagedFile, config, { signal });
        setAccepted(result.accepted);
        // The proof unlocks the Profile proof line and every proof-gated screen, all of which read
        // `GET /me`: the read is asked again rather than waiting out its cache (AAP 0.5.4, 0.5.8).
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      } catch (error: unknown) {
        // A cancel is already the store's `cancelled` status and is rendered from it, and an aborted
        // attempt belongs to a screen that has been left: neither records a failure here.
        if (signal.aborted) return;
        setFailure(errorCodeOf(error));
      }
    })();

    return () => {
      // Unmount aborts the attempt and clears the store after it, in that order: a run left behind
      // must not keep writing progress onto a screen the traveller has left (AAP 0.5.5).
      controller.abort();
      resetProof();
    };
  }, [configKnown, staged]);

  // --- What the render shows ----------------------------------------------------------------------

  const runningText = progressText(proof.status);
  const cancellable = isCancellable(proof.status);
  const percentage = proof.status === 'downloading' ? percentageText(proof.downloadProgress) : null;
  const planLine = plan === null ? null : planText(plan);
  const cancelled = proof.status === 'cancelled';
  const unsupported = failure === 'unsupported_issuer';
  const acceptedSentence =
    accepted === null
      ? null
      : acceptedText(accepted, cityName(cities.data?.items, accepted.cityId));

  /** The state's own name, so the heading above the body describes the state the body shows. */
  const title =
    runningText !== null
      ? RUNNING_TITLE
      : accepted !== null
        ? ACCEPTED_TITLE
        : cancelled
          ? CANCELLED_TITLE
          : FLOW_TITLE;

  /**
   * The sentence to speak, once. The accepted sentence waits for the cities read to settle, so a
   * screen reader hears it once with the city's name rather than twice — the slug first (AAP 0.5.8).
   */
  const spoken =
    accepted !== null
      ? cities.isPending
        ? null
        : acceptedSentence
      : unsupported
        ? UNSUPPORTED_ISSUER
        : failure !== null
          ? failureMessage(failure)
          : cancelled
            ? CANCELLED_TEXT
            : zkConfig.error === null
              ? null
              : failureMessage(errorCodeOf(zkConfig.error));

  // Each distinct sentence is spoken once: iOS has no live region for a banner, and what is spoken
  // here is the app's own copy, never server text (AAP 0.5.8, AAP 0.11.1).
  useEffect(() => {
    if (spoken !== null) announce(spoken);
  }, [spoken]);

  // --- Actions ------------------------------------------------------------------------------------

  /** Leaves for the import screen: another file is the next step of every state that has none. */
  const chooseAnother = (): void => {
    router.replace('/proof/import');
  };

  /** Stops the running attempt; the store ends it as `cancelled`, which this screen renders. */
  const cancel = (): void => {
    controllerRef.current?.abort();
  };

  const goToDiscover = (): void => {
    router.replace('/discover');
  };

  // --- The states, in the order the flow reaches them ---------------------------------------------

  /** A deep link, a refresh, or a visit after a proof was already generated: nothing is staged. */
  const emptyState =
    staged !== false ? null : (
      <>
        <Card testID="proof-generate-empty" title={EMPTY_TITLE}>
          <Text style={styles.body}>{EMPTY_TEXT}</Text>
        </Card>
        <Button label={CHOOSE_LABEL} onPress={chooseAnother} testID="proof-generate-choose" />
      </>
    );

  /**
   * The stay the server accepted, which is what every proof-gated screen now unlocks. The header
   * names the outcome, so the card carries the sentence alone rather than repeating it.
   */
  const acceptedState =
    accepted === null ? null : (
      <>
        <Card testID="proof-generate-accepted">
          {acceptedSentence === null ? null : <Text style={styles.body}>{acceptedSentence}</Text>}
        </Card>
        <Button label={DISCOVER_LABEL} onPress={goToDiscover} testID="proof-generate-discover" />
      </>
    );

  /** The attempt the traveller stopped, which can be started again only from a new import. */
  const cancelledState = cancelled ? (
    <>
      <Card testID="proof-generate-cancelled">
        <Text style={styles.body}>{CANCELLED_TEXT}</Text>
      </Card>
      <Button
        label={CHOOSE_LABEL}
        onPress={chooseAnother}
        testID="proof-generate-cancelled-choose"
      />
    </>
  ) : null;

  /**
   * The one state a booking site that does not verify leaves: the fixed sentence the import screen
   * shows for the same case, with the sites the configuration does support named under it, so the
   * traveller can tell a site awaiting its samples from one that is never accepted (AAP 0.5.5,
   * AAP 0.5.8).
   */
  const unsupportedState = !unsupported ? null : (
    <>
      <Banner
        tone="warning"
        title={UNSUPPORTED_ISSUER}
        message={
          zkConfig.data === undefined
            ? ''
            : supportedIssuersText(issuerSupport(zkConfig.data).supported)
        }
        testID="proof-generate-unsupported"
      />
      <Button
        label={CHOOSE_LABEL}
        onPress={chooseAnother}
        testID="proof-generate-unsupported-choose"
      />
    </>
  );

  /** Any other refusal: the app's own sentence for the code (AAP 0.11.1). */
  const failedState =
    failure === null || unsupported ? null : (
      <>
        <Banner tone="error" message={failureMessage(failure)} testID="proof-generate-failed" />
        <Button
          label={CHOOSE_LABEL}
          onPress={chooseAnother}
          testID="proof-generate-failed-choose"
        />
      </>
    );

  /** The configuration read this screen cannot prove without, and the retry that asks again. */
  const configState =
    zkConfig.error === null ? null : (
      <Banner
        tone="error"
        message={failureMessage(errorCodeOf(zkConfig.error))}
        action={{
          label: TRY_AGAIN_LABEL,
          onPress: () => void zkConfig.refetch(),
          testID: 'proof-generate-config-retry',
        }}
        testID="proof-generate-config-error"
      />
    );

  /** The steps of the attempt, with the percentage while the proving data downloads. */
  const runningState =
    runningText === null ? null : (
      <>
        {planLine === null ? null : (
          <Text testID="proof-generate-plan" style={styles.body}>
            {planLine}
          </Text>
        )}
        <Text testID="proof-generate-status" style={styles.status}>
          {runningText}
        </Text>
        {percentage === null ? null : (
          <Text testID="proof-generate-percent" style={styles.status}>
            {percentage}
          </Text>
        )}
        {cancellable ? (
          <Button
            variant="secondary"
            label={CANCEL_LABEL}
            onPress={cancel}
            testID="proof-generate-cancel"
          />
        ) : null}
      </>
    );

  return (
    <>
      <Stack.Screen options={{ title }} />
      <Screen edges={SCREEN_EDGES} testID="proof-generate">
        {/* The promise the whole flow rests on, on the screen that reads the file and proves with it:
            rendered before anything is attempted, and not only after a failure (AAP 0.5.8). */}
        <Card testID="proof-generate-privacy">
          <Text style={styles.statement}>{EMAIL_STAYS_ON_DEVICE}</Text>
        </Card>

        {/* Exactly one of these is shown, in the order the flow reaches them: nothing staged, an
            accepted proof, a stopped attempt, an unsupported booking site, any other refusal, a
            configuration that could not be read, the running steps, and the wait for the
            configuration. */}
        {emptyState ??
          acceptedState ??
          cancelledState ??
          unsupportedState ??
          failedState ??
          configState ??
          runningState ?? (
            <Text testID="proof-generate-preparing" style={styles.muted}>
              {PREPARING}
            </Text>
          )}
      </Screen>
    </>
  );
}

// --- Styles --------------------------------------------------------------------------------------

/* Only the type and the tone differ between these; every colour is a token whose pair is recorded
 * against the fill it is painted on, and no size is a literal, so the reader's system font size
 * scales the screen instead of clipping it (AAP 0.5.8). */
const styles = StyleSheet.create({
  statement: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  status: {
    ...typography.body,
    color: colors.text,
  },
  body: {
    ...typography.body,
    color: colors.text,
  },
  muted: {
    ...typography.body,
    color: colors.textMuted,
  },
});
