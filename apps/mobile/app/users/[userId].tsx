/** One traveler's profile at the viewer's own disclosure tier — the route `/users/[userId]`
 * (AAP 0.5.8, AAP 0.8.1). */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { colors, fontWeights, radii, spacing, typography } from '@tablemate/shared';
import { ProofStatus } from '@tablemate/shared';
import type { CityDto, Reputation, Tier0Profile } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { IMPORT_BANNER, REPUTATION_EMPTY, formatCalendarDate } from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { useSession } from '../../src/state/session-store';
import { Avatar, Banner, Button, Card, Screen, announce } from '../../src/ui';

const NOT_AVAILABLE = "This traveler isn't available.";
const BUTTONS = {
  propose: { testID: 'user-propose', label: 'Propose a meetup' },
  more: {
    testID: 'user-more',
    label: 'More',
    variant: 'secondary',
    hint: 'Shows block and report options',
  },
  report: { testID: 'user-report', label: 'Report', variant: 'secondary' },
  block: { testID: 'user-block', label: 'Block', variant: 'danger' },
  confirmBlock: { testID: 'user-block', variant: 'danger' },
  cancel: { testID: 'user-block-cancel', label: 'Cancel', variant: 'secondary' },
  openMeetups: { label: 'Open meetups', variant: 'secondary' },
  back: { label: 'Back', variant: 'secondary' },
} as const;
const BANNERS = {
  load: { tone: 'error', testID: 'user-error' },
  block: { tone: 'error', testID: 'user-block-error' },
  proof: { tone: 'info', testID: 'proof-banner' },
} as const;
const VERIFY_ACTION = { label: 'Verify my stay', onPress: () => router.push('/proof/import') };
const LOADING = { accessibilityLabel: 'Loading profile', color: colors.primary } as const;
const CITY_LIST_ROOT = queryKeys.cities.slice(0, 1);
const MEETUP_ROOT = queryKeys.meetup('').slice(0, 1);
type ProofDates = NonNullable<Tier0Profile['proofDates']>;
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'invalid_response';
}
function present(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}
function cityNameFor(cities: readonly CityDto[] | undefined, cityId: string): string {
  return cities?.find((city) => city.id === cityId)?.name ?? cityId;
}
function regionName(code: string): string {
  if (typeof Intl.DisplayNames !== 'function') return code;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {}
  return code;
}
function stayLine(cityLabel: string | null, dates: ProofDates): string {
  const from = formatCalendarDate(dates.arrivalDate);
  const to = formatCalendarDate(dates.departureDate);
  return cityLabel === null ? `From ${from} to ${to}` : `In ${cityLabel} from ${from} to ${to}`;
}
const counterRows = (reputation: Reputation) => [
  { label: 'Witnessed meetups', value: reputation.witnessedMeetups },
  { label: 'Different travelers met', value: reputation.distinctCounterparts },
  { label: 'Venues', value: reputation.distinctVenues },
  { label: 'Cities', value: reputation.distinctCities },
  { label: 'No-shows, last 90 days', value: reputation.noShows90d },
];
/** The block confirmation's question: a block is confirmed in place, never through `Alert`. */
function blockQuestion(handle: string): string {
  return (
    `Block @${handle}? You won't see each other's profiles, any open meetup between you is ` +
    "cancelled, and blocking can't be undone in the app."
  );
}

