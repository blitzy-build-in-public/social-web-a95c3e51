/**
 * My stay — the guest-list visibility switch (`/profile/stay`, AAP 0.5.8, AAP 0.8.1, criterion 15).
 *
 * One screen, three states, each read from `GET /me`'s `activeLodgingClaim` and none of them inferred
 * on the client: no claim yet, a claim waiting for its verification call, and a verified claim. Only
 * the last carries the switch, and the switch exists for one rule — staying visibility is off by
 * default, and the safety warning is what a traveler reads before turning it on (AAP 0.5.7, 0.7.3
 * #14). The warning is therefore rendered before the switch in source order in every case, and the
 * switch stays disabled until the city the warning names has resolved, so the control cannot be
 * reached without the sentence that justifies it (AAP 0.12.2).
 *
 * The city comes from the proof's city, which is where a claim's lodging has to be (AAP 0.5.7), and
 * from the lodging's own record only while the proof carries none; `403 no_valid_proof` from that
 * fallback read is an unresolved name rather than a screen error. Every other value is the API's own
 * answer, rendered as it arrived: this screen never decides who may appear on a guest list.
 *
 * The booking name and reference never reach this screen — they are not in `MeDto` and no route
 * returns them (AAP 0.5.2) — and nothing here logs: not the lodging, the stay dates or the claim id.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';
import type { SwitchProps } from 'react-native';
import { Stack, router } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MIN_TOUCH_TARGET, colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { MeDto } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { STAY_TOGGLE_LABEL, formatCalendarDate, guestListWarning } from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { Banner, Card, ListItem, Screen, announce } from '../../src/ui';

/** The caller's active claim, exactly as `GET /me` serializes it (AAP 0.5.4, AAP 0.5.7). */
type LodgingClaim = NonNullable<MeDto['activeLodgingClaim']>;

/**
 * The edges this screen insets by. The Stack's header already occupies the status-bar area, so
 * claiming `top` here would add its height twice — the convention the tab screens follow.
 */
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

/** The header's title, and the page's only heading: the Stack renders it, so `Screen` keeps none. */
const HEADER_TITLE = 'My stay';

/**
 * The text this screen owns. The warning, the switch's label and the calendar-date form come from
 * `src/copy/strings.ts`; the two claim-step sentences read as `app/lodgings/claim.tsx` reads them.
 */
const LOADING_TEXT = 'Loading…';
const RETRY_LABEL = 'Try again';
const NO_CLAIM_TEXT = "You haven't claimed a stay yet.";
const FIND_LODGING_LABEL = 'Find your lodging';
const VIEW_LODGING_LABEL = 'View lodging';
const PENDING_EXPLANATION =
  'You can choose whether to appear on the guest list once your stay is verified.';
const GUEST_LIST_NOTE =
  'Only verified travelers with a valid proof for this city can see it. Room numbers and dates are never shown.';
const CITY_PENDING_TEXT = 'Checking the city of your verified stay. The switch waits for it.';
const SHOWN_NOTICE = 'You now appear on the guest list';
const HIDDEN_NOTICE = "You're hidden from the guest list";

/** The Lodgings tab, where a traveler with no claim finds the lodging to claim (AAP 0.5.8). */
const LODGINGS_ROUTE = '/lodgings';

/** How a claim in flight reads (AAP 0.5.3). */
const CLAIM_STEP_TEXT = {
  pending_call: 'Waiting for the call',
  calling: 'Calling the lodging now',
} as const;

/**
 * The switch's two track colours: `border` when off and `primary` when on, with the thumb in
 * `onPrimary`. The palette holds no switch token, so each colour is one whose recorded pair covers
 * where it is painted (`border` on the page 3.7:1, `primary` on the page 7.3:1, `onPrimary` on
 * `primary` 7.3:1).
 */
const TRACK_COLOR = { false: colors.border, true: colors.primary } as const;

/**
 * The prefix of every lodging-directory query. `queryKeys.lodgings(cityId, sort)` is
 * `['lodgings', cityId, sort]`, and React Query matches a key by prefix, so invalidating this
 * shorter key refreshes the directory under every sort: the guest list and the verified guest count
 * both move when a traveler opts in or out (AAP 0.5.7).
 */
const LODGINGS_PREFIX = ['lodgings'] as const;

/** Raised only by a wiring mistake: the lodging fallback is never enabled without a claim. */
const NO_CLAIM = 'The lodging query was enabled without a claim.';

/** The code a failed request carried, or the client's own answer that no envelope arrived. */
function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'invalid_response';
}

/**
 * The sentence a screen shows for a failure: the copy this app fixes for the API's code. The
 * server's own `message` text is never shown (AAP 0.11.1).
 */
