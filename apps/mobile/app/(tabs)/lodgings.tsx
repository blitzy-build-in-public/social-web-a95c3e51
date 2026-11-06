/**
 * Lodgings — the city directory and leaderboard (AAP 0.5.8, AAP 0.8.1, criterion 15).
 *
 * The directory is gated on the caller's own itinerary proof: `GET /cities/:cityId/lodgings`
 * answers `403 no_valid_proof` without a valid proof for the city, so a traveller who has not
 * imported a booking sees only the import banner and this screen never issues that request
 * (AAP 0.5.8 "Browsing without a valid proof").
 *
 * The order is the server's: `rank`, the witnessed-meetup `activityScore` and the 60-second
 * leaderboard cache belong to the API (AAP 0.5.7), so no row is re-sorted or filtered here. A
 * verified guest count below three never arrives as a number — it arrives as `'fewer than 3'` and
 * is printed verbatim, so no reader can single out the one or two travelers staying somewhere
 * (AAP 0.5.4). Lodgings compete on witnessed-meetup activity alone: ratings, reviews and comments
 * have no place here (AAP 0.7.2).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Linking, StyleSheet, Text, View, type TextProps } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { LodgingKind, LodgingSort, LodgingSummary, ProofStatus } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import {
  IMPORT_BANNER,
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  guestCountText,
} from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { Banner, Button, ListItem, Screen, announce } from '../../src/ui';

/** The one proof state that unlocks a city's directory (AAP 0.5.5). */
const VALID_PROOF_STATUS = 'valid' satisfies ProofStatus;

/** The safe-area edges a tab screen claims; the navigator's header and tab bar own the others. */
const TAB_EDGES = ['left', 'right'] as const;

/** The directory's two orders; the API validates the same closed set (AAP 0.5.4). */
const SORT_LABELS = {
  activity: 'Most active',
  name: 'A–Z',
} as const satisfies Record<LodgingSort, string>;

/** The kind label shown under a lodging's name, from OpenStreetMap's `tourism` tags (AAP 0.5.6). */
const KIND_LABELS = {
  hostel: 'Hostel',
  hotel: 'Hotel',
  guesthouse: 'Guesthouse',
} as const satisfies Record<LodgingKind, string>;

/** What the ranking means, shown under the heading (AAP 0.5.7). */
const RANKING_NOTE = 'Ranked by witnessed meetups among verified guests over the last 90 days.';

/** The directory with nothing to list (AAP 0.5.8). */
const LODGINGS_EMPTY = 'No lodgings listed in this city yet.';

/** Shown while the caller's own account is being read. */
const LOADING = 'Loading…';

/** The import banner's action, and the sentence a read failure offers (AAP 0.5.8). */
const VERIFY_MY_STAY = 'Verify my stay';
const TRY_AGAIN = 'Try again';

/**
 * Said of the sort the screen holds. `Button` exposes its visible label as the whole accessible
 * name and carries no selected state, so the two orders are told apart by their names and by the
 * selected one's primary variant; this hint adds the state where React Native forwards a hint.
 */
const SELECTED_HINT = 'Selected';

/** Raised only by a wiring mistake: the directory query is never enabled without a city. */
const NO_CITY = 'The lodgings query was enabled without a city.';

/**
 * The heading's attributes. The tab navigator's header renders the page's level-one heading from
 * the tab's title, so the sentence this screen prints sits beneath it at level 2: `role="heading"`
 * is the platform's header trait, and `aria-level` is what react-native-web 0.19 reads to render a
 * real `<h2>` rather than an unlevelled span, asserted here because React Native's `TextProps` does
 * not list it.
 */
const HEADING_ATTRIBUTES: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/** The sentence a failed read shows: the API code's copy, or the fallback for an unknown failure. */
function readFailureMessage(error: unknown): string {
  return userMessageFor(isApiError(error) ? error.code : 'invalid_response');
}

/**
 * One directory row: the rank and name, the kind with the address and the lodging's business phone
 * when it has them, then the activity score and the verified guest count. The phone is the
 * lodging's own number — a business contact, never a traveler's — and is printed as text rather
 * than nested inside the row's pressable.
 */
function lodgingRow(lodging: LodgingSummary): ReactElement {
  const details = [KIND_LABELS[lodging.kind], lodging.address, lodging.phone].filter(
    (part): part is string => part !== null && part.trim() !== '',
  );

  return (
    <ListItem
      key={lodging.id}
      label={`#${lodging.rank} ${lodging.name}`}
      subtitle={details.join(' · ')}
      onPress={() => {
        router.push(`/lodgings/${lodging.id}`);
      }}
      role="link"
      testID={`lodging-${lodging.id}`}
      trailing={
        <View style={styles.trailing}>
          <Text style={styles.trailingText}>{`Activity ${lodging.activityScore}`}</Text>
          <Text style={styles.trailingText}>
            {`Verified guests: ${guestCountText(lodging.guestCount)}`}
          </Text>
        </View>
      }
    />
  );
}

