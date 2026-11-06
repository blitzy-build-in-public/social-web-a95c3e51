/**
 * The city page, route `app/cities/[cityId]` (AAP 0.5.8, AAP 0.8.1): one launch city's name and its
 * active partner venues, reached from the Discover picker.
 *
 * `GET /cities/:cityId/venues` needs no proof, so this page is what an unverified traveler still
 * gets, with the import banner standing where the traveler list would be. The travelers read is
 * never requested here in any state: `GET /cities/:cityId/travelers` answers `403 no_valid_proof`
 * without a valid proof for that city and belongs to Discover alone (AAP 0.5.8). The "See travelers
 * in ..." button is offered only when the caller's own proof is valid for this city, which is read
 * from `MeDto.proof.status` and `MeDto.proof.cityId` and never recomputed from the proof's dates.
 *
 * The rows render the payload's own fields in the order the API returned them, with no client-side
 * filtering or re-sorting: the route already returns active partners only, and disclosure is
 * enforced at field level by the API (AAP 0.3.2, AAP 0.5.4). Every failure is both rendered in an
 * error banner and spoken through `announce`, and nothing here logs (AAP 0.5.8, AAP 0.11.1).
 */
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { CityDto, ProofStatus, VenueDto } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { IMPORT_BANNER, VENUES_EMPTY } from '../../src/copy/strings';
import { queryKeys, useMe } from '../../src/state/meetup-store';
import { Banner, Button, ListItem, Screen, announce } from '../../src/ui';

/**
 * The safe-area edges this screen insets by. The stack header owns the top inset and no tab bar is
 * shown on a pushed screen, so claiming the top here would double-count it and the bottom home
 * indicator would be missed (AAP 0.5.8).
 */
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;

/**
 * The section headings' platform attributes: `role="heading"` is what iOS maps to its header trait
 * and Android to its heading role, and `aria-level` is what react-native-web reads to render a real
 * `<h2>` beneath the page title at level 1, which `Screen` asserts itself (AAP 0.5.8).
 */
const SECTION_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/** The heading over the partner-venue list, which is this page's own subject. */
const VENUES_HEADING = 'Partner venues';

/** The announcement and label for a read in flight. */
const LOADING_VENUES = 'Loading venues';

/** The name shown while the cities read holds no record for this route's id. */
const NO_CITY_NAME = 'City';

/**
 * Shown when this route names a city the API does not serve: a slug the cities read does not hold,
 * an absent route parameter, or the `city_not_found` and `invalid_field` answers of AAP 0.5.4.
 */
const CITY_UNAVAILABLE = "This city isn't available.";

/** The error actions' labels. UI labels are not in the fixed-string table of AAP 0.5.8. */
const BACK_TO_DISCOVER = 'Back to Discover';
const TRY_AGAIN = 'Try again';
const VERIFY_STAY = 'Verify my stay';

/**
 * The route's `cityId` as one string. A dynamic route parameter is a string, and an array form is
 * normalized to its first element rather than interpolated, so a repeated query parameter can never
 * reach a request path or a query key as a list.
 */
function normalizeCityId(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/**
 * True only for the `ProofStatus` value that means a currently valid proof (AAP 0.5.5). The
 * comparison is made against the inferred `ProofStatus` type, so a renamed or removed value in
 * `packages/shared/src/enums.ts` fails this file at compile time rather than reopening the gate.
 */
function hasValidProof(status: ProofStatus): boolean {
  return status === 'valid';
}

/**
 * The code of a failed read, for {@link userMessageFor}. The client raises no error type other than
 * `ApiError`; anything else is reported as `network_error`, so neither the server's prose nor any
 * part of the body ever reaches a screen (AAP 0.5.4, AAP 0.11.1).
 */
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'network_error';
}

/** The configured city this route names, or `undefined` while the cities read holds no match. */
function configuredCity(
  cities: readonly CityDto[] | undefined,
  cityId: string,
): CityDto | undefined {
  return cities?.find((candidate) => candidate.id === cityId);
}

/**
 * The OpenStreetMap page for a venue (AAP 0.3.1): the place-data source the product already uses,
 * so no map SDK is added. A venue's coordinates are its own place of business, never a user's
 * (AAP 0.5.7).
 */
function venueMapUrl(venue: VenueDto): string {
  return `https://www.openstreetmap.org/?mlat=${venue.lat}&mlon=${venue.lng}#map=18/${venue.lat}/${venue.lng}`;
}

