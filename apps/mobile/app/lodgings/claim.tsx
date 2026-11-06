/**
 * I'm staying here — the lodging stay claim: the exception notice, consent, submission, status and
 * withdrawal (AAP 0.5.8, AAP 0.12.2, criterion 14).
 *
 * The screen turns on one binding order. A stay-verification call is the single place Tablemate's
 * zero-knowledge principle is set aside — the assistant names the booking to the lodging and tells
 * it that a guest with that name uses Tablemate — so the notice of exactly what will be said is
 * rendered before the consent control, and that control stays disabled until the notice holds the
 * real lodging, booking name and dates (AAP 0.12.2). Consent therefore binds to the notice the
 * traveller read: its sentence is rebuilt on every keystroke, and any change to it clears the consent
 * again.
 *
 * One of five modes is picked per render, in this order: a missing `lodgingId` or an unknown
 * lodging; no valid proof for a city; the status of a claim this screen submitted or the own-account
 * read already holds for this lodging; an active claim at another lodging; and the form. The stay
 * dates are validated here for convenience alone — the API is authoritative with
 * `422 claim_dates_invalid` — and the proof's own stay prefills the two fields.
 *
 * The booking name and reference live in this component's state and nowhere else: not in a route
 * parameter, not in the query or mutation cache (which is why submission is a plain async handler, a
 * React Query mutation keeping its `variables`), not in storage, not in a log line, and not in an
 * error message or an announcement. Both are cleared the moment the server has them and leave with
 * the component on unmount (AAP 0.5.2, AAP 0.11.1).
 *
 * @see AAP 0.5.3 for the claim lifecycle and its 72-hour expiry, 0.5.4 for the three routes and their
 * errors, 0.5.7 for the claim rules, and 0.5.8 for the path, the fixed notice and the a11y rules.
 */
import { useQuery } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { StyleSheet, Switch, Text, View, type TextProps } from 'react-native';
import {
  BOOKING_NAME_MAX_CHARS,
  BOOKING_REFERENCE_MAX_CHARS,
  MIN_TOUCH_TARGET,
  colors,
  fontWeights,
  spacing,
  typography,
} from '@tablemate/shared';
import type { LodgingClaimStatus, ProofStatus } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import {
  IMPORT_BANNER,
  LODGING_CALL_CONSENT_LABEL,
  lodgingCallNotice,
} from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../src/ui';
import type { ScreenProps } from '../../src/ui';

// --- Constants -----------------------------------------------------------------------------------

/** The route's header title (AAP 0.5.8). */
const SCREEN_TITLE = "I'm staying here";

/**
 * The lodging's name in the page body. The header renders the route's own title as the page's only
 * level-one heading, so the name this screen knows sits beneath it at level 2: `role="heading"` is
 * the platform's header trait, and `aria-level` is what react-native-web 0.19 reads to render a real
 * `<h2>` rather than the `<h1>` an unlevelled heading role becomes.
 */
const LODGING_NAME_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/** The one proof state that reaches the claim routes; every other answers `403 no_valid_proof`. */
const VALID_PROOF_STATUS = 'valid' satisfies ProofStatus;

/** How often the claim is read again while a verification call may still be running (AAP 0.5.3). */
const CLAIM_POLL_MS = 10_000;
const POLLED_CLAIM_STATUSES: readonly LodgingClaimStatus[] = ['pending_call', 'calling'];

/** The statuses that end a claim (the guest count may have moved), and those a claim may leave. */
const TERMINAL_CLAIM_STATUSES: readonly LodgingClaimStatus[] = [
  'verified',
  'rejected',
  'unreachable',
];
const WITHDRAWABLE_CLAIM_STATUSES: readonly LodgingClaimStatus[] = [
  'pending_call',
  'calling',
  'verified',
];

/**
 * The status view's one line per lifecycle value, in the request's own words. A complete record, so
 * a status added to the shared enum fails the type check here rather than rendering nothing.
 */
const CLAIM_STATUS_TEXT = {
  pending_call: 'Waiting for the call',
  calling: 'Calling the lodging now',
  verified: 'Verified',
  rejected: 'Not confirmed',
  unreachable: "Couldn't reach the lodging",
} as const satisfies Record<LodgingClaimStatus, string>;

/** Whole length of a `YYYY-MM-DD` value, which is what the two fields accept. */
const DATE_LENGTH = 10;

