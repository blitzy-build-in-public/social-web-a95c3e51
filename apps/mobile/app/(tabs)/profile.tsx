/**
 * The Profile tab (AAP 0.5.8): the caller's own pseudonymous identity, the proof that gates the
 * other tabs, the witnessed-presence counters and the doors out of the tab.
 *
 * Everything here is the API's own answer to `GET /me`, rendered as it arrived: the handle and the
 * generated avatar seed are the whole identity (AAP 0.7.1), the counters are the API's five numbers
 * and never a score, a star or a review (AAP 0.5.7, AAP 0.7.2), and the proof line is one sentence
 * per `ProofStatus`, taken from a record that covers every value so a status added later fails the
 * type check instead of rendering nothing. The city named in that sentence comes from the cached
 * `GET /cities`; the copy fixed for the whole app comes from `src/copy/strings.ts`.
 *
 * The rows are the tab's exits, all reachable without a valid proof (AAP 0.5.8): proof import, the
 * profile edit, My stay and the Table Credit balance, the saved payment card, and Settings, which
 * holds sign-out and account deletion. The three legal screens are rows too. The operator dashboard
 * is offered on web alone and to the operator role alone, which is a navigation convenience only —
 * `apps/api` answers `403 operator_only` to everyone else (AAP 0.3.2).
 *
 * A read in flight shows one line; a failed read shows the error banner with the retry that re-runs
 * it, and the failure is spoken once per distinct code. Nothing on this screen logs: no field of
 * `MeDto` reaches a log line or a crash report (AAP 0.11.1).
 */
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import {
  MIN_TOUCH_TARGET,
  colors,
  fontWeights,
  formatUsdWhole,
  spacing,
  typography,
} from '@tablemate/shared';
import type { CityDto, LodgingClaimStatus, MeDto, ProofStatus } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { REPUTATION_EMPTY, formatCalendarDate } from '../../src/copy/strings';
import { queryKeys, useMe } from '../../src/state/meetup-store';
import { Avatar, Banner, ListItem, Screen, announce } from '../../src/ui';

// --- Constants -----------------------------------------------------------------------------------

/**
 * The safe-area edges: the navigator's header and tab bar already inset the vertical sides, so
 * claiming them here would add their height twice.
 */
const SCREEN_EDGES = ['left', 'right'] as const;

/** Side of the identity avatar, in points / CSS px, so the header block is recognisable at a glance. */
const AVATAR_SIZE = 72;

/**
 * The four strings this screen owns. The empty state and the calendar-date formatter are the copy
 * module's, and every other sentence on a deposit, safety or lodging screen belongs to its own
 * screen, so nothing here repeats one of those.
 */
const LOADING_TEXT = 'Loading…';
const RETRY_LABEL = 'Try again';
const NO_SHOWS_LABEL = 'No-shows (last 90 days)';
const COUNTER_LABELS = ['Witnessed meetups', 'Travelers met', 'Partner venues', 'Cities'] as const;

/** One labelled counter of the reputation block: the API's own figure, never a computed score. */
interface Counter {
  readonly label: string;
  readonly value: number;
}

/**
 * The sentence the proof status shows (AAP 0.5.5, AAP 0.5.8). `cityName` is the resolved city, or
 * `null` when the proof carries no city to resolve; a valid proof is the only status whose fields
 * are present, so the range is built only for it and a missing one degrades to the city alone.
 *
 * Written as a record over `ProofStatus`, so a value added to the enum fails the type check here
 * rather than leaving the proof line blank.
 */
const PROOF_STATUS_TEXT = {
  valid: (proof, cityName) => {
    const range = proofDateRange(proof);
    const place = cityName === null ? 'Verified stay' : `Verified stay in ${cityName}`;
    return range === null ? `${place}.` : `${place}, ${range}`;
  },
  expired: () => 'Your verified stay has ended.',
  none: () => 'No verified stay yet.',
} as const satisfies Record<
  ProofStatus,
  (proof: MeDto['proof'], cityName: string | null) => string
>;

/**
 * How the active lodging claim reads as a row subtitle (AAP 0.5.3): the lodging's name and the
 * claim's current step. A record over `LodgingClaimStatus`, so a new step fails the type check.
 */
const CLAIM_STATUS_TEXT = {
  pending_call: 'waiting for the verification call',
  calling: 'verification call in progress',
  verified: 'verified',
  rejected: 'not verified',
  unreachable: 'could not be confirmed',
} as const satisfies Record<LodgingClaimStatus, string>;

