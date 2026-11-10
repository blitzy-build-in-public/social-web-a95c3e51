/** The city page, route `app/cities/[cityId]`: one launch city's name and its active partner venues, reached from the Discover picker. Whether the page offers the traveler list is decided by the caller's entitlement, never by the single stay `MeDto.proof` reports. */
import { useEffect, type ReactElement } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View, type TextProps } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { colors, fontWeights, spacing, typography, type VenueDto } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor, type ClientErrorCode } from '../../src/api/errors';
import { IMPORT_BANNER, VENUES_EMPTY } from '../../src/copy/strings';
import { queryKeys, useMe } from '../../src/state/meetup-store';
import {
  Banner,
  Button,
  ListItem,
  Screen,
  announce,
  useAppNoticeMessage,
  type ListItemProps,
} from '../../src/ui';

type Heading = TextProps & Readonly<{ 'aria-level': number }>;
const SECTION_HEADING: Heading = { role: 'heading', 'aria-level': 2 };
const VENUES_HEADING = 'Partner venues';
const LOADING_VENUES = 'Loading venues';
const LOADING = 'Loading…';
const NO_CITY_NAME = 'City';
const CITY_UNAVAILABLE = "This city isn't available.";
const BACK_TO_DISCOVER = 'Back to Discover';
const TRY_AGAIN = 'Try again';
const VERIFY_STAY = 'Verify my stay';
const TRAVELER_BUTTON = { variant: 'primary' } as const;
const VERIFY_ACTION = { label: VERIFY_STAY, onPress: () => router.push('/proof/import') };
const BACK_ACTION = { label: BACK_TO_DISCOVER, onPress: () => router.replace('/discover') };
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'network_error';
}
function venueMapUrl(venue: VenueDto): string {
  return `https://www.openstreetmap.org/?mlat=${venue.lat}&mlon=${venue.lng}#map=18/${venue.lat}/${venue.lng}`;
}
function venueRow(venue: VenueDto): ListItemProps {
  return {
    testID: `venue-${venue.id}`,
    role: 'link',
    label: venue.name,
    subtitle: venue.address,
    onPress: () => void Linking.openURL(venueMapUrl(venue)),
  };
}
/* Every message this page renders is spoken once, and never as server text (AAP 0.5.8, AAP 0.11.1). */
export default function CityScreen(): ReactElement {
  const params = useLocalSearchParams<{ cityId: string | string[] }>();
  const cityId = Array.isArray(params.cityId) ? (params.cityId[0] ?? '') : (params.cityId ?? '');
  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const venues = useQuery({
    queryKey: queryKeys.venues(cityId),
    queryFn: () => apiClient.listVenues(cityId),
    enabled: cityId !== '',
  });
  const city = cities.data?.items.find((candidate) => candidate.id === cityId);
  const cityName = city?.name ?? NO_CITY_NAME;
  // Entitlement, not the single proof: the caller may hold valid proofs for several cities, and a payload cached before the field existed carries no set, so the unverified banner shows as before.
  const proofValidForCity = (me.data?.validCityIds ?? []).includes(cityId);
  const venuesCode = venues.error === null ? undefined : errorCodeOf(venues.error);
  const cityUnavailable =
    cityId === '' ||
    venuesCode === 'city_not_found' ||
    venuesCode === 'invalid_field' ||
    (cities.isSuccess && city === undefined);
  const errorMessage = cityUnavailable
    ? CITY_UNAVAILABLE
    : venuesCode === undefined
      ? undefined
      : userMessageFor(venuesCode);
  useEffect(() => {
    if (errorMessage !== undefined) announce(errorMessage);
  }, [errorMessage]);
  const rows = venues.data?.items ?? [];
  // The proof area's height is unknown until `me` answers, so the venues section is not painted while that read is pending; while the app-level notice speaks, the page leaves its own loading placeholder out.
  const appNotice = useAppNoticeMessage();
  const sessionUnreachable = appNotice !== null;
  const retry = { label: TRY_AGAIN, onPress: () => void venues.refetch(), busy: venues.isFetching };
  const content = cityUnavailable ? (
    <Banner tone="error" message={CITY_UNAVAILABLE} action={BACK_ACTION} />
  ) : (
    <>
      {me.isPending ? (
        sessionUnreachable ? null : (
          <Text style={styles.body}>{LOADING}</Text>
        )
      ) : proofValidForCity ? (
        <Button
          {...TRAVELER_BUTTON}
          label={`See travelers in ${cityName}`}
          onPress={() => router.push(`/discover?cityId=${cityId}`)}
        />
      ) : (
        <Banner testID="proof-banner" tone="info" message={IMPORT_BANNER} action={VERIFY_ACTION} />
      )}
      {me.isPending && !sessionUnreachable ? null : (
        <View style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.heading} children={VENUES_HEADING} />
          {errorMessage !== undefined && (
            <Banner tone="error" message={errorMessage} action={retry} />
          )}
          {venues.isPending && !sessionUnreachable && (
            <ActivityIndicator
              accessibilityLabel={LOADING_VENUES}
              color={colors.primary}
              style={styles.loading}
            />
          )}
          {venues.isSuccess && rows.length === 0 && <Text style={styles.body}>{VENUES_EMPTY}</Text>}
          {rows.map((venue) => (
            <ListItem key={venue.id} {...venueRow(venue)} />
          ))}
        </View>
      )}
    </>
  );
  return (
    <>
      <Stack.Screen options={{ title: cityName }} />
      <Screen edges={['left', 'right', 'bottom']} children={content} />
    </>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  heading: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  loading: { alignSelf: 'flex-start' },
  body: { ...typography.body, color: colors.textMuted },
});
