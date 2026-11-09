/**
 * The Discover tab: traveler discovery for a city the caller holds a valid proof for, and the city
 * picker that works with or without one (AAP 0.5.8, AAP 0.7.1 row 3).
 *
 * Which city the list is for follows the caller's entitlement rather than the single stay
 * `MeDto.proof` reports: a traveler may hold valid proofs for several cities, so the screen lists the
 * city the route asked for when the caller's `validCityIds` holds it, else the city of the current
 * proof, else the first entitled city. It asks for no city outside that set, which is what keeps the
 * traveler route's `403 no_valid_proof` from ever answering here (AAP 0.5.7, 0.5.8).
 */
import { useEffect, type ReactElement } from 'react';
import { FlatList, StyleSheet, Text, View, type TextProps } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { CityDto, Tier0Profile } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { bootstrap } from '../../src/auth/session';
import { DISCOVERY_EMPTY, IMPORT_BANNER, travelerSubtitle } from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { useSession } from '../../src/state/session-store';
import { Avatar, Banner, Button, ListItem, Screen, announce } from '../../src/ui';

const SCREEN_EDGES = ['left', 'right'] as const;
type Heading = TextProps & Readonly<{ 'aria-level': number }>;
const SECTION_HEADING: Heading = { role: 'heading', 'aria-level': 2 };
const LOADING = 'Loading…';
const NO_CITY = '';
/**
 * How many viewports of rows the tab keeps mounted: the rows on screen plus about half a screen either
 * side of them. The traveler list grows with every page the reader loads, so the tab mounts a couple of
 * screens of it rather than every traveler loaded so far.
 */
const LIST_WINDOW_SIZE = 2;
const IMPORT_ACTION = { label: 'Verify my stay', onPress: () => router.push('/proof/import') };
const LOAD_MORE = { variant: 'secondary' as const, label: 'Show more travelers' };
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'invalid_response';
}
/**
 * The city whose travelers this screen lists (AAP 0.5.7, 0.5.8): the requested one when the caller
 * holds a proof for it, else the city of the caller's current proof, else the first entitled city —
 * `validCityIds` arrives ascending, so that default is the same on every read of one state.
 *
 * `undefined` when the caller's entitlement is empty, which is the unverified state: the import
 * banner replaces the list and no traveler request is made.
 */