/**
 * The city page: the city's name, its partner venues, and the way to the traveler list for a caller
 * whose own proof is valid here.
 *
 * Reads made, in order: the configured cities (usually already cached by the Discover picker), this
 * city's active partner venues, and the caller's own account. The traveler list is never requested
 * here. Reading and focus order is source order — page title, traveler access, venue heading, rows —
 * every control carries a visible label with its role, and each failure is rendered and announced.
 *
 * @returns The city page.
 */
export default function CityScreen(): ReactElement {
  const router = useRouter();
  const params = useLocalSearchParams<{ cityId: string | string[] }>();
  const cityId = normalizeCityId(params.cityId);

  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const venues = useQuery({
    queryKey: queryKeys.venues(cityId),
    queryFn: () => apiClient.listVenues(cityId),
    // An absent route parameter is no city to ask about; the key stays stable so the hook runs
    // unconditionally, as the rules of hooks require.
    enabled: cityId !== '',
  });

  const city = configuredCity(cities.data?.items, cityId);
  const cityName = city?.name ?? NO_CITY_NAME;

  const proof = me.data?.proof;
  const proofValidForCity =
    proof !== undefined && hasValidProof(proof.status) && proof.cityId === cityId;

  const venuesCode = venues.error === null ? undefined : errorCodeOf(venues.error);
  // A city the API does not serve: no route parameter, the two answers that say so (`city_not_found`
  // and the `invalid_field` a malformed slug earns), or a cities list that loaded without it.
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

  // Every message this page renders is spoken once: iOS has no live region for a banner, and the
  // sentence spoken is the app's own copy, never server text (AAP 0.5.8, AAP 0.11.1).
  useEffect(() => {
    if (errorMessage !== undefined) announce(errorMessage);
  }, [errorMessage]);

  const rows = venues.data?.items ?? [];

  // Neither control is rendered while the own-profile read is in flight, so the import banner does
  // not flash in front of a traveler whose proof is valid.
  const travelerAccess = me.isPending ? null : proofValidForCity ? (
    <Button
      variant="primary"
      label={`See travelers in ${cityName}`}
      onPress={() => router.push('/discover')}
    />
  ) : (
    <Banner
      testID="proof-banner"
      tone="info"
      message={IMPORT_BANNER}
      action={{ label: VERIFY_STAY, onPress: () => router.push('/proof/import') }}
    />
  );

  const content = cityUnavailable ? (
    <Banner
      tone="error"
      message={CITY_UNAVAILABLE}
      action={{ label: BACK_TO_DISCOVER, onPress: () => router.replace('/discover') }}
    />
  ) : (
    <>
      {travelerAccess}

      <View style={styles.section}>
        <Text {...SECTION_HEADING} style={styles.heading}>
          {VENUES_HEADING}
        </Text>

        {errorMessage === undefined ? null : (
          <Banner
            tone="error"
            message={errorMessage}
            action={{ label: TRY_AGAIN, onPress: () => void venues.refetch() }}
          />
        )}

        {venues.isPending ? (
          <ActivityIndicator accessibilityLabel={LOADING_VENUES} style={styles.loading} />
        ) : null}

        {venues.isSuccess && rows.length === 0 ? (
          <Text style={styles.body}>{VENUES_EMPTY}</Text>
        ) : null}

        {rows.map((venue) => (
          <ListItem
            key={venue.id}
            testID={`venue-${venue.id}`}
            role="link"
            label={venue.name}
            subtitle={venue.address}
            onPress={() => void Linking.openURL(venueMapUrl(venue))}
          />
        ))}
      </View>
    </>
  );

  return (
    <>
      <Stack.Screen options={{ title: cityName }} />
      <Screen title={cityName} edges={SCREEN_EDGES}>
        {content}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  // One gap step inside a section, under the larger step `Screen` puts between its children.
  section: {
    gap: spacing.sm,
  },
  // `text` on `background` is a recorded pair at 17.21:1, and the size is a token rather than a
  // literal, so the heading follows the reader's system font size (AAP 0.5.8).
  heading: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  // The spinner keeps the reading-start edge rather than being stretched across the section.
  loading: {
    alignSelf: 'flex-start',
  },
  // `textMuted` on `background` is a recorded pair at 7.07:1.
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
});
