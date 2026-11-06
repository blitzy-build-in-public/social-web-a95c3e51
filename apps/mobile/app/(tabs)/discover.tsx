/**
 * The Discover tab: traveler discovery for the city a valid proof names, and the city picker that
 * works with or without one (AAP 0.5.8, AAP 0.7.1 row 3).
 */
import { useEffect, type ReactElement } from 'react';
import { StyleSheet, Text, View, type TextProps } from 'react-native';
import { router } from 'expo-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { CityDto, Tier0Profile } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { DISCOVERY_EMPTY, IMPORT_BANNER, formatCalendarDate } from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { useSession } from '../../src/state/session-store';
import { Avatar, Banner, Button, ListItem, Screen, announce } from '../../src/ui';

const SCREEN_EDGES = ['left', 'right'] as const;
type Heading = TextProps & Readonly<{ 'aria-level': number }>;
const SECTION_HEADING: Heading = { role: 'heading', 'aria-level': 2 };
const LOADING = 'Loading…';
const NO_CITY = '';
const IMPORT_ACTION = { label: 'Verify my stay', onPress: () => router.push('/proof/import') };
const LOAD_MORE = { variant: 'secondary' as const, label: 'Show more travelers' };
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'invalid_response';
}
function witnessedMeetupsText(count: number): string {
  return count === 1 ? '1 witnessed meetup' : `${count} witnessed meetups`;
}
function travelerSubtitle(profile: Tier0Profile): string {
  const parts = [witnessedMeetupsText(profile.reputation.witnessedMeetups)];
  const tags = profile.interestTags.map((tag) => tag.replace(/_/g, ' '));
  if (tags.length > 0) parts.push(tags.join(', '));
  const { proofDates } = profile;
  if (proofDates !== null) {
    const { arrivalDate, departureDate } = proofDates;
    parts.push(`${formatCalendarDate(arrivalDate)} – ${formatCalendarDate(departureDate)}`);
  }
  return parts.join(' · ');
}
function travelerRow(profile: Tier0Profile) {
  return {
    testID: `traveler-${profile.id}`,
    role: 'link' as const,
    label: profile.handle,
    subtitle: travelerSubtitle(profile),
    leading: <Avatar avatarSeed={profile.avatarSeed} handle={profile.handle} decorative />,
    onPress: () => router.push(`/users/${profile.id}`),
  };
}
function cityRow(city: CityDto) {
  return {
    testID: `city-${city.id}`,
    role: 'link' as const,
    label: city.name,
    subtitle: city.countryCode,
    onPress: () => router.push(`/cities/${city.id}`),
  };
}
export default function DiscoverScreen(): ReactElement {
  const me = useMe();
  const signedIn = useSession().status === 'signed_in';
  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    // Enabled only for a signed-in session: with no access token the read is refused, and the
    // recovery that follows would end the sign-in a deep link is still completing (AAP 0.3.3).
    enabled: signedIn,
  });
  const proof = me.data?.proof;
  const proofCityId = proof !== undefined && proof.status === 'valid' ? proof.cityId : undefined;
  const travelers = useInfiniteQuery({
    queryKey: queryKeys.travelers(proofCityId ?? NO_CITY),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      if (proofCityId === undefined) return Promise.reject(new Error('no valid proof city'));
      return apiClient.listTravelers(proofCityId, pageParam);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: proofCityId !== undefined,
  });
  const meMessage = me.error === null ? undefined : userMessageFor(errorCodeOf(me.error));
  const cityNote = cities.error === null ? undefined : userMessageFor(errorCodeOf(cities.error));
  const travelersCode = travelers.error === null ? undefined : errorCodeOf(travelers.error);
  const travelersMessage = travelersCode === undefined ? undefined : userMessageFor(travelersCode);
  const retryMe = { label: 'Try again', onPress: () => void me.refetch() };
  const loadMore = () => void travelers.fetchNextPage();
  useEffect(() => {
    if (travelersCode === 'no_valid_proof')
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [travelersCode]);
  const announcement = meMessage ?? cityNote ?? travelersMessage;
  useEffect(() => {
    if (announcement !== undefined) announce(announcement);
  }, [announcement]);
  if (meMessage !== undefined || me.data === undefined)
    return (
      <Screen edges={SCREEN_EDGES}>
        {meMessage === undefined ? (
          <Text style={styles.body}>{LOADING}</Text>
        ) : (
          <Banner tone="error" message={meMessage} action={retryMe} />
        )}
      </Screen>
    );
  const travelersHeading = { ...SECTION_HEADING, style: styles.heading } as const;
  const cityName = (cities.data?.items ?? []).find((city) => city.id === proofCityId)?.name;
  const cityLabel = proofCityId === undefined ? undefined : (cityName ?? proofCityId);
  const retryTravelers = { label: 'Try again', onPress: () => void travelers.refetch() };
  const retryCities = { label: 'Try again', onPress: () => void cities.refetch() };
  const rows = travelers.data?.pages.flatMap((page) => page.items) ?? [];
  const citiesItems = cities.data?.items ?? [];
  const venuesLabel = `See partner venues in ${cityLabel ?? NO_CITY}`;
  const openVenues = () => router.push(`/cities/${proofCityId ?? NO_CITY}`);
  return (
    <Screen edges={SCREEN_EDGES}>
      {cityLabel === undefined ? (
        <Banner testID="proof-banner" tone="info" message={IMPORT_BANNER} action={IMPORT_ACTION} />
      ) : (
        <View style={styles.section}>
          <Text {...travelersHeading}>{`Travelers in ${cityLabel}`}</Text>
          {travelersMessage !== undefined && travelersCode !== 'no_valid_proof' && (
            <Banner tone="error" message={travelersMessage} action={retryTravelers} />
          )}
          {travelers.isPending ? <Text style={styles.body}>{LOADING}</Text> : null}
          {rows.map((profile) => (
            <ListItem key={profile.id} {...travelerRow(profile)} />
          ))}
          {travelers.hasNextPage && (
            <Button {...LOAD_MORE} busy={travelers.isFetchingNextPage} onPress={loadMore} />
          )}
          {travelers.isSuccess && rows.length === 0 && (
            <>
              <Text style={styles.body}>{DISCOVERY_EMPTY}</Text>
              <ListItem role="link" label={venuesLabel} onPress={openVenues} />
            </>
          )}
        </View>
      )}
      <View style={styles.section}>
        <Text {...SECTION_HEADING} style={styles.heading}>
          {cityLabel === undefined ? 'Browse cities' : 'Browse other cities'}
        </Text>
        {cityNote !== undefined && <Banner tone="error" message={cityNote} action={retryCities} />}
        {cities.isPending ? <Text style={styles.body}>{LOADING}</Text> : null}
        {citiesItems.map((city) => (
          <ListItem key={city.id} {...cityRow(city)} />
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  heading: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.textMuted },
});