// --- Pure helpers --------------------------------------------------------------------------------

/** Runs a row's navigation, so no row carries an inline arrow for it. */
function linkTo(path: string): () => void {
  return () => {
    router.push(path);
  };
}

/** The code of a failed read: the API's own code, or the client's answer that was not the envelope. */
function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'invalid_response';
}

/** `<arrival> – <departure>` for a valid proof, or `null` while either date is absent. */
function proofDateRange(proof: MeDto['proof']): string | null {
  const { arrivalDate, departureDate } = proof;
  if (arrivalDate === undefined || departureDate === undefined) return null;
  return `${formatCalendarDate(arrivalDate)} – ${formatCalendarDate(departureDate)}`;
}

/** The profile's own optional text, or `null` when it holds nothing to show. */
function present(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}

/** The city's display name from the cached `GET /cities`, falling back to the slug the proof carries. */
function cityNameFor(cities: readonly CityDto[] | undefined, cityId: string): string {
  return cities?.find((city) => city.id === cityId)?.name ?? cityId;
}

/** `Lisbon, PT`, or whichever of the two the profile holds, or `null` when it holds neither. */
function homeLine(homeCity: string | null, homeCountryCode: string | null): string | null {
  const city = homeCity === null ? '' : homeCity.trim();
  const country = homeCountryCode === null ? '' : homeCountryCode.trim();
  if (city !== '' && country !== '') return `${city}, ${country}`;
  return city !== '' ? city : country === '' ? null : country;
}

/**
 * The Table Credit balance in the copy's `10 USD` style. A whole-dollar balance goes through the
 * shared formatter, which refuses anything else; a balance that is not whole is the only case that
 * prints cents, because a balance is never rounded away.
 */
function creditText(cents: number): string {
  return cents % 100 === 0 ? formatUsdWhole(cents) : `${(cents / 100).toFixed(2)} USD`;
}

/**
 * The counter rows the reputation block shows (AAP 0.5.7). A traveler with no witnessed meetup
 * reads the empty state, and a no-show is still reported under it, because a missed meetup is what
 * the API counted whether or not anything was witnessed.
 */
function counterRows(reputation: MeDto['reputation']): Counter[] {
  const noShows: Counter = { label: NO_SHOWS_LABEL, value: reputation.noShows90d };
  if (reputation.witnessedMeetups === 0) {
    return reputation.noShows90d > 0 ? [noShows] : [];
  }
  return [
    { label: COUNTER_LABELS[0], value: reputation.witnessedMeetups },
    { label: COUNTER_LABELS[1], value: reputation.distinctCounterparts },
    { label: COUNTER_LABELS[2], value: reputation.distinctVenues },
    { label: COUNTER_LABELS[3], value: reputation.distinctCities },
    noShows,
  ];
}

/** The My stay row's subtitle: `<lodging> — <status>`, or empty while no claim is active. */
function claimSubtitle(claim: MeDto['activeLodgingClaim']): string {
  return claim === null ? '' : `${claim.lodgingName} — ${CLAIM_STATUS_TEXT[claim.status]}`;
}

// --- Screen --------------------------------------------------------------------------------------

/**
 * The Profile tab.
 *
 * @returns The profile screen: the identity block, the proof line, the reputation counters, the
 * rows that lead to proof import, the profile edit, My stay, Table Credit, the payment card,
 * Settings and the legal screens, and — on web, for the operator role — the operator dashboard.
 */
