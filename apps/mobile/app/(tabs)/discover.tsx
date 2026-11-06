/**
 * The Discover tab: traveler discovery for the city a valid proof names, and the city picker that
 * works with and without one (AAP 0.5.8, AAP 0.7.1 row 3).
 *
 * The proof gate is binding. `GET /cities/:cityId/travelers` answers `403 no_valid_proof` to a caller
 * without a valid proof for that city, so this screen unlocks the travelers read from `MeDto.proof`
 * alone — the status has to be the shared enum's valid value and its `cityId` is the city read — and
 * a proof that expires between the two reads is caught by that answer, which drops the own-profile
 * read and returns the screen to the unverified state instead of retrying a request the API refuses.
 * Without a valid proof the import banner stands where the travelers list would be and the city
 * picker remains, because the partner venues behind it need no proof.
 *
 * Every row renders the fields its payload carries and nothing else: discovery is serialized at tier
 * 0 and disclosure is enforced at field level by the API, so the client neither filters a field nor
 * derives one (AAP 0.3.2, criterion 5). A `Tier0Profile` has no photo field, so a row's avatar is
 * always the pattern generated from its seed.
 */
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';
import { router } from 'expo-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { CityDto, ProofStatus, Tier0Profile } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { DISCOVERY_EMPTY, IMPORT_BANNER, formatCalendarDate } from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { Avatar, Banner, Button, ListItem, Screen, announce } from '../../src/ui';

/**
 * The safe-area edges this screen insets by. The tab header and the tab bar own the vertical
 * insets, so claiming them here as well would double-count them (AAP 0.5.8).
 */
const SCREEN_EDGES = ['left', 'right'] as const;

/**
 * The section headings' platform attributes: `role="heading"` is what iOS maps to its header trait
 * and Android to its heading role, and `aria-level` is what react-native-web reads to render a real
 * `<h2>` beneath the tab header's `<h1>` rather than an unlevelled span. `Screen` asserts the same
 * pair for the page title at level 1, so the two levels stay ordered (AAP 0.5.8).
 */
const SECTION_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/** Shown while a read this screen needs has not answered yet. */
const LOADING = 'Loading…';

/** The section heading for a city picker the traveler reaches without a valid proof. */
const CITIES_HEADING = 'Browse cities';

/** The section heading for the same picker once the travelers list stands above it. */
const CITIES_HEADING_BELOW_TRAVELERS = 'Browse other cities';

/**
 * The city the travelers read is keyed under while no valid proof names one. The read is disabled in
 * that state, so the key is never fetched; a stable value is what lets the hook run unconditionally,
 * as the rules of hooks require.
 */
const NO_CITY = '';

/**
 * True only for the `ProofStatus` value that means a currently valid proof (AAP 0.5.5).
 *
 * The comparison is made against the inferred `ProofStatus` type, so a renamed or removed value in
 * `packages/shared/src/enums.ts` fails this file at compile time rather than leaving the gate
 * silently closed forever.
 */
function hasValidProof(status: ProofStatus): boolean {
  return status === 'valid';
}

/**
 * The code of a failed read, for {@link userMessageFor}. The client raises no error type other than
 * `ApiError`, and an answer that is not the error envelope is reported as `invalid_response`, so
 * neither the server's prose nor any part of the body ever reaches a screen (AAP 0.5.4, AAP 0.11.1).
 */
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'invalid_response';
}

/** `1 witnessed meetup` for one, `N witnessed meetups` otherwise (AAP 0.5.8). */
function witnessedMeetupsText(count: number): string {
  return count === 1 ? '1 witnessed meetup' : `${count} witnessed meetups`;
}

/**
 * The configured name of a city, or `undefined` while the cities read has not answered. The slug the
 * profile carries is the fallback, so a heading still names the city if that read failed.
 */
function configuredCityName(
  cities: readonly CityDto[] | undefined,
  cityId: string,
): string | undefined {
  return cities?.find((city) => city.id === cityId)?.name;
}

/**
 * One row's second line: the counters, then the interest tags, then the proof's dates.
 *
 * Only fields the tier-0 payload carries are shown — a tag is rendered with its `_` written as a
 * space, because the vocabulary is snake_case identifiers rather than labels — and the proof dates
 * are the only stay dates any viewer sees (AAP 0.5.4, AAP 0.5.8).
 */
function travelerSubtitle(profile: Tier0Profile): string {
  const parts = [witnessedMeetupsText(profile.reputation.witnessedMeetups)];
  const tags = profile.interestTags.map((tag) => tag.replace(/_/g, ' '));
  if (tags.length > 0) parts.push(tags.join(', '));

  const dates = profile.proofDates;
  if (dates !== null) {
    const from = formatCalendarDate(dates.arrivalDate);
    const to = formatCalendarDate(dates.departureDate);
    parts.push(`${from} – ${to}`);
  }

  return parts.join(' · ');
}

/**
 * Traveler discovery for the city the caller's valid proof names, with the city picker beneath it.
 *
 * The travelers request is made only for a city a valid proof names; the picker is public, so an
 * unverified traveler still reaches each city's partner venues. Every control carries a visible label
 * and its role, the page's reading and focus order is its source order, and each failure is both
 * rendered in an error banner and spoken through `announce` (AAP 0.5.8).
 */
