/** The Profile tab: the caller's own identity, its proof, the witnessed-presence counters and the doors out of the tab. */
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, type ComponentProps } from 'react';
import { Platform, StyleSheet, Text, View, type TextProps } from 'react-native';
import {
  MIN_TOUCH_TARGET,
  colors,
  componentSizes,
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
import { Avatar, Banner, ListItem, Screen, announce, type ListItemProps } from '../../src/ui';

const SCREEN_EDGES = ['left', 'right'] as const;
const AVATAR_SIZE = componentSizes.avatarMedium;
const NO_SHOWS_LABEL = 'No-shows (last 90 days)';
const COUNTER_LABELS = ['Witnessed meetups', 'Travelers met', 'Partner venues', 'Cities'] as const;
type HeadingProps = TextProps & Readonly<{ 'aria-level': number }>;
/** The handle: the tab header owns the page's single level-1 heading, so this one sits at level 2. */
const HANDLE_HEADING: HeadingProps = { role: 'heading', 'aria-level': 2 };

const styles = StyleSheet.create({
  body: { ...typography.body, color: colors.text },
  block: { gap: spacing.sm },
  counter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
  },
  counterLabel: { ...typography.label, color: colors.text, flex: 1, minWidth: 0 },
  counterValue: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  handle: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  identity: { alignItems: 'center', flexDirection: 'row', gap: spacing.lg },
  identityText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  links: { gap: spacing.xs },
  muted: { ...typography.body, color: colors.textMuted },
});

