/**
 * One lodging's detail page: its identity and witnessed-meetup standing, the travelers staying
 * there and the door to claiming a stay (AAP 0.5.8, AAP 0.5.4, criterion 15).
 */
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { MIN_TOUCH_TARGET, colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { LodgingKind, Tier0Profile } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import {
  IMPORT_BANNER,
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  guestCountText,
  travelerSubtitle,
} from '../../src/copy/strings';
import { queryKeys, useMe } from '../../src/state/meetup-store';
import { Avatar, Banner, Button, Card, ListItem, Screen, announce } from '../../src/ui';

const LOADING = 'Loading…';
const TRAVELERS_HEADING = 'Travelers staying here';
const TRAVELERS_EMPTY = "No guests have chosen to show they're staying here.";
const NOT_FOUND_MESSAGE = "This lodging isn't available.";
const KIND_LABELS = {
  hostel: 'Hostel',
  hotel: 'Hotel',
  guesthouse: 'Guesthouse',
} as const satisfies Record<LodgingKind, string>;
type HeadingProps = TextProps & Readonly<{ 'aria-level': number }>;
const heading = (level: number): HeadingProps => ({ role: 'heading', 'aria-level': level });
type TextLinkProps = TextProps &
  Readonly<{ onKeyDown?: (event: { key?: string; repeat?: boolean }) => void }>;
const textLinkKeys = (activate: () => void): TextLinkProps =>
  Platform.OS === 'web'
    ? { onKeyDown: (event) => void (event.key === 'Enter' && !event.repeat && activate()) }
    : {};
type LodgingScreenProps = Readonly<{ title: string; children: ReactNode }>;
const LodgingScreen = ({ title, children }: LodgingScreenProps): ReactElement => (
  <Screen testID="lodging-detail">
    <Stack.Screen options={{ title }} />
    {children}
  </Screen>
);

const VERIFY = { label: 'Verify my stay', onPress: (): void => void router.push('/proof/import') };
const PROOF_BANNER = (
  <Banner tone="info" message={IMPORT_BANNER} action={VERIFY} testID="proof-banner" />
);
const externalLink = (text: string, url: string, label: string, testID: string): ReactElement => (
  <Text
    {...textLinkKeys(() => void Linking.openURL(url))}
    accessibilityLabel={label}
    accessibilityRole="link"
    accessible
    style={styles.link}
    testID={testID}
    children={text}
  />
);

function noticeFor(code: string): string {
  if (code === 'lodging_not_found') return NOT_FOUND_MESSAGE;
  return code === 'no_valid_proof' ? IMPORT_BANNER : userMessageFor(code);
}

const codeOf = (error: unknown): string => (isApiError(error) ? error.code : 'invalid_response');

const guestRow = (guest: Tier0Profile): ReactElement => (
  <ListItem
    key={guest.id}
    label={`@${guest.handle}`}
    subtitle={travelerSubtitle(guest)}
    leading={<Avatar avatarSeed={guest.avatarSeed} handle={guest.handle} size={32} decorative />}
    onPress={() => router.push(`/users/${guest.id}`)}
    role="link"
    testID={`lodging-guest-${guest.id}`}
  />
);

export default function LodgingDetailScreen(): ReactElement {
  const params = useLocalSearchParams();
  const id = typeof params.id === 'string' ? params.id : '';
  const lodging = useQuery({
    queryKey: queryKeys.lodging(id),
    queryFn: () => apiClient.getLodging(id),
    enabled: id !== '',
  });
  const me = useMe();
  const code = id === '' ? 'lodging_not_found' : lodging.isError ? codeOf(lodging.error) : null;
  // The failure is spoken once per distinct code, and the code is cleared when it recovers.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (announced.current === code) return;
    announced.current = code;
    if (code !== null) announce(noticeFor(code));
  }, [code]);
  const detail = lodging.data;
  const activeClaim = me.data?.activeLodgingClaim ?? null;
  const goStay = (): void => void router.push('/profile/stay');
  const goBack = (): void => void router.replace('/lodgings');
  const goClaim = () => router.push({ pathname: '/lodgings/claim', params: { lodgingId: id } });
  const retry = { label: 'Try again', onPress: (): void => void lodging.refetch() };
  const claimText = `You already have a stay claim at ${activeClaim?.lodgingName ?? ''}.`;
  const claimEntry =
    me.data === undefined ? null : activeClaim === null ? (
      <Button label="I'm staying here" onPress={goClaim} testID="lodging-claim-start" />
    ) : (
      <View style={styles.claim}>
        <Text style={styles.body}>{claimText}</Text>
        <Button label="My stay" variant="secondary" onPress={goStay} testID="lodging-my-stay" />
      </View>
    );
  const title = detail?.name ?? 'Lodging';
  const loading = <Text style={styles.note} children={LOADING} />;
  if (code === 'no_valid_proof') return <LodgingScreen title={title}>{PROOF_BANNER}</LodgingScreen>;
  if (code === 'lodging_not_found')
    return (
      <LodgingScreen title={title}>
        <Card testID="lodging-not-found">
          <Text style={styles.note} children={NOT_FOUND_MESSAGE} />
          <Button
            label="Back to lodgings"
            variant="secondary"
            onPress={goBack}
            testID="lodging-back"
          />
        </Card>
      </LodgingScreen>
    );
  if (code !== null)
    return (
      <LodgingScreen title={title}>
        <Banner tone="error" message={noticeFor(code)} action={retry} testID="lodging-error" />
      </LodgingScreen>
    );
  if (detail === undefined) return <LodgingScreen title={title}>{loading}</LodgingScreen>;
  const { name, kind, address, phone, rank, activityScore, guestCount, guests } = detail;
  const rows = <View>{guests.map(guestRow)}</View>;
  const activity = `Activity score: ${activityScore} (witnessed meetups, last 90 days)`;
  return (
    <LodgingScreen title={title}>
      <Card testID="lodging-summary">
        <Text {...heading(2)} style={styles.name} children={name} />
        <Text style={styles.note}>{KIND_LABELS[kind]}</Text>
        {!address?.trim() ? null : <Text style={styles.body}>{address}</Text>}
        {phone === null
          ? null
          : externalLink(phone, `tel:${phone}`, `Call ${phone}`, 'lodging-phone')}
        <Text style={styles.body}>{`Rank #${rank} by meetup activity`}</Text>
        <Text style={styles.note}>{activity}</Text>
      </Card>
      <Text style={styles.body} testID="lodging-guest-count">
        {`Verified guests: ${guestCountText(guestCount)}`}
      </Text>
      <Text {...heading(2)} style={styles.section} children={TRAVELERS_HEADING} />
      {guests.length === 0 ? <Text style={styles.note}>{TRAVELERS_EMPTY}</Text> : rows}
      {claimEntry}
      {externalLink(OSM_ATTRIBUTION, OSM_COPYRIGHT_URL, OSM_ATTRIBUTION, 'osm-attribution')}
    </LodgingScreen>
  );
}

const styles = StyleSheet.create({
  name: { ...typography.heading, color: colors.text, fontWeight: fontWeights.bold },
  section: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.text },
  note: { ...typography.body, color: colors.textMuted },
  link: {
    ...typography.body,
    alignSelf: 'flex-start',
    alignItems: 'center',
    color: colors.primary,
    display: 'flex',
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: spacing.sm,
    textDecorationLine: 'underline',
  },
  claim: { gap: spacing.md },
});