export default function DiscoverScreen(): ReactElement {
  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });

  const proof = me.data?.proof;
  const proofCityId = proof !== undefined && hasValidProof(proof.status) ? proof.cityId : undefined;

  const travelers = useInfiniteQuery({
    // A city the profile does not name is never fetched, so the sentinel key stays inert.
    queryKey: queryKeys.travelers(proofCityId ?? NO_CITY),
    // React Query 5 requires an explicit first page parameter; the API's first page is the one read
    // without a cursor, so an absent cursor is what starts the list (AAP 0.5.4).
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      // `enabled` is what keeps this from running without a city; the guard is what makes the city
      // non-null for the request instead of asserting it.
      if (proofCityId === undefined) return Promise.reject(new Error('no valid proof city'));
      return apiClient.listTravelers(proofCityId, pageParam);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: proofCityId !== undefined,
  });

  const meMessage = me.error === null ? undefined : userMessageFor(errorCodeOf(me.error));
  const citiesMessage =
    cities.error === null ? undefined : userMessageFor(errorCodeOf(cities.error));
  const travelersCode = travelers.error === null ? undefined : errorCodeOf(travelers.error);
  const travelersMessage = travelersCode === undefined ? undefined : userMessageFor(travelersCode);

  // The proof expired between `GET /me` and this read: dropping the own-profile read returns the
  // screen to the unverified state, which is the only state from which the request may be made.
  useEffect(() => {
    if (travelersCode === 'no_valid_proof') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    }
  }, [travelersCode]);

  // Every message this screen renders is spoken once: iOS has no live region for a banner, and the
  // sentence spoken is the app's own copy for the code, never server text (AAP 0.5.8).
  const announcement = meMessage ?? citiesMessage ?? travelersMessage;
  useEffect(() => {
    if (announcement !== undefined) announce(announcement);
  }, [announcement]);

  if (meMessage !== undefined) {
    return (
      <Screen edges={SCREEN_EDGES}>
        <Banner
          tone="error"
          message={meMessage}
          action={{ label: 'Try again', onPress: () => void me.refetch() }}
        />
      </Screen>
    );
  }

  if (me.data === undefined) {
    return (
      <Screen edges={SCREEN_EDGES}>
        <Text style={styles.body}>{LOADING}</Text>
      </Screen>
    );
  }

  const cityLabel =
    proofCityId === undefined
      ? undefined
      : (configuredCityName(cities.data?.items, proofCityId) ?? proofCityId);
  const pages = travelers.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.items);
  const citiesItems = cities.data?.items ?? [];

  return (
    <Screen edges={SCREEN_EDGES}>
      {cityLabel === undefined ? (
        <Banner
          testID="proof-banner"
          tone="info"
          message={IMPORT_BANNER}
          action={{ label: 'Verify my stay', onPress: () => router.push('/proof/import') }}
        />
      ) : null}

      {cityLabel === undefined ? null : (
        <View style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.heading}>{`Travelers in ${cityLabel}`}</Text>

          {travelersMessage !== undefined && travelersCode !== 'no_valid_proof' ? (
            <Banner
              tone="error"
              message={travelersMessage}
              action={{ label: 'Try again', onPress: () => void travelers.refetch() }}
            />
          ) : null}

          {travelers.isPending ? <Text style={styles.body}>{LOADING}</Text> : null}

          {rows.map((profile) => (
            <ListItem
              key={profile.id}
              testID={`traveler-${profile.id}`}
              role="link"
              label={profile.handle}
              subtitle={travelerSubtitle(profile)}
              leading={
                <Avatar avatarSeed={profile.avatarSeed} handle={profile.handle} decorative />
              }
              onPress={() => router.push(`/users/${profile.id}`)}
            />
          ))}

          {travelers.hasNextPage ? (
            <Button
              variant="secondary"
              label="Show more travelers"
              busy={travelers.isFetchingNextPage}
              onPress={() => void travelers.fetchNextPage()}
            />
          ) : null}

          {travelers.isSuccess && rows.length === 0 ? (
            <>
              <Text style={styles.body}>{DISCOVERY_EMPTY}</Text>
              <ListItem
                role="link"
                label={`See partner venues in ${cityLabel}`}
                onPress={() => router.push(`/cities/${proofCityId ?? NO_CITY}`)}
              />
            </>
          ) : null}
        </View>
      )}

      <View style={styles.section}>
        <Text {...SECTION_HEADING} style={styles.heading}>
          {cityLabel === undefined ? CITIES_HEADING : CITIES_HEADING_BELOW_TRAVELERS}
        </Text>

        {citiesMessage !== undefined ? (
          <Banner
            tone="error"
            message={citiesMessage}
            action={{ label: 'Try again', onPress: () => void cities.refetch() }}
          />
        ) : null}

        {cities.isPending ? <Text style={styles.body}>{LOADING}</Text> : null}

        {citiesItems.map((city) => (
          <ListItem
            key={city.id}
            testID={`city-${city.id}`}
            role="link"
            label={city.name}
            subtitle={city.countryCode}
            onPress={() => router.push(`/cities/${city.id}`)}
          />
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // One gap step inside a section, under the larger step `Screen` puts between the sections.
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
  // `textMuted` on `background` is a recorded pair at 7.07:1.
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
});