/** Shown inline under a field that holds no date, and under the arrival field of a backwards stay. */
const DATE_FORMAT_ERROR = 'Use the format YYYY-MM-DD.';
const DATE_ORDER_ERROR = "The arrival date can't be after the departure date.";

/**
 * Raised only by a wiring mistake: neither query is enabled without the id it reads, so a rejection
 * here would mean one was.
 */
const NO_LODGING_ID = 'The lodging query was enabled without an id.';
const NO_CLAIM_ID = 'The claim query was enabled without an id.';

/**
 * Every other sentence this screen owns. The exception notice and the consent label are the copy
 * module's, and no API error's sentence is repeated here: those come from `userMessageFor`.
 */
const LOADING_TEXT = 'Loading…';
const LODGING_UNAVAILABLE = "This lodging isn't available.";
const LODGINGS_LABEL = 'Lodgings';
const VERIFY_MY_STAY = 'Verify my stay';
const TRY_AGAIN = 'Try again';
const MY_STAY_LABEL = 'My stay';
const ARRIVAL_LABEL = 'Arrival date (YYYY-MM-DD)';
const DEPARTURE_LABEL = 'Departure date (YYYY-MM-DD)';
const BOOKING_NAME_LABEL = 'Name on the booking';
const BOOKING_REFERENCE_LABEL = 'Booking reference (optional)';
const NOTICE_PENDING_HINT =
  'Enter the name on your booking and valid dates to see exactly what the lodging will be told.';
const SUBMIT_LABEL = 'Request verification call';
const SHOW_STAY_LABEL = "Choose whether other travelers can see you're staying here";
const NEW_CLAIM_LABEL = 'Start a new claim';
const WITHDRAW_LABEL = 'Withdraw claim';
const WITHDRAW_CONFIRM_TEXT = 'Withdraw this claim? Your booking details will be deleted.';
const WITHDRAW_CONFIRM_LABEL = 'Withdraw';
const KEEP_CLAIM_LABEL = 'Keep claim';
const CLAIM_SUBMITTED = 'Claim submitted. Waiting for the call.';
const CLAIM_WITHDRAWN = 'Claim withdrawn.';
const CLAIM_GONE = 'This claim no longer exists.';
const WITHDRAW_IN_PROGRESS = 'A call is in progress. Try again in a few minutes.';

/** The header already insets the vertical sides, so only the horizontal ones are claimed here. */
const SCREEN_EDGES = ['left', 'right'] as const;

/**
 * The status line's live region. React Native maps `aria-live` to Android's live region and
 * react-native-web renders it for the DOM; iOS has none, and `announce` covers it there.
 */
const STATUS_LIVE_REGION = { 'aria-live': 'polite' } as const;

/** The two fields' inline errors, each null while that field is acceptable. */
interface StayDateErrors {
  readonly from: string | null;
  readonly to: string | null;
}

/** Both fields acceptable, shared so the common render allocates nothing for them. */
const NO_DATE_ERRORS: StayDateErrors = { from: null, to: null };

// --- Pure helpers --------------------------------------------------------------------------------

/**
 * The code of a failed React Query read, or null while it has not failed. A failure that is not an
 * `ApiError` — a bug in a `queryFn` — reads as `invalid_response`, so the screen shows its own
 * fallback sentence rather than the failure's text (AAP 0.11.1).
 */
function failureCode(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return isApiError(error) ? error.code : 'invalid_response';
}

/** `YYYY-MM-DD` exactly: four digits, two digits, two digits, and nothing around them. */
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True when `value` is exactly `YYYY-MM-DD` and a real calendar date.
 *
 * The date is built in UTC and its three components are read back, which is what rejects
 * `2027-02-30` instead of rolling it into March, and it is never built in local time: a stay date is
 * a calendar day with no time zone (AAP 0.5.7).
 */
function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (match === null) return false;

  const year = match[1];
  const month = match[2];
  const day = match[3];
  if (year === undefined || month === undefined || day === undefined) return false;

  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return false;

  const parsed = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  return (
    parsed.getUTCFullYear() === yearNumber &&
    parsed.getUTCMonth() === monthNumber - 1 &&
    parsed.getUTCDate() === dayNumber
  );
}

