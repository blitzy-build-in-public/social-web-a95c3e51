/** I'm staying here — the lodging stay claim (AAP 0.5.8, AAP 0.12.2, criterion 14). */
import { useQuery } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ReactElement } from 'react';
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
import type { BannerTone, ScreenProps } from '../../src/ui';

const SCREEN_TITLE = "I'm staying here";
type LodgingNameHeading = TextProps & Readonly<{ 'aria-level': number }>;
/** The lodging's name in the body: the header owns level 1, so the name sits at level 2. */
const LODGING_NAME_HEADING: LodgingNameHeading = { role: 'heading', 'aria-level': 2 };
type ClaimStatusList = readonly LodgingClaimStatus[];
const VALID_PROOF_STATUS = 'valid' satisfies ProofStatus;
const CLAIM_POLL_MS = 10_000;
const DATE_LENGTH = 10;
const POLLED_CLAIM_STATUSES: ClaimStatusList = ['pending_call', 'calling'];
const TERMINAL_CLAIM_STATUSES: ClaimStatusList = ['verified', 'rejected', 'unreachable'];
const WITHDRAWABLE_CLAIM_STATUSES: ClaimStatusList = ['pending_call', 'calling', 'verified'];
const CLAIM_STATUS_TEXT = {
  pending_call: 'Waiting for the call',
  calling: 'Calling the lodging now',
  verified: 'Verified',
  rejected: 'Not confirmed',
  unreachable: "Couldn't reach the lodging",
} as const satisfies Record<LodgingClaimStatus, string>;
const LOADING_TEXT = 'Loading…';
const LODGING_UNAVAILABLE = "This lodging isn't available.";
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
const NOTICE_PENDING_HINT =
  'Enter the name on your booking and valid dates to see exactly what the lodging will be told.';