function messageFor(error: unknown): string {
  return userMessageFor(errorCodeOf(error));
}

/** A claim's stay as `<from> – <to>`, in the copy module's `12 March 2027` form. */
function stayDates(claim: LodgingClaim): string {
  return `${formatCalendarDate(claim.stayFrom)} – ${formatCalendarDate(claim.stayTo)}`;
}

/**
 * The switch's role and state, on the platforms that need them stated.
 *
 * A native `Switch` is a switch control to VoiceOver and TalkBack, and its role and state are given
 * explicitly there. On web `react-native-web` 0.19 forwards these two props to the wrapper element it
 * draws around the control, where they make a nameless, non-activatable `role="switch"` the first
 * keyboard stop of the screen, in front of the real control (WCAG 2.1.1, 2.4.3); the DOM input it
 * renders already carries `role="switch"`, the browser's own checked state and the visible label as
 * its accessible name, so on web they are withheld rather than duplicated.
 */
function switchRoleProps(checked: boolean, disabled: boolean): Partial<SwitchProps> {
  if (Platform.OS === 'web') return {};
  return { accessibilityRole: 'switch', accessibilityState: { checked, disabled } };
}

/**
 * My stay.
 *
 * @returns The active claim's state and, for a verified claim, the safety warning above the
 * guest-list switch that governs `showStaying` (AAP 0.5.7, AAP 0.5.8).
 */