/**
 * The two stay fields' errors.
 *
 * A convenience alone, the API being authoritative with `422 claim_dates_invalid`, which this screen
 * shows through `userMessageFor`. The rules are checked in this order, and the order is the
 * behaviour: a date that is not a date at all, then a value outside the proof's own stay — nothing
 * outside the verified stay can be claimed, whatever else is wrong with the pair — and only then a
 * stay that runs backwards, which is reachable only while both dates sit inside the proof. An
 * out-of-range value is reported on the field that holds it, so the traveller is pointed at the value
 * to correct, and the sentence names the proof's own dates in the form the fields take. ISO date
 * strings compare in date order, which is why the range test is a comparison.
 */
function validateStayDates(
  stayFrom: string,
  stayTo: string,
  proofFrom: string | undefined,
  proofTo: string | undefined,
): StayDateErrors {
  const fromIsDate = isCalendarDate(stayFrom);
  const toIsDate = isCalendarDate(stayTo);
  if (!fromIsDate || !toIsDate) {
    return { from: fromIsDate ? null : DATE_FORMAT_ERROR, to: toIsDate ? null : DATE_FORMAT_ERROR };
  }

  if (proofFrom !== undefined && proofTo !== undefined) {
    const rangeError = `Dates must fall within your verified stay (${proofFrom} to ${proofTo}).`;
    const fromOutside = stayFrom < proofFrom || stayFrom > proofTo;
    const toOutside = stayTo < proofFrom || stayTo > proofTo;
    if (fromOutside || toOutside) {
      return { from: fromOutside ? rangeError : null, to: toOutside ? rangeError : null };
    }
  }

  if (stayFrom > stayTo) return { from: DATE_ORDER_ERROR, to: null };
  return NO_DATE_ERRORS;
}

// --- The screen (AAP 0.5.8, AAP 0.12.2) ---------------------------------------------------------

/**
 * The stay claim screen: the exception notice, the consent that follows it, the submission, and the
 * status, withdrawal and restart of the claim it creates.
 *
 * @returns The mode of the screen for the current state of the route, the caller and the claim.
 */