export default function TravelerProfileScreen(): ReactElement {
  const params = useLocalSearchParams<{ userId: string | string[] }>();
  const session = useSession();
  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const [proofBanner, setProofBanner] = useState(false);
  const routeUserId = Array.isArray(params.userId) ? params.userId[0] : params.userId;
  const userId = typeof routeUserId === 'string' ? routeUserId : '';
  const profile = useQuery({
    queryKey: queryKeys.user(userId),
    queryFn: () => apiClient.getUser(userId),
    enabled: userId.length > 0,
  });
  const handle = profile.data?.handle;
  const block = useMutation({
    mutationFn: async (): Promise<void> => {
      try {
        await apiClient.blockUser(userId);
      } catch (error) {
        if (!(isApiError(error) && error.code === 'user_not_found')) throw error;
      }
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.user(userId) });
      void queryClient.invalidateQueries({ queryKey: CITY_LIST_ROOT });
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll });
      void queryClient.invalidateQueries({ queryKey: MEETUP_ROOT });
      announce(handle === undefined ? 'You blocked this traveler.' : `You blocked @${handle}.`);
      router.replace('/discover');
    },
  });
  const loadCode = profile.isError ? errorCodeOf(profile.error) : undefined;
  const blockCode = block.isError ? errorCodeOf(block.error) : undefined;
  const errorCode = loadCode ?? blockCode;
  const announcedCode = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (errorCode === undefined) {
      announcedCode.current = undefined;
      return;
    }
    if (announcedCode.current === errorCode) return;
    announcedCode.current = errorCode;
    announce(userMessageFor(errorCode));
  }, [errorCode]);
  const unavailable = userId === '' || loadCode === 'user_not_found';
  useEffect(() => {
    if (unavailable) announce(NOT_AVAILABLE);
  }, [unavailable]);
  const titleOptions = { title: handle === undefined ? 'Traveler' : `@${handle}` };
  const retryAction = { label: 'Try again', onPress: () => void profile.refetch() };
  const backToDiscover = () => (router.canGoBack() ? router.back() : router.replace('/discover'));
  const person = profile.data;
  const state: ReactElement | null = unavailable ? (
    <>
      <Text style={styles.body}>{NOT_AVAILABLE}</Text>
      <Button {...BUTTONS.back} onPress={backToDiscover} />
    </>
  ) : loadCode !== undefined ? (
    <Banner {...BANNERS.load} message={userMessageFor(loadCode)} action={retryAction} />
  ) : null;
  if (person === undefined || state !== null)
    return (
      <Screen testID="user-profile">
        <Stack.Screen options={titleOptions} />
        {state ?? <ActivityIndicator {...LOADING} size="large" testID="user-loading" />}
      </Screen>
    );
  const reputation = person.reputation;
  const callerId = session.userId ?? me.data?.id;
  const isSelf = callerId !== undefined && callerId === userId;
  const cityLabel =
    person.currentCityId === null ? null : cityNameFor(cities.data?.items, person.currentCityId);
  const stay = person.proofDates === null ? null : stayLine(cityLabel, person.proofDates);
  const region = person.homeRegion === null ? null : regionName(person.homeRegion);
  const placeLines: string[] = [];
  if (region !== null) placeLines.push(region);
  if (stay !== null) placeLines.push(stay);
  else if (cityLabel !== null) placeLines.push(`Currently in ${cityLabel}`);
  const hasPhoto = 'hasPhoto' in person && person.hasPhoto === true;
  const tier1 = 'nickname' in person ? person : null;
  const nickname = tier1 === null ? null : present(tier1.nickname);
  const bio = tier1 === null ? null : present(tier1.bio);
  const canMessage = tier1 !== null && tier1.canMessage;
  const tier3 = 'fullName' in person ? person : null;
  const fullName = tier3 === null ? null : present(tier3.fullName);
  const externalContact = tier3 === null ? null : present(tier3.externalContact);
  function onPropose(): void {
    if (me.data?.proof.status === ProofStatus.enum.valid) {
      router.push({ pathname: '/meetups/propose', params: { recipientId: userId } });
      return;
    }
    setProofBanner(true);
    announce(IMPORT_BANNER);
  }
  const avatarProps = { avatarSeed: person.avatarSeed, handle: person.handle, size: 96 };
  const photo = hasPhoto ? { userId, hasPhoto: true } : {};
  const confirmButton = { ...BUTTONS.confirmBlock, label: `Block @${person.handle}` };
  const openReport = () => void router.push({ pathname: '/report', params: { userId } });
  const confirmBlock = () => setConfirmingBlock(false);
  const startBlock = () => setConfirmingBlock(true);
  const blockSection = confirmingBlock ? (
    <View style={styles.confirm}>
      <Text style={styles.body}>{blockQuestion(person.handle)}</Text>
      <Button {...confirmButton} busy={block.isPending} onPress={() => block.mutate()} />
      <Button {...BUTTONS.cancel} onPress={confirmBlock} />
    </View>
  ) : (
    <Button {...BUTTONS.block} onPress={startBlock} />
  );
  const actions = (
    <View style={styles.actions}>
      <Button {...BUTTONS.propose} busy={me.isPending} onPress={onPropose} />
      <Button {...BUTTONS.more} onPress={() => setMenuOpen((open) => !open)} />
      {menuOpen ? (
        <View style={styles.menu}>
          <Button {...BUTTONS.report} onPress={openReport} />
          {blockSection}
        </View>
      ) : null}
      {proofBanner ? (
        <Banner {...BANNERS.proof} message={IMPORT_BANNER} action={VERIFY_ACTION} />
      ) : null}
      {blockCode === undefined ? null : (
        <Banner {...BANNERS.block} message={userMessageFor(blockCode)} />
      )}
    </View>
  );
  return (
    <Screen testID="user-profile">
      <Stack.Screen options={titleOptions} />
      <View style={styles.identity}>
        <Avatar {...avatarProps} {...photo} />
        <View style={styles.identityText}>
          <Text accessibilityRole="header" style={styles.handle}>{`@${person.handle}`}</Text>
          {placeLines.map((line) => (
            <Text key={line} style={styles.muted}>
              {line}
            </Text>
          ))}
        </View>
      </View>
      {isSelf ? null : actions}
      <Card title="Witnessed presence">
        <View style={styles.counterList}>
          {counterRows(reputation).map((counter) => (
            <View key={counter.label} style={styles.counterRow}>
              <Text style={styles.body}>{counter.label}</Text>
              <Text style={styles.counterValue}>{counter.value}</Text>
            </View>
          ))}
          {reputation.witnessedMeetups === 0 ? (
            <Text style={styles.muted} children={REPUTATION_EMPTY} />
          ) : null}
        </View>
      </Card>
      {person.interestTags.length === 0 ? null : (
        <View style={styles.tags}>
          {person.interestTags.map((tag) => (
            <View key={tag} style={styles.chip}>
              <Text style={styles.chipText}>{tag.replace(/_/g, ' ')}</Text>
            </View>
          ))}
        </View>
      )}
      {tier1 === null ? null : (
        <View style={styles.details}>
          {nickname === null ? null : <Text style={styles.body}>{nickname}</Text>}
          {bio === null ? null : <Text style={styles.body}>{bio}</Text>}
          {canMessage ? (
            <View style={styles.details}>
              <Text
                style={styles.muted}
                children="You can chat with this traveler from your meetup."
              />
              <Button {...BUTTONS.openMeetups} onPress={() => router.push('/meetups')} />
            </View>
          ) : null}
        </View>
      )}
      {tier3 === null ? null : (
        <Card title="Shared with you">
          {fullName === null ? null : <Text style={styles.body}>{fullName}</Text>}
          {externalContact === null ? null : <Text style={styles.body}>{externalContact}</Text>}
          <Text style={styles.muted} children="Shared after two completed meetups together." />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  identity: { alignItems: 'center', flexDirection: 'row', gap: spacing.lg },
  identityText: { flex: 1, gap: spacing.xs },
  handle: { ...typography.heading, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted },
  actions: { gap: spacing.sm },
  menu: { gap: spacing.sm },
  confirm: { gap: spacing.md },
  counterList: { gap: spacing.sm },
  counterRow: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' },
  counterValue: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipText: { ...typography.caption, color: colors.text },
  details: { gap: spacing.sm },
});