function listedCityId(
  entitledCityIds: readonly string[],
  requestedCityId: string,
  proofCityId: string | undefined,
): string | undefined {
  if (entitledCityIds.includes(requestedCityId)) return requestedCityId;
  if (proofCityId !== undefined && entitledCityIds.includes(proofCityId)) return proofCityId;
  return entitledCityIds[0];
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
  const session = useSession();
  const signedIn = session.status === 'signed_in';
  // The age gate precedes every traveler feature route, so a signed-in account that has not
  // recorded consents has this read refused with `403 age_gate_required` (AAP 0.5.4): one console
  // error, and this screen's announcement while the age gate is the screen showing.
  const consented = signedIn && session.consented === true;
  // The city a deep link asked for, as `cities/[cityId].tsx` and a proposal name it.
  const params = useLocalSearchParams<{ cityId?: string | string[] }>();
  const requestedCityId = Array.isArray(params.cityId)
    ? (params.cityId[0] ?? NO_CITY)
    : (params.cityId ?? NO_CITY);
  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    // Enabled only for a consented session: with no access token the read is refused as well, so
    // the recovery that follows would end the sign-in a deep link is still completing (AAP 0.3.3).
    enabled: consented,
  });
  // The caller's entitlement — every city a proof of theirs is valid for now (AAP 0.5.7, 0.5.8) —
  // absent from a payload cached before the field existed, where an empty set keeps the unverified
  // state rather than naming a city the caller cannot ask about.
  const entitledCityIds = me.data?.validCityIds ?? [];
  const proof = me.data?.proof;
  const proofCityId = proof !== undefined && proof.status === 'valid' ? proof.cityId : undefined;
  const listCityId = listedCityId(entitledCityIds, requestedCityId, proofCityId);
  const travelers = useInfiniteQuery({
    queryKey: queryKeys.travelers(listCityId ?? NO_CITY),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      if (listCityId === undefined) return Promise.reject(new Error('no valid proof city'));
      return apiClient.listTravelers(listCityId, pageParam);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: listCityId !== undefined,
  });
  const meMessage = me.error === null ? undefined : userMessageFor(errorCodeOf(me.error));
  const cityNote = cities.error === null ? undefined : userMessageFor(errorCodeOf(cities.error));
  const travelersCode = travelers.error === null ? undefined : errorCodeOf(travelers.error);
  const travelersMessage = travelersCode === undefined ? undefined : userMessageFor(travelersCode);
  // A restore that ran, failed and proved nothing leaves the own-profile read unissued — it is
  // enabled only for a signed-in session — so this screen has no error of its own to show. The
  // failure's own sentence is shown in its place, with the restore itself to retry: the store's
  // `loading` alone cannot tell this state from a restore that is still running.
  const restoreCode = session.status === 'loading' ? session.restoreFailureCode : undefined;
  const restoreMessage = restoreCode === undefined ? undefined : userMessageFor(restoreCode);
  const loadMessage = meMessage ?? restoreMessage;
  const retryMe = { label: 'Try again', onPress: () => void me.refetch() };
  const retryRestore = { label: 'Try again', onPress: () => void bootstrap() };
  const retryLoad = meMessage === undefined ? retryRestore : retryMe;
  const loadMore = () => void travelers.fetchNextPage();
  useEffect(() => {
    if (travelersCode === 'no_valid_proof')
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [travelersCode]);
  const announcement = meMessage ?? restoreMessage ?? cityNote ?? travelersMessage;
  useEffect(() => {
    if (announcement !== undefined) announce(announcement);
  }, [announcement]);
  if (meMessage !== undefined || me.data === undefined)
    return (
      <Screen edges={SCREEN_EDGES}>
        {loadMessage === undefined ? (
          <Text style={styles.body}>{LOADING}</Text>
        ) : (
          <Banner tone="error" message={loadMessage} action={retryLoad} />
        )}
      </Screen>
    );
  const travelersHeading = { ...SECTION_HEADING, style: styles.heading } as const;
  const cityName = (cities.data?.items ?? []).find((city) => city.id === listCityId)?.name;
  const cityLabel = listCityId === undefined ? undefined : (cityName ?? listCityId);
  const retryTravelers = { label: 'Try again', onPress: () => void travelers.refetch() };
  const retryCities = { label: 'Try again', onPress: () => void cities.refetch() };
  const rows = travelers.data?.pages.flatMap((page) => page.items) ?? [];
  const citiesItems = cities.data?.items ?? [];
  const venuesLabel = `See partner venues in ${cityLabel ?? NO_CITY}`;
  const openVenues = () => router.push(`/cities/${listCityId ?? NO_CITY}`);
  // The city picker's own section, rendered once whichever of the two blocks above it applies: it
  // starts one `lg` step below whatever precedes it — a row of travelers, the load-more control or the
  // empty state — while the list body spaces its own cells by `sm`.
  const citiesBlock = (
    <View style={[styles.section, styles.citiesSpacing]}>
      <Text {...SECTION_HEADING} style={styles.heading}>
        {cityLabel === undefined ? 'Browse cities' : 'Browse other cities'}
      </Text>
      {cityNote !== undefined && <Banner tone="error" message={cityNote} action={retryCities} />}
      {cities.isPending ? <Text style={styles.body}>{LOADING}</Text> : null}
      {citiesItems.map((city) => (
        <ListItem key={city.id} {...cityRow(city)} />
      ))}
    </View>
  );
  return (
    <Screen edges={SCREEN_EDGES} scroll={false}>
      <FlatList
        data={rows}
        keyExtractor={(profile) => profile.id}
        renderItem={({ item }) => <ListItem {...travelerRow(item)} />}
        ListHeaderComponent={
          cityLabel === undefined ? (
            <Banner
              testID="proof-banner"
              tone="info"
              message={IMPORT_BANNER}
              action={IMPORT_ACTION}
            />
          ) : (
            <View style={styles.section}>
              <Text {...travelersHeading}>{`Travelers in ${cityLabel}`}</Text>
              {travelersMessage !== undefined && travelersCode !== 'no_valid_proof' && (
                <Banner tone="error" message={travelersMessage} action={retryTravelers} />
              )}
              {travelers.isPending ? <Text style={styles.body}>{LOADING}</Text> : null}
            </View>
          )
        }
        ListFooterComponent={
          <View style={styles.section}>
            {travelers.hasNextPage && (
              <Button {...LOAD_MORE} busy={travelers.isFetchingNextPage} onPress={loadMore} />
            )}
            {travelers.isSuccess && rows.length === 0 && (
              <View style={styles.section}>
                <Text style={styles.body}>{DISCOVERY_EMPTY}</Text>
                <ListItem role="link" label={venuesLabel} onPress={openVenues} />
              </View>
            )}
            {citiesBlock}
          </View>
        }
        contentContainerStyle={styles.listContent}
        style={styles.fill}
        windowSize={LIST_WINDOW_SIZE}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  heading: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.textMuted },
  fill: { flex: 1 },
  listContent: { gap: spacing.sm },
  citiesSpacing: { paddingTop: spacing.sm },
});