export default function ProfileScreen(): JSX.Element {
  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const errorCode = me.isError ? errorCodeOf(me.error) : null;

  // The failure is announced once per distinct code: a re-render over the same failed read would
  // otherwise repeat the sentence, and a recovery clears the code so the next failure speaks again.
  const announcedCode = useRef<string | null>(null);
  useEffect(() => {
    if (errorCode === null) {
      announcedCode.current = null;
      return;
    }
    if (announcedCode.current === errorCode) return;
    announcedCode.current = errorCode;
    announce(userMessageFor(errorCode));
  }, [errorCode]);

  if (errorCode !== null) {
    return (
      <Screen edges={SCREEN_EDGES} testID="profile">
        <Banner
          tone="error"
          message={userMessageFor(errorCode)}
          action={{ label: RETRY_LABEL, onPress: () => void me.refetch(), testID: 'profile-retry' }}
          testID="profile-error"
        />
      </Screen>
    );
  }

  const profile = me.data;
  if (profile === undefined) {
    return (
      <Screen edges={SCREEN_EDGES} testID="profile">
        <Text style={styles.body}>{LOADING_TEXT}</Text>
      </Screen>
    );
  }

  const { cityId } = profile.proof;
  const home = homeLine(profile.homeCity, profile.homeCountryCode);
  const nickname = present(profile.nickname);
  const proofText = PROOF_STATUS_TEXT[profile.proof.status](
    profile.proof,
    cityId === undefined ? null : cityNameFor(cities.data?.items, cityId),
  );
  const counters = counterRows(profile.reputation);

  return (
    <Screen edges={SCREEN_EDGES} testID="profile">
      <View style={styles.identity}>
        <Avatar
          avatarSeed={profile.avatarSeed}
          handle={profile.handle}
          size={AVATAR_SIZE}
          userId={profile.id}
          hasPhoto={profile.hasPhoto}
        />
        <View style={styles.identityText}>
          <Text accessibilityRole="header" style={styles.handle}>
            {profile.handle}
          </Text>
          {nickname === null ? null : <Text style={styles.body}>{nickname}</Text>}
          {home === null ? null : <Text style={styles.muted}>{home}</Text>}
        </View>
      </View>

      <Text style={styles.body}>{proofText}</Text>

      <View style={styles.block}>
        {profile.reputation.witnessedMeetups === 0 ? (
          <Text style={styles.muted}>{REPUTATION_EMPTY}</Text>
        ) : null}
        {counters.map((counter) => (
          <View
            accessible
            accessibilityLabel={`${counter.label}: ${counter.value}`}
            key={counter.label}
            style={styles.counter}
          >
            <Text style={styles.counterLabel}>{counter.label}</Text>
            <Text style={styles.counterValue}>{String(counter.value)}</Text>
          </View>
        ))}
      </View>

      <View style={styles.links}>
        <ListItem
          label="Verify my stay"
          onPress={linkTo('/proof/import')}
          role="link"
          testID="profile-verify-stay"
        />
        <ListItem
          label="Edit profile"
          onPress={linkTo('/profile/edit')}
          role="link"
          testID="profile-edit"
        />
        <ListItem
          label="My stay"
          onPress={linkTo('/profile/stay')}
          role="link"
          subtitle={claimSubtitle(profile.activeLodgingClaim)}
          testID="profile-my-stay"
        />
        <ListItem
          label="Table Credit"
          onPress={linkTo('/profile/credit')}
          role="link"
          subtitle={creditText(profile.tableCreditCents)}
          testID="profile-credit"
        />
        <ListItem
          label="Payment card"
          onPress={linkTo('/profile/payment')}
          role="link"
          testID="profile-payment"
        />
        <ListItem
          label="Settings"
          onPress={linkTo('/settings')}
          role="link"
          testID="profile-settings"
        />
        <ListItem
          label="Terms"
          onPress={linkTo('/legal/terms')}
          role="link"
          testID="profile-legal-terms"
        />
        <ListItem
          label="Safety tips"
          onPress={linkTo('/legal/safety')}
          role="link"
          testID="profile-legal-safety"
        />
        <ListItem
          label="Data attribution"
          onPress={linkTo('/legal/attribution')}
          role="link"
          testID="profile-legal-attribution"
        />
        {Platform.OS === 'web' && profile.role === 'operator' ? (
          <ListItem
            label="Operator dashboard"
            onPress={linkTo('/ops')}
            role="link"
            testID="profile-ops"
          />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.text,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
  block: {
    gap: spacing.sm,
  },
  counter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
  },
  counterLabel: {
    color: colors.text,
    flex: 1,
    fontSize: typography.label.fontSize,
    lineHeight: typography.label.lineHeight,
    minWidth: 0,
  },
  counterValue: {
    color: colors.text,
    fontSize: typography.label.fontSize,
    fontWeight: fontWeights.medium,
    lineHeight: typography.label.lineHeight,
  },
  handle: {
    color: colors.text,
    fontSize: typography.title.fontSize,
    fontWeight: fontWeights.bold,
    lineHeight: typography.title.lineHeight,
  },
  identity: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.lg,
  },
  identityText: {
    flex: 1,
    gap: spacing.xs,
    // `minWidth: 0` lets the text column shrink instead of pushing the avatar off the row on web.
    minWidth: 0,
  },
  links: {
    gap: spacing.xs,
  },
  muted: {
    color: colors.textMuted,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
});