const DATE_FORMAT_ERROR = 'Use the format YYYY-MM-DD.';
const DATE_ORDER_ERROR = "The arrival date can't be after the departure date.";
const NO_LODGING_ID = 'The lodging query was enabled without an id.';
const NO_CLAIM_ID = 'The claim query was enabled without an id.';
const SCREEN_EDGES = ['left', 'right'] as const;
const STATUS_LIVE_REGION = { 'aria-live': 'polite' } as const;
type StayDateErrors = Readonly<{ from: string | null; to: string | null }>;
type StayRange = Readonly<{ from: string; to: string }>;
const NO_DATE_ERRORS: StayDateErrors = { from: null, to: null };
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ME_KEY = { queryKey: queryKeys.me };
const DATE_INPUT = { autoComplete: 'off', keyboardType: 'numbers-and-punctuation' } as const;
const DATE_FIELD = { maxLength: DATE_LENGTH, ...DATE_INPUT };
const NAME_LIMIT = { maxLength: BOOKING_NAME_MAX_CHARS };
const NAME_BOX = { ...NAME_LIMIT, autoCapitalize: 'words' as const, autoCorrect: false };
const REF_LIMIT = { maxLength: BOOKING_REFERENCE_MAX_CHARS };
const REF_BOX = { ...REF_LIMIT, autoCapitalize: 'characters' as const, autoCorrect: false };
const GO_LODGINGS = { label: 'Lodgings', onPress: (): void => router.replace('/lodgings') };
const VERIFY_STAY = { label: 'Verify my stay', onPress: (): void => router.push('/proof/import') };
const openStay = (): void => router.push('/profile/stay');
const MY_STAY = { label: 'My stay', onPress: openStay };
const OTHER_CLAIM = { tone: 'info', action: MY_STAY, testID: 'other-claim-banner' } as const;
const UNAVAILABLE_BANNER = { tone: 'error', action: GO_LODGINGS } as const;
const PROOF_BANNER = { tone: 'info', action: VERIFY_STAY, testID: 'proof-banner' } as const;
const SHOW_STAY = { variant: 'secondary', testID: 'claim-stay-visibility' } as const;
const RESTART = { variant: 'secondary', testID: 'claim-restart' } as const;
const WITHDRAW_ERROR = { tone: 'error', testID: 'claim-withdraw-error' } as const;
const WITHDRAW_SUBMIT = { variant: 'danger', testID: 'claim-withdraw-submit' } as const;
const WITHDRAW_KEEP = { variant: 'secondary', testID: 'claim-withdraw-cancel' } as const;
const WITHDRAW_CLAIM = { variant: 'danger', testID: 'claim-withdraw' } as const;
const ROW_BOX = { alignItems: 'center', flexDirection: 'row', gap: spacing.md } as const;
const SUBMIT_CLAIM = { label: 'Request verification call', testID: 'claim-submit' } as const;
function failureCode(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return isApiError(error) ? error.code : 'invalid_response';
}
function isCalendarDate(value: string): boolean {
  const [, year, month, day] = CALENDAR_DATE_PATTERN.exec(value) ?? [];
  if (year === undefined || month === undefined || day === undefined) return false;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return false;
  const monthIndex = monthNumber - 1;
  const parsed = new Date(Date.UTC(Number(year), monthIndex, dayNumber));
  const sameMonth = parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() === monthIndex;
  return sameMonth && parsed.getUTCDate() === dayNumber;
}
const lodgingQuery = (id: string) => ({ queryKey: queryKeys.lodging(id) });
function validateStayDates(from: string, to: string, proof: StayRange | undefined): StayDateErrors {
  const fromIsDate = isCalendarDate(from);
  const toIsDate = isCalendarDate(to);
  if (!fromIsDate || !toIsDate) {
    return { from: fromIsDate ? null : DATE_FORMAT_ERROR, to: toIsDate ? null : DATE_FORMAT_ERROR };
  }
  if (proof !== undefined) {
    const rangeError = `Dates must fall within your verified stay (${proof.from} to ${proof.to}).`;
    const fromOutside = from < proof.from || from > proof.to;
    const toOutside = to < proof.from || to > proof.to;
    if (fromOutside || toOutside) {
      return { from: fromOutside ? rangeError : null, to: toOutside ? rangeError : null };
    }
  }
  return from > to ? { from: DATE_ORDER_ERROR, to: null } : NO_DATE_ERRORS;
}
type FailureBannerProps = Readonly<{ tone: BannerTone; message: string; onPress: () => void }>;
function FailureBanner({ tone, message, onPress }: FailureBannerProps): ReactElement {
  return <Banner tone={tone} message={message} action={{ label: 'Try again', onPress }} />;
}
export default function LodgingClaimScreen(): ReactElement {
  const requested = useLocalSearchParams().lodgingId;
  const lodgingId = typeof requested === 'string' && requested !== '' ? requested : undefined;
  const me = useMe();
  const [stayFromEdit, setStayFromEdit] = useState<string | null>(null);
  const [stayToEdit, setStayToEdit] = useState<string | null>(null);
  const [bookingName, setBookingName] = useState('');
  const [bookingReference, setBookingReference] = useState('');
  // Consent is the notice sentence itself, so any change to what the notice says withdraws it.
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
  const proof = me.data?.proof;
  const proofValid = proof?.status === VALID_PROOF_STATUS;
  const proofFrom = proofValid ? proof?.arrivalDate : undefined;
  const proofTo = proofValid ? proof?.departureDate : undefined;
  const proofRange =
    proofFrom === undefined || proofTo === undefined ? undefined : { from: proofFrom, to: proofTo };
  const meFailure = failureCode(me.error);
  const meMessage = meFailure === null ? '' : userMessageFor(meFailure);
  const lodging = useQuery({
    ...lodgingQuery(lodgingId ?? ''),
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
  const lodgingHandled = lodgingCode === null || lodgingRefusedProof || lodgingMissing;
  const lodgingFailure = lodgingHandled ? null : userMessageFor(lodgingCode);
  const activeClaim = me.data?.activeLodgingClaim ?? null;
  const claimAtThisLodging = activeClaim?.lodgingId === lodgingId ? activeClaim : null;
  const claimElsewhere = activeClaim?.lodgingId !== lodgingId ? activeClaim : null;
  const statusClaimId = claimId ?? (claimDismissed ? null : (claimAtThisLodging?.id ?? null));
  const claim = useQuery({
    queryKey: queryKeys.lodgingClaim(statusClaimId ?? ''),
    queryFn: () => {
      if (statusClaimId === null) return Promise.reject(new Error(NO_CLAIM_ID));
      return apiClient.getLodgingClaim(statusClaimId);
    },
    enabled: statusClaimId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && POLLED_CLAIM_STATUSES.includes(status) ? CLAIM_POLL_MS : false;
    },
  });
  const claimCode = failureCode(claim.error);
  const claimStatus =
    claim.data?.status ??
    (claimAtThisLodging?.id === statusClaimId ? claimAtThisLodging.status : undefined);
  const claimFailure =
    claimCode === null || claimCode === 'claim_not_found' ? null : userMessageFor(claimCode);
  const statusText = claimStatus === undefined ? LOADING_TEXT : CLAIM_STATUS_TEXT[claimStatus];
  const claimGone = claimCode === 'claim_not_found' && statusClaimId !== null;
  const shownClaimId = claimGone ? null : statusClaimId;
  const stayFrom = stayFromEdit ?? proofFrom ?? '';
  const stayTo = stayToEdit ?? proofTo ?? '';
  const dateErrors = validateStayDates(stayFrom, stayTo, proofRange);
  const datesValid = dateErrors.from === null && dateErrors.to === null;
  const noticeReady = lodgingName !== undefined && bookingName.trim() !== '' && datesValid;
  const noticeText =
    lodgingName === undefined
      ? null
      : lodgingCallNotice({ lodging: lodgingName, bookingName, stayFrom, stayTo });
  const consent = consentedNotice !== null && consentedNotice === noticeText;
  const blocked = !noticeReady || !consent || submitting;
  const retryMe = (): void => void me.refetch();
  const retryClaim = (): void => void claim.refetch();
  const sendClaim = (): void => void submitClaim();
  const withdrawNow = (): void => void withdrawClaim();
  const startConfirm = (): void => setConfirmingWithdrawal(true);
  const stopConfirm = (): void => setConfirmingWithdrawal(false);
  const withdrawActions = [
    { ...WITHDRAW_SUBMIT, label: WITHDRAW_CONFIRM_LABEL, busy: withdrawing, onPress: withdrawNow },
    { ...WITHDRAW_KEEP, label: KEEP_CLAIM_LABEL, disabled: withdrawing, onPress: stopConfirm },
  ];
  useEffect(() => {
    if (lodgingFailure !== null) announce(lodgingFailure);
  }, [lodgingFailure]);
  useEffect(() => {
    if (claimStatus === undefined || announcedStatus.current === claimStatus) return;
    announcedStatus.current = claimStatus;
    announce(CLAIM_STATUS_TEXT[claimStatus]);
  }, [claimStatus]);
  useEffect(() => {
    if (claimStatus === undefined || !TERMINAL_CLAIM_STATUSES.includes(claimStatus)) return;
    if (refreshedForStatus.current === claimStatus) return;
    refreshedForStatus.current = claimStatus;
    void queryClient.invalidateQueries(ME_KEY);
    if (lodgingId !== undefined) void queryClient.invalidateQueries(lodgingQuery(lodgingId));
  }, [claimStatus, lodgingId]);
  useEffect(() => {
    if (!claimGone) return;
    void queryClient.invalidateQueries(ME_KEY);
    announce(CLAIM_GONE);
  }, [claimGone]);
  async function submitClaim(): Promise<void> {
    if (lodgingId === undefined || blocked) return;
    const reference = bookingReference.trim();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { claimId: createdId, status } = await apiClient.createLodgingClaim({
        lodgingId,
        stayFrom,
        stayTo,
        bookingName: bookingName.trim(),
        ...(reference === '' ? {} : { bookingReference: reference }),
        callConsent: true,
      });
      setClaimId(createdId);
      setClaimDismissed(false);
      setBookingName('');
      setBookingReference('');
      setConsentedNotice(null);
      queryClient.setQueryData(queryKeys.lodgingClaim(createdId), { status });
      void queryClient.invalidateQueries(ME_KEY);
      announce(CLAIM_SUBMITTED);
    } catch (error) {
      const code = failureCode(error) ?? 'invalid_response';
      if (code === 'no_valid_proof') {
        setProofRefused(true);
        void queryClient.invalidateQueries(ME_KEY);
      } else {
        const message = userMessageFor(code);
        setSubmitError(message);
        announce(message);
        if (code === 'active_claim_exists') void queryClient.invalidateQueries(ME_KEY);
      }
    } finally {
      setSubmitting(false);
    }
  }
  async function withdrawClaim(): Promise<void> {
    if (statusClaimId === null || withdrawing) return;
    const id = statusClaimId;
    setWithdrawing(true);
    setWithdrawError(null);
    const failure = await apiClient.deleteLodgingClaim(id).catch((error: unknown) => error);
    setWithdrawing(false);
    if (failure === undefined) return finishWithdrawal(id);
    const code = failureCode(failure) ?? 'invalid_response';
    if (code === 'claim_not_found') return finishWithdrawal(id);
    const message = code === 'call_in_progress' ? WITHDRAW_IN_PROGRESS : userMessageFor(code);
    setWithdrawError(message);
    announce(message);
  }
  function finishWithdrawal(id: string): void {
    queryClient.removeQueries({ queryKey: queryKeys.lodgingClaim(id) });
    void queryClient.invalidateQueries(ME_KEY);
    if (lodgingId !== undefined) void queryClient.invalidateQueries(lodgingQuery(lodgingId));
    dismissClaim();
    announce(CLAIM_WITHDRAWN);
  }
  function dismissClaim(): void {
    setClaimId(null);
    setClaimDismissed(true);
    setConfirmingWithdrawal(false);
  }
  function startNewClaim(): void {
    dismissClaim();
    setWithdrawError(null);
  }
  const arrivalState = { value: stayFrom, onChangeText: setStayFromEdit, error: dateErrors.from };
  const departureState = { value: stayTo, onChangeText: setStayToEdit, error: dateErrors.to };
  const arrival = { ...DATE_FIELD, ...arrivalState, label: 'Arrival date (YYYY-MM-DD)' };
  const departure = { ...DATE_FIELD, ...departureState, label: 'Departure date (YYYY-MM-DD)' };
  const bookingState = { value: bookingName, onChangeText: setBookingName };
  const referenceState = { value: bookingReference, onChangeText: setBookingReference };
  const booking = { ...NAME_BOX, ...bookingState, label: 'Name on the booking' };
  const bookingField = { ...booking, testID: 'claim-booking-name' };
  const reference = { ...REF_BOX, ...referenceState, label: 'Booking reference (optional)' };
  const elsewhereText = `You already have a stay claim at ${claimElsewhere?.lodgingName}.`;
  const screenProps: Omit<ScreenProps, 'children'> = { edges: SCREEN_EDGES };
  const goneBanner = claimGone && <Banner tone="info" message={CLAIM_GONE} testID="claim-gone" />;
  const content =
    lodgingId === undefined || lodgingMissing ? (
      <Banner {...UNAVAILABLE_BANNER} message={LODGING_UNAVAILABLE} testID="lodging-unavailable" />
    ) : meFailure !== null ? (
      <FailureBanner tone="error" message={meMessage} onPress={retryMe} />
    ) : me.isPending ? (
      <Text style={styles.note}>{LOADING_TEXT}</Text>
    ) : proofRefused || lodgingRefusedProof || !proofValid ? (
      <Banner {...PROOF_BANNER} message={IMPORT_BANNER} />
    ) : shownClaimId !== null ? (
      <>
        <View {...STATUS_LIVE_REGION} style={styles.statusBlock}>
          <Text style={styles.status} testID="claim-status" children={statusText} />
        </View>
        {claimFailure !== null && (
          <FailureBanner tone="error" message={claimFailure} onPress={retryClaim} />
        )}
        {claimStatus === 'verified' && (
          <Button {...SHOW_STAY} label={SHOW_STAY_LABEL} onPress={openStay} />
        )}
        {(claimStatus === 'rejected' || claimStatus === 'unreachable') && (
          <Button {...RESTART} label={NEW_CLAIM_LABEL} onPress={startNewClaim} />
        )}
        {withdrawError !== null && <Banner {...WITHDRAW_ERROR} message={withdrawError} />}
        {claimStatus !== undefined &&
          WITHDRAWABLE_CLAIM_STATUSES.includes(claimStatus) &&
          (confirmingWithdrawal ? (
            <Card testID="claim-withdraw-confirm">
              <Text style={styles.body}>{WITHDRAW_CONFIRM_TEXT}</Text>
              <View style={styles.actions}>
                {withdrawActions.map((action) => (
                  <Button key={action.label} {...action} />
                ))}
              </View>
            </Card>
          ) : (
            <Button {...WITHDRAW_CLAIM} label={WITHDRAW_LABEL} onPress={startConfirm} />
          ))}
      </>
    ) : claimElsewhere !== null ? (
      <>
        {goneBanner}
        <Banner {...OTHER_CLAIM} message={elsewhereText} />
      </>
    ) : (
      <>
        {goneBanner}
        {lodgingFailure !== null && (
          <FailureBanner
            tone="error"
            message={lodgingFailure}
            onPress={() => void lodging.refetch()}
          />
        )}
        <TextField {...arrival} />
        <TextField {...departure} />
        <TextField {...bookingField} />
        <TextField {...reference} />
        {noticeReady && noticeText !== null ? (
          <Card testID="claim-notice" children={<Text style={styles.body}>{noticeText}</Text>} />
        ) : (
          <Text style={styles.note}>{NOTICE_PENDING_HINT}</Text>
        )}
        <View style={styles.consentRow}>
          <Text style={styles.consentLabel}>{LODGING_CALL_CONSENT_LABEL}</Text>
          <Switch
            accessibilityLabel={LODGING_CALL_CONSENT_LABEL}
            accessibilityState={{ checked: consent, disabled: !noticeReady }}
            disabled={!noticeReady}
            onValueChange={(next: boolean) => setConsentedNotice(next ? (noticeText ?? '') : null)}
            testID="claim-consent"
            value={consent}
          />
        </View>
        {submitError !== null && <Banner tone="error" message={submitError} testID="claim-error" />}
        <Button {...SUBMIT_CLAIM} disabled={blocked} busy={submitting} onPress={sendClaim} />
      </>
    );
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
  lodgingName: { ...typography.heading, color: colors.text, fontWeight: fontWeights.bold },
  consentRow: { ...ROW_BOX, minHeight: MIN_TOUCH_TARGET, justifyContent: 'space-between' },
  consentLabel: { ...typography.body, color: colors.text, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
});