export default function LodgingClaimScreen(): ReactElement {
  const params = useLocalSearchParams();
  const requested = params.lodgingId;
  // A repeated query parameter arrives as an array, which is not a lodging id: the screen treats it as
  // none rather than reading a lodging the traveller never asked for.
  const lodgingId = typeof requested === 'string' && requested !== '' ? requested : undefined;

  const me = useMe();

  // The form's own state. The booking name and reference are the only personal values here, and they
  // never leave this component (AAP 0.5.2).
  //
  // A stay date is held as null until the traveller edits it, so the proof's own dates can stand as
  // the field's value without an effect writing them into state — which would overwrite what has
  // been typed if the proof arrived late.
  const [stayFromEdit, setStayFromEdit] = useState<string | null>(null);
  const [stayToEdit, setStayToEdit] = useState<string | null>(null);
  const [bookingName, setBookingName] = useState('');
  const [bookingReference, setBookingReference] = useState('');
  // Consent is the notice sentence the traveller agreed to, not a flag: see `consent` below.
  const [consentedNotice, setConsentedNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [proofRefused, setProofRefused] = useState(false);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [claimDismissed, setClaimDismissed] = useState(false);
  const [confirmingWithdrawal, setConfirmingWithdrawal] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const announcedStatus = useRef<LodgingClaimStatus | null>(null);
  const refreshedForStatus = useRef<LodgingClaimStatus | null>(null);

  // --- The caller, the proof, the lodging and the claim -------------------------------------------

  const proof = me.data?.proof;
  const proofValid = proof?.status === VALID_PROOF_STATUS;
  // The proof's dates are present only alongside a valid status by contract, and are read only then:
  // they prefill the form and bound the range check, neither of which means anything otherwise.
  const proofFrom = proof?.status === VALID_PROOF_STATUS ? proof.arrivalDate : undefined;
  const proofTo = proof?.status === VALID_PROOF_STATUS ? proof.departureDate : undefined;
  const meFailure = failureCode(me.error);

  // Cached when the traveller arrived from the lodging's own page, and read here otherwise.
  const lodging = useQuery({
    queryKey: queryKeys.lodging(lodgingId ?? ''),
    queryFn: () => {
      if (lodgingId === undefined) return Promise.reject(new Error(NO_LODGING_ID));
      return apiClient.getLodging(lodgingId);
    },
    enabled: lodgingId !== undefined,
  });

  const lodgingCode = failureCode(lodging.error);
  const lodgingName = lodging.data?.name;
  const lodgingRefusedProof = lodgingCode === 'no_valid_proof';
  const lodgingMissing = lodgingCode === 'lodging_not_found';
  const lodgingFailure =
    lodgingCode === null || lodgingRefusedProof || lodgingMissing
      ? null
      : userMessageFor(lodgingCode);

  const activeClaim = me.data?.activeLodgingClaim ?? null;
  const claimAtThisLodging =
    activeClaim !== null && activeClaim.lodgingId === lodgingId ? activeClaim : null;
  const claimElsewhere =
    activeClaim !== null && activeClaim.lodgingId !== lodgingId ? activeClaim : null;

  /**
   * The claim the status view shows: the one this screen just created, or the one the own-account
   * read holds for this lodging while this screen has not dismissed it.
   */
  const statusClaimId = claimId ?? (claimDismissed ? null : (claimAtThisLodging?.id ?? null));

  const claim = useQuery({
    queryKey: queryKeys.lodgingClaim(statusClaimId ?? ''),
    queryFn: () => {
      if (statusClaimId === null) return Promise.reject(new Error(NO_CLAIM_ID));
      return apiClient.getLodgingClaim(statusClaimId);
    },
    enabled: statusClaimId !== null,
    // The function form: React Query reads the interval from the status its own answer holds, so a
    // claim that has reached a terminal status stops the polling without the screen doing anything.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && POLLED_CLAIM_STATUSES.includes(status) ? CLAIM_POLL_MS : false;
    },
  });

  const claimCode = failureCode(claim.error);
  // The own-account read already carries the status of the claim it lists, so a traveller arriving on
  // a claim started earlier sees its state before the first poll answers.
  const claimStatus: LodgingClaimStatus | undefined =
    claim.data?.status ??
    (claimAtThisLodging !== null && claimAtThisLodging.id === statusClaimId
      ? claimAtThisLodging.status
      : undefined);
  const claimFailure =
    claimCode === null || claimCode === 'claim_not_found' ? null : userMessageFor(claimCode);

  /**
   * Whether the claim this screen would show has been reported missing by the poll. `404` is the
   * answer for a claim withdrawn elsewhere or erased with an account, and it is read off the failed
   * read rather than stored: there is no state to keep in step with it.
   */
  const claimGone = claimCode === 'claim_not_found' && statusClaimId !== null;

  /** The claim the status view shows; a claim the last read reported missing is not shown. */
  const shownClaimId = claimGone ? null : statusClaimId;

  // The proof's own stay is the claim's default: both dates lie inside the proof by construction, so
  // the form opens acceptable.
  const stayFrom = stayFromEdit ?? proofFrom ?? '';
  const stayTo = stayToEdit ?? proofTo ?? '';

  const dateErrors = validateStayDates(stayFrom, stayTo, proofFrom, proofTo);
  const datesValid = dateErrors.from === null && dateErrors.to === null;

  /** Whether the notice can be rendered in full, which is what enables the consent (AAP 0.12.2). */
  const noticeReady = lodgingName !== undefined && bookingName.trim() !== '' && datesValid;

  /** The notice, rebuilt on every keystroke, or null while the lodging's name is still unknown. */
  const noticeText =
    lodgingName === undefined
      ? null
      : lodgingCallNotice({ lodging: lodgingName, bookingName, stayFrom, stayTo });

  /** The notice as the traveller sees it. Empty only where no notice is shown at all. */
  const noticeShown = noticeText ?? '';

  // Consent is the sentence the traveller agreed to rather than a flag beside it, so it binds to the
  // notice exactly: any change to what the notice says — a keystroke in the booking name, a date, the
  // lodging's name — stops the consent holding, and no effect has to clear it afterwards.
  const consent = consentedNotice !== null && consentedNotice === noticeText;

  // --- Effects ------------------------------------------------------------------------------------

  // The lodging read failed in a way the form's banner explains; this is its spoken half.
  useEffect(() => {
    if (lodgingFailure !== null) announce(lodgingFailure);
  }, [lodgingFailure]);

  // A claim moves while the screen is open — the call is dispatched, then it ends — so each new
  // status is spoken as well as shown (AAP 0.5.8). The ref keeps one status from being spoken twice.
  useEffect(() => {
    if (claimStatus === undefined || announcedStatus.current === claimStatus) return;
    announcedStatus.current = claimStatus;
    announce(CLAIM_STATUS_TEXT[claimStatus]);
  }, [claimStatus]);

  // A terminal status moves the verified guest count, which the own profile and the lodging's page
  // both show. Each terminal status acts once, so a poll cannot repeat the refresh.
  useEffect(() => {
    if (claimStatus === undefined || !TERMINAL_CLAIM_STATUSES.includes(claimStatus)) return;
    if (refreshedForStatus.current === claimStatus) return;
    refreshedForStatus.current = claimStatus;
    void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    if (lodgingId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.lodging(lodgingId) });
    }
  }, [claimStatus, lodgingId]);

  // A claim the poll reported missing is gone — its status view has already yielded to the form — so
  // the own-account read is asked again to stop listing it, and the fact is spoken once.
  useEffect(() => {
    if (!claimGone) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    announce(CLAIM_GONE);
  }, [claimGone]);

  // --- Actions ------------------------------------------------------------------------------------

  /**
   * Submits the claim.
   *
   * A plain async handler on purpose: a React Query mutation keeps its `variables` in the mutation
   * cache for as long as the cache lives, and one of those variables is the booking name. The `201`
   * clears both personal fields, so they live here only until the server has them (AAP 0.5.2,
   * AAP 0.11.1). A refusal keeps the form's values so they can be corrected, and shows the client's
   * own sentence for the code, never the server's text.
   */
  async function submitClaim(): Promise<void> {
    if (lodgingId === undefined || !noticeReady || !consent || submitting) return;
    const reference = bookingReference.trim();

    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await apiClient.createLodgingClaim({
        lodgingId,
        stayFrom,
        stayTo,
        bookingName: bookingName.trim(),
        ...(reference === '' ? {} : { bookingReference: reference }),
        callConsent: true,
      });

      setClaimId(created.claimId);
      setClaimDismissed(false);
      setBookingName('');
      setBookingReference('');
      setConsentedNotice(null);
      // The status view reads this query, so the answer the route just gave is seeded before the
      // first poll: the screen shows `pending_call` at once (AAP 0.5.3). A new claim is unresolved,
      // so the seed is the exact shape of that response — no `resolvedAt` key (AAP 0.5.4).
      queryClient.setQueryData(queryKeys.lodgingClaim(created.claimId), {
        status: created.status,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      announce(CLAIM_SUBMITTED);
    } catch (error) {
      const code = isApiError(error) ? error.code : 'invalid_response';
      if (code === 'no_valid_proof') {
        // The proof the screen opened with is not valid after all: the import banner takes over.
        setProofRefused(true);
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      } else {
        const message = userMessageFor(code);
        setSubmitError(message);
        announce(message);
        if (code === 'active_claim_exists') {
          // The one-active-claim rule (AAP 0.5.7): the own-account read decides whether the screen
          // moves to the status view or to the claim standing at another lodging.
          void queryClient.invalidateQueries({ queryKey: queryKeys.me });
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Withdraws the claim, which deletes it with its booking details (AAP 0.5.4). A claim that is
   * already gone counts as withdrawn, and the one refusal with a next step of its own is a live call,
   * whose claim stands until the call ends.
   */
  async function withdrawClaim(): Promise<void> {
    if (statusClaimId === null || withdrawing) return;
    const id = statusClaimId;

    setWithdrawing(true);
    setWithdrawError(null);
    try {
      await apiClient.deleteLodgingClaim(id);
      finishWithdrawal(id);
    } catch (error) {
      const code = isApiError(error) ? error.code : 'invalid_response';
      if (code === 'claim_not_found') {
        finishWithdrawal(id);
        return;
      }
      const message = code === 'call_in_progress' ? WITHDRAW_IN_PROGRESS : userMessageFor(code);
      setWithdrawError(message);
      announce(message);
    } finally {
      setWithdrawing(false);
    }
  }

  /** Forgets the claim in every read that still shows it, and returns to the form. */
  function finishWithdrawal(id: string): void {
    queryClient.removeQueries({ queryKey: queryKeys.lodgingClaim(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    if (lodgingId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.lodging(lodgingId) });
    }
    setClaimId(null);
    setClaimDismissed(true);
    setConfirmingWithdrawal(false);
    announce(CLAIM_WITHDRAWN);
  }

  /**
   * Returns to the form for a claim that was rejected or that could not be reached. Neither status is
   * an active claim, so the own-account read answers with none once it refreshes (AAP 0.5.7); this
   * screen's record of the dismissed claim is what keeps the status view away until it does.
   */
  function startNewClaim(): void {
    setClaimId(null);
    setClaimDismissed(true);
    setConfirmingWithdrawal(false);
    setWithdrawError(null);
  }

  // --- Render -------------------------------------------------------------------------------------

  // The header names the route and is the page's only level-one heading, so the screen itself
  // carries none; the name of the lodging it was opened for is rendered in the body at level 2, and
  // is absent until that read answers. `children` is omitted from the type because the content is
  // passed as the element's child.
  const screenProps: Omit<ScreenProps, 'children'> = { edges: SCREEN_EDGES };

  const goneBanner = claimGone ? (
    <Banner tone="info" message={CLAIM_GONE} testID="claim-gone" />
  ) : null;

  let content: ReactNode;

  if (lodgingId === undefined || lodgingMissing) {
    content = (
      <Banner
        tone="error"
        message={LODGING_UNAVAILABLE}
        action={{ label: LODGINGS_LABEL, onPress: () => router.replace('/lodgings') }}
        testID="lodging-unavailable"
      />
    );
  } else if (meFailure !== null) {
    content = (
      <Banner
        tone="error"
        message={userMessageFor(meFailure)}
        action={{
          label: TRY_AGAIN,
          onPress: () => {
            void me.refetch();
          },
        }}
      />
    );
  } else if (me.isPending) {
    content = <Text style={styles.note}>{LOADING_TEXT}</Text>;
  } else if (proofRefused || lodgingRefusedProof || !proofValid) {
    content = (
      <Banner
        tone="info"
        message={IMPORT_BANNER}
        action={{ label: VERIFY_MY_STAY, onPress: () => router.push('/proof/import') }}
        testID="proof-banner"
      />
    );
  } else if (shownClaimId !== null) {
    const withdrawable =
      claimStatus !== undefined && WITHDRAWABLE_CLAIM_STATUSES.includes(claimStatus);

    content = (
      <>
        {/* The live region is what speaks a status that moves on its own on Android and on the web;
            iOS is covered by the `announce` in the effect above. */}
        <View {...STATUS_LIVE_REGION} style={styles.statusBlock}>
          <Text style={styles.status} testID="claim-status">
            {claimStatus === undefined ? LOADING_TEXT : CLAIM_STATUS_TEXT[claimStatus]}
          </Text>
        </View>
        {claimFailure === null ? null : (
          <Banner
            tone="error"
            message={claimFailure}
            action={{
              label: TRY_AGAIN,
              onPress: () => {
                void claim.refetch();
              },
            }}
          />
        )}
        {claimStatus === 'verified' ? (
          <Button
            variant="secondary"
            label={SHOW_STAY_LABEL}
            onPress={() => router.push('/profile/stay')}
            testID="claim-stay-visibility"
          />
        ) : null}
        {claimStatus === 'rejected' || claimStatus === 'unreachable' ? (
          <Button
            variant="secondary"
            label={NEW_CLAIM_LABEL}
            onPress={startNewClaim}
            testID="claim-restart"
          />
        ) : null}
        {withdrawError === null ? null : (
          <Banner tone="error" message={withdrawError} testID="claim-withdraw-error" />
        )}
        {/* React Native Web has no usable `Alert`, so the confirmation is inline: the first press
            offers the sentence and the two answers. */}
        {!withdrawable ? null : confirmingWithdrawal ? (
          <Card testID="claim-withdraw-confirm">
            <Text style={styles.body}>{WITHDRAW_CONFIRM_TEXT}</Text>
            <View style={styles.actions}>
              <Button
                variant="danger"
                label={WITHDRAW_CONFIRM_LABEL}
                busy={withdrawing}
                onPress={() => {
                  void withdrawClaim();
                }}
                testID="claim-withdraw-submit"
              />
              <Button
                variant="secondary"
                label={KEEP_CLAIM_LABEL}
                disabled={withdrawing}
                onPress={() => setConfirmingWithdrawal(false)}
                testID="claim-withdraw-cancel"
              />
            </View>
          </Card>
        ) : (
          <Button
            variant="danger"
            label={WITHDRAW_LABEL}
            onPress={() => setConfirmingWithdrawal(true)}
            testID="claim-withdraw"
          />
        )}
      </>
    );
  } else if (claimElsewhere !== null) {
    content = (
      <>
        {goneBanner}
        <Banner
          tone="info"
          message={`You already have a stay claim at ${claimElsewhere.lodgingName}.`}
          action={{ label: MY_STAY_LABEL, onPress: () => router.push('/profile/stay') }}
          testID="other-claim-banner"
        />
      </>
    );
  } else {
    // The form. The booking name and the two dates are the whole of what the call discloses, which is
    // exactly what the notice below spells out before the consent can be given (AAP 0.12.2).
    content = (
      <>
        {goneBanner}
        {lodgingFailure === null ? null : (
          <Banner
            tone="error"
            message={lodgingFailure}
            action={{
              label: TRY_AGAIN,
              onPress: () => {
                void lodging.refetch();
              },
            }}
          />
        )}
        <TextField
          label={ARRIVAL_LABEL}
          value={stayFrom}
          onChangeText={setStayFromEdit}
          error={dateErrors.from}
          maxLength={DATE_LENGTH}
          autoComplete="off"
          keyboardType="numbers-and-punctuation"
        />
        <TextField
          label={DEPARTURE_LABEL}
          value={stayTo}
          onChangeText={setStayToEdit}
          error={dateErrors.to}
          maxLength={DATE_LENGTH}
          autoComplete="off"
          keyboardType="numbers-and-punctuation"
        />
        <TextField
          label={BOOKING_NAME_LABEL}
          value={bookingName}
          onChangeText={setBookingName}
          maxLength={BOOKING_NAME_MAX_CHARS}
          autoCapitalize="words"
          autoCorrect={false}
          testID="claim-booking-name"
        />
        <TextField
          label={BOOKING_REFERENCE_LABEL}
          value={bookingReference}
          onChangeText={setBookingReference}
          maxLength={BOOKING_REFERENCE_MAX_CHARS}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        {/* The notice is a Card rather than a live region, so a screen reader is not interrupted on
            every keystroke, and it is rendered before the consent control: the disclosure comes
            first, which is the requirement (AAP 0.12.2). */}
        {noticeReady && noticeText !== null ? (
          <Card testID="claim-notice">
            <Text style={styles.body}>{noticeText}</Text>
          </Card>
        ) : (
          <Text style={styles.note}>{NOTICE_PENDING_HINT}</Text>
        )}
        <View style={styles.consentRow}>
          <Text style={styles.consentLabel}>{LODGING_CALL_CONSENT_LABEL}</Text>
          <Switch
            accessibilityLabel={LODGING_CALL_CONSENT_LABEL}
            // No `accessibilityRole` here on purpose. react-native-web already renders the control as
            // an `input[type=checkbox][role=switch]`, and a role passed to the `Switch` lands on the
            // wrapper view, where react-native-web makes every switch, checkbox and button role
            // focusable: the control then took two Tab stops, the first of them inert. iOS and
            // Android carry the switch role on the native control itself.
            accessibilityState={{ checked: consent, disabled: !noticeReady }}
            disabled={!noticeReady}
            onValueChange={(next: boolean) => setConsentedNotice(next ? noticeShown : null)}
            testID="claim-consent"
            value={consent}
          />
        </View>
        {submitError === null ? null : (
          <Banner tone="error" message={submitError} testID="claim-error" />
        )}
        <Button
          label={SUBMIT_LABEL}
          disabled={!noticeReady || !consent || submitting}
          busy={submitting}
          onPress={() => {
            void submitClaim();
          }}
          testID="claim-submit"
        />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen {...screenProps}>
        {lodgingName === undefined ? null : (
          <Text {...LODGING_NAME_HEADING} style={styles.lodgingName}>
            {lodgingName}
          </Text>
        )}
        {content}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  note: { ...typography.body, color: colors.textMuted },
  body: { ...typography.body, color: colors.text },
  statusBlock: { gap: spacing.xs },
  status: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  // The lodging's name keeps the type the Screen's own heading painted it in.
  lodgingName: { ...typography.heading, color: colors.text, fontWeight: fontWeights.bold },
  consentRow: {
    // The row is the labelled switch's full touch target, with the switch at its reading end.
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  consentLabel: { ...typography.body, color: colors.text, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
});