/**
 * The Lodgings tab: the city's lodgings by witnessed-meetup activity or by name.
 *
 * @returns The import banner for a traveller without a valid proof for a city, or that city's
 * directory with the OpenStreetMap attribution (AAP 0.3.1, AAP 0.5.8).
 */
export default function LodgingsScreen(): ReactElement {
  const [sort, setSort] = useState<LodgingSort>('activity');
  const me = useMe();

  const proof = me.data?.proof;
  // The gate: a city exists here only while the caller holds a valid proof for it, so the
  // directory query below cannot be enabled for a city the API would refuse.
  const cityId = proof?.status === VALID_PROOF_STATUS ? proof.cityId : undefined;

  // Read for the heading's name; public, so it never needs the proof.
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });

  const lodgings = useQuery({
    // An empty city keeps one stable key while the query stays disabled.
    queryKey: queryKeys.lodgings(cityId ?? '', sort),
    queryFn: () => {
      if (cityId === undefined) return Promise.reject(new Error(NO_CITY));
      return apiClient.listLodgings(cityId, sort);
    },
    enabled: cityId !== undefined,
  });

  const meMessage = me.error === null ? null : readFailureMessage(me.error);
  const lodgingsMessage = lodgings.error === null ? null : readFailureMessage(lodgings.error);
  // Disclosure is enforced at field level by the API, so this refusal means the proof the gate
  // above rests on is gone: the own-account read is refreshed and the import banner takes over.
  const proofRefused = isApiError(lodgings.error) && lodgings.error.code === 'no_valid_proof';

  // A failure the proof banner does not already explain is spoken as well as shown (AAP 0.5.8).
  useEffect(() => {
    const message = meMessage ?? (proofRefused ? null : lodgingsMessage);
    if (message !== null) announce(message);
  }, [meMessage, lodgingsMessage, proofRefused]);

  useEffect(() => {
    if (proofRefused) void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [proofRefused]);

  if (me.isPending) {
    return (
      <Screen edges={TAB_EDGES}>
        <Text style={styles.note}>{LOADING}</Text>
      </Screen>
    );
  }

  if (meMessage !== null) {
    return (
      <Screen edges={TAB_EDGES}>
        <Banner
          tone="error"
          message={meMessage}
          action={{
            label: TRY_AGAIN,
            onPress: () => {
              void me.refetch();
            },
          }}
        />
      </Screen>
    );
  }

  if (cityId === undefined || proofRefused) {
    return (
      <Screen edges={TAB_EDGES}>
        <Banner
          tone="info"
          message={IMPORT_BANNER}
          action={{
            label: VERIFY_MY_STAY,
            onPress: () => {
              router.push('/proof/import');
            },
          }}
          testID="proof-banner"
        />
      </Screen>
    );
  }

  const cityName = cities.data?.items.find((city) => city.id === cityId)?.name ?? cityId;
  const items = lodgings.data?.items ?? [];

  const directory =
    lodgingsMessage !== null ? (
      <Banner
        tone="error"
        message={lodgingsMessage}
        action={{
          label: TRY_AGAIN,
          onPress: () => {
            void lodgings.refetch();
          },
        }}
      />
    ) : items.length === 0 ? (
      <Text style={styles.note}>{LODGINGS_EMPTY}</Text>
    ) : (
      <View>{items.map(lodgingRow)}</View>
    );

  return (
    <Screen edges={TAB_EDGES}>
      <Text {...HEADING_ATTRIBUTES} style={styles.heading}>
        {`Lodgings in ${cityName}`}
      </Text>
      <Text style={styles.note}>{RANKING_NOTE}</Text>
      <View style={styles.sortRow}>
        <Button
          label={SORT_LABELS.activity}
          variant={sort === 'activity' ? 'primary' : 'secondary'}
          {...(sort === 'activity' ? { hint: SELECTED_HINT } : {})}
          onPress={() => setSort('activity')}
          testID="lodgings-sort-activity"
        />
        <Button
          label={SORT_LABELS.name}
          variant={sort === 'name' ? 'primary' : 'secondary'}
          {...(sort === 'name' ? { hint: SELECTED_HINT } : {})}
          onPress={() => setSort('name')}
          testID="lodgings-sort-name"
        />
      </View>
      {directory}
      <ListItem
        label={OSM_ATTRIBUTION}
        onPress={() => {
          void Linking.openURL(OSM_COPYRIGHT_URL);
        }}
        role="link"
        testID="osm-attribution"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: {
    color: colors.text,
    fontSize: typography.heading.fontSize,
    lineHeight: typography.heading.lineHeight,
    fontWeight: fontWeights.bold,
  },
  note: {
    ...typography.body,
    color: colors.textMuted,
  },
  sortRow: {
    // The two orders wrap rather than shrink, so a reader's enlarged font cannot clip a label.
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  trailingText: {
    ...typography.body,
    color: colors.textMuted,
  },
});