type Counter = { readonly label: string; readonly value: number };
type Row = readonly [string, string, string, Partial<ListItemProps>?];
type ProofText = Record<ProofStatus, (proof: MeDto['proof'], cityName: string | null) => string>;
const PROOF_STATUS_TEXT = {
  valid: (proof, cityName) => {
    const place = cityName === null ? 'Verified stay' : `Verified stay in ${cityName}`;
    const { arrivalDate, departureDate } = proof;
    if (arrivalDate === undefined || departureDate === undefined) return `${place}.`;
    return `${place}, ${formatCalendarDate(arrivalDate)} – ${formatCalendarDate(departureDate)}`;
  },
  expired: () => 'Your verified stay has ended.',
  none: () => 'No verified stay yet.',
} as const satisfies ProofText;
const CLAIM_STATUS_TEXT = {
  pending_call: 'waiting for the verification call',
  calling: 'verification call in progress',
  verified: 'verified',
  rejected: 'not verified',
  unreachable: 'could not be confirmed',
} as const satisfies Record<LodgingClaimStatus, string>;
function rowPropsOf([testID, label, href, extra]: Row): ListItemProps & { readonly href: string } {
  const role = extra?.role ?? 'link';
  return { ...extra, label, testID, href, role, onPress: () => router.push(href) };
}
function counterProps({ label, value }: Counter): ComponentProps<typeof View> {
  return { accessible: true, accessibilityLabel: `${label}: ${value}`, style: styles.counter };
}
function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'invalid_response';
}
function cityNameFor(cities: readonly CityDto[] | undefined, cityId: string): string {
  return cities?.find((city) => city.id === cityId)?.name ?? cityId;
}
function homeLine(homeCity: string | null, homeCountryCode: string | null): string | null {
  const city = homeCity === null ? '' : homeCity.trim();
  const country = homeCountryCode === null ? '' : homeCountryCode.trim();
  if (city !== '' && country !== '') return `${city}, ${country}`;
  return city !== '' ? city : country === '' ? null : country;
}
function creditText(cents: number): string {
  return cents % 100 === 0 ? formatUsdWhole(cents) : `${(cents / 100).toFixed(2)} USD`;
}
/** All five counters always render, whatever their values: a zero record reads the same here as on the traveler profile. */
function counterRows(reputation: MeDto['reputation']): Counter[] {
  return [
    { label: COUNTER_LABELS[0], value: reputation.witnessedMeetups },
    { label: COUNTER_LABELS[1], value: reputation.distinctCounterparts },
    { label: COUNTER_LABELS[2], value: reputation.distinctVenues },
    { label: COUNTER_LABELS[3], value: reputation.distinctCities },
    { label: NO_SHOWS_LABEL, value: reputation.noShows90d },
  ];
}
const OPERATOR_ROW: Row = ['profile-ops', 'Operator dashboard', '/ops'];
function claimSubtitle(claim: MeDto['activeLodgingClaim']): string {
  return claim === null ? '' : `${claim.lodgingName} — ${CLAIM_STATUS_TEXT[claim.status]}`;
}
export default function ProfileScreen(): JSX.Element {
  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const errorCode = me.isError ? errorCodeOf(me.error) : null;
  const announcedCode = useRef<string | null>(null);
  useEffect(() => {
    if (errorCode === null) announcedCode.current = null;
    else if (announcedCode.current !== errorCode) {
      announcedCode.current = errorCode;
      announce(userMessageFor(errorCode));
    }
  }, [errorCode]);
  const retry = { label: 'Try again', onPress: () => void me.refetch(), testID: 'profile-retry' };
  if (errorCode !== null) {
    const notice = userMessageFor(errorCode);
    return (
      <Screen edges={SCREEN_EDGES} testID="profile">
        <Banner tone="error" message={notice} action={retry} testID="profile-error" />
      </Screen>
    );
  }
  const profile = me.data;
  if (profile === undefined)
    return (
      <Screen edges={SCREEN_EDGES} testID="profile">
        <Text style={styles.body}>{'Loading…'}</Text>
      </Screen>
    );
  const { cityId } = profile.proof;
  const home = homeLine(profile.homeCity, profile.homeCountryCode);
  const nickname = profile.nickname?.trim() ? profile.nickname : null;
  const cityName = cityId === undefined ? null : cityNameFor(cities.data?.items, cityId);
  const proofText = PROOF_STATUS_TEXT[profile.proof.status](profile.proof, cityName);
  const stayText = claimSubtitle(profile.activeLodgingClaim);
  const creditNote = creditText(profile.tableCreditCents);
  const noMeetups = profile.reputation.witnessedMeetups === 0;
  const showOps = Platform.OS === 'web' && profile.role === 'operator';
  const rows: readonly Row[] = [
    ['profile-verify-stay', 'Verify my stay', '/proof/import', { role: 'link' }],
    ['profile-edit', 'Edit profile', '/profile/edit', { role: 'link' }],
    ['profile-my-stay', 'My stay', '/profile/stay', { role: 'link', subtitle: stayText }],
    ['profile-credit', 'Table Credit', '/profile/credit', { role: 'link', subtitle: creditNote }],
    ['profile-payment', 'Payment card', '/profile/payment', { role: 'link' }],
    ['profile-settings', 'Settings', '/settings', { role: 'link' }],
    ['profile-legal-terms', 'Terms', '/legal/terms', { role: 'link' }],
    ['profile-legal-safety', 'Safety tips', '/legal/safety', { role: 'link' }],
    ['profile-legal-attribution', 'Data attribution', '/legal/attribution', { role: 'link' }],
  ];
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
          <Text {...HANDLE_HEADING} style={styles.handle}>
            {profile.handle}
          </Text>
          {nickname === null ? null : <Text style={styles.body}>{nickname}</Text>}
          {home === null ? null : <Text style={styles.muted}>{home}</Text>}
        </View>
      </View>
      <Text style={styles.body}>{proofText}</Text>
      <View style={styles.block}>
        {noMeetups && <Text style={styles.muted}>{REPUTATION_EMPTY}</Text>}
        {counterRows(profile.reputation).map((counter) => (
          <View key={counter.label} {...counterProps(counter)}>
            <Text style={styles.counterLabel}>{counter.label}</Text>
            <Text style={styles.counterValue}>{String(counter.value)}</Text>
          </View>
        ))}
      </View>
      <View style={styles.links}>
        {rows.map((row) => (
          <ListItem key={row[0]} {...rowPropsOf(row)} />
        ))}
        {showOps && <ListItem {...rowPropsOf(OPERATOR_ROW)} />}
      </View>
    </Screen>
  );
}