export default function StayScreen(): ReactElement {
  const me = useMe();
  const claim: LodgingClaim | null = me.data?.activeLodgingClaim ?? null;
  const verified = claim !== null && claim.status === 'verified';
  const proofCityId = me.data?.proof.cityId;

  // Read for the city the warning names, and only while a claim is verified. A verified claim's
  // lodging lies in the proof's city, so `GET /cities` answers it; the lodging read is the fallback
  // for the one case where the proof carries no city, and it is enabled only then, so no request
  // fires that the screen does not need.
  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    enabled: verified,
  });

  const needsLodgingCity = verified && proofCityId === undefined;
  const lodging = useQuery({
    queryKey: queryKeys.lodging(claim?.lodgingId ?? ''),
    queryFn: () => {
      if (claim === null) return Promise.reject(new Error(NO_CLAIM));
      return apiClient.getLodging(claim.lodgingId);
    },
    enabled: needsLodgingCity,
  });

  const cityId = proofCityId ?? lodging.data?.cityId;
  // The warning names a city, so an unresolved one stays null while the list is still in flight and
  // the name may yet arrive. Only a settled list that cannot name the city falls back to its slug,
  // which keeps the sentence the traveler reads from changing under them.
  const cityName =
    cityId === undefined || cities.isPending
      ? null
      : (cities.data?.items.find((city) => city.id === cityId)?.name ?? cityId);

  // The switch's own value: null while it shows the API's last confirmed answer.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (showStaying: boolean) => apiClient.setLodgingVisibility({ showStaying }),
    onSuccess: (response) => {
      // The server's answer, not the value that was sent, is what the switch shows from here on.
      setOptimistic(response.showStaying);
      const message = response.showStaying ? SHOWN_NOTICE : HIDDEN_NOTICE;
      setNotice(message);
      announce(message);
      // The own-account read carries the claim's visibility, and the directory and the lodging's
      // detail both carry the guest list and its count (AAP 0.5.7).
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      void queryClient.invalidateQueries({ queryKey: LODGINGS_PREFIX });
      if (claim !== null) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.lodging(claim.lodgingId) });
      }
    },
    onError: () => {
      // The switch returns to the state the API last confirmed, which `claim.showStaying` is.
      setOptimistic(null);
      setNotice(null);
    },
  });

  const meMessage = me.error === null ? null : messageFor(me.error);
  const mutationMessage = mutation.error === null ? null : messageFor(mutation.error);
  const mutationCode = mutation.error === null ? null : errorCodeOf(mutation.error);

  // Each distinct failure is spoken once: a re-render over the same failed read repeats nothing, and
  // this is the announcement iOS has and Android's live region does not provide (AAP 0.5.8).
  useEffect(() => {
    if (meMessage !== null) announce(meMessage);
  }, [meMessage]);

  useEffect(() => {
    if (mutationMessage !== null) announce(mutationMessage);
  }, [mutationMessage]);

  useEffect(() => {
    // `409 no_verified_claim` is the route saying the claim is no longer active — its stay has
    // passed, or the verification call refused it — so the own-account read is refreshed and the
    // state below re-renders from what the API now holds.
    if (mutationCode === 'no_verified_claim') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    }
  }, [mutationCode]);

  /**
   * Moves the switch at once and sends the change. The value is optimistic: `onError` puts it back to
   * the state the API last confirmed, and `onSuccess` takes the server's own.
   */
  const changeVisibility = (next: boolean): void => {
    setOptimistic(next);
    setNotice(null);
    mutation.mutate(next);
  };

  const header = <Stack.Screen options={{ title: HEADER_TITLE }} />;

  if (me.isPending) {
    return (
      <>
        {header}
        <Screen edges={SCREEN_EDGES} testID="stay">
          <Text style={styles.muted}>{LOADING_TEXT}</Text>
        </Screen>
      </>
    );
  }

  if (meMessage !== null) {
    return (
      <>
        {header}
        <Screen edges={SCREEN_EDGES} testID="stay">
          <Banner
            tone="error"
            message={meMessage}
            action={{ label: RETRY_LABEL, onPress: () => void me.refetch(), testID: 'stay-retry' }}
            testID="stay-error"
          />
        </Screen>
      </>
    );
  }

  /** What every traveler without an active claim reads, with the way into the directory. */
  const noClaim = (
    <>
      <Text style={styles.body}>{NO_CLAIM_TEXT}</Text>
      <ListItem
        label={FIND_LODGING_LABEL}
        onPress={() => router.push(LODGINGS_ROUTE)}
        role="link"
        testID="stay-find-lodging"
      />
    </>
  );

  let body: ReactElement;
  if (claim === null) {
    body = noClaim;
  } else if (claim.status === 'pending_call' || claim.status === 'calling') {
    // No switch here: the API answers `409 no_verified_claim` to a `showStaying` for a stay it has
    // not verified, so the control would only offer a refusal (AAP 0.5.4, 0.5.7).
    body = (
      <Card title={claim.lodgingName} subtitle={stayDates(claim)} testID="stay-claim">
        <Text style={styles.body}>{CLAIM_STEP_TEXT[claim.status]}</Text>
        <Text style={styles.muted}>{PENDING_EXPLANATION}</Text>
        <ListItem
          label={VIEW_LODGING_LABEL}
          onPress={() => {
            router.push({ pathname: '/lodgings/[id]', params: { id: claim.lodgingId } });
          }}
          role="link"
          testID="stay-view-lodging"
        />
      </Card>
    );
  } else if (claim.status === 'verified') {
    const showStaying = optimistic ?? claim.showStaying;
    // The warning gates the switch two ways: the city it names has to have resolved, so the sentence
    // can name one, and no change may be in flight.
    const toggleDisabled = cityName === null || mutation.isPending;

    body = (
      <Card title={claim.lodgingName} subtitle={stayDates(claim)} testID="stay-claim">
        {/* Rendered before the switch in source order, so reading and focus order both meet the
            warning first (AAP 0.7.3 #14, AAP 0.12.2, criterion 15). */}
        <Banner
          tone="warning"
          message={cityName === null ? CITY_PENDING_TEXT : guestListWarning(cityName)}
          testID="stay-warning"
        />
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>{STAY_TOGGLE_LABEL}</Text>
          <Switch
            accessibilityLabel={STAY_TOGGLE_LABEL}
            disabled={toggleDisabled}
            ios_backgroundColor={colors.border}
            onValueChange={changeVisibility}
            testID="stay-toggle"
            thumbColor={colors.onPrimary}
            trackColor={TRACK_COLOR}
            value={showStaying}
            {...switchRoleProps(showStaying, toggleDisabled)}
          />
        </View>
        <Text style={styles.muted}>{GUEST_LIST_NOTE}</Text>
        {mutationMessage === null ? null : (
          <Banner tone="error" message={mutationMessage} testID="stay-mutation-error" />
        )}
        {notice === null ? null : <Banner tone="success" message={notice} testID="stay-notice" />}
      </Card>
    );
  } else {
    // `GET /me` includes only an active claim — `pending_call`, `calling`, or a `verified` one whose
    // stay has not ended (AAP 0.5.7) — so a refused or unreachable one cannot arrive here; the
    // no-claim state keeps this screen truthful if one ever does.
    body = noClaim;
  }

  return (
    <>
      {header}
      <Screen edges={SCREEN_EDGES} testID="stay">
        {body}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typography.body,
    color: colors.text,
  },
  muted: {
    ...typography.body,
    color: colors.textMuted,
  },
  /**
   * The label and the switch on one row. The row keeps the 44 pt target and the label shrinks rather
   * than pushing the control off it, so an enlarged system font wraps the label instead of clipping
   * it.
   */
  toggleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
  },
  toggleLabel: {
    color: colors.text,
    flexShrink: 1,
    fontSize: typography.label.fontSize,
    fontWeight: fontWeights.medium,
    lineHeight: typography.label.lineHeight,
  },
});
