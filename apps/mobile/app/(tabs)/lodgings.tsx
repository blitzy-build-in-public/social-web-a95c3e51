/**
 * Lodgings — the city directory and leaderboard (AAP 0.5.8, AAP 0.8.1, criterion 15).
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
import { Banner, Chip, ListItem, Screen, announce } from '../../src/ui';

const styles = StyleSheet.create({
  heading: { ...typography.heading, color: colors.text, fontWeight: fontWeights.bold },
  note: { ...typography.body, color: colors.textMuted },
  sortRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  trailing: { alignItems: 'flex-end', gap: spacing.xs },
  trailingText: { ...typography.body, color: colors.textMuted },
});
const VALID_PROOF_STATUS = 'valid' satisfies ProofStatus;
const TAB_EDGES = ['left', 'right'] as const;
type SortLabels = Record<LodgingSort, string>;
const SORT_LABELS = { activity: 'Most active', name: 'A–Z' } as const satisfies SortLabels;
/**
 * The name of the sort row, which is a `radiogroup`: axe's `aria-required-parent` rule requires the
 * radio chips to sit inside a named group, and VoiceOver and TalkBack announce it with them.
 */
const SORT_GROUP_LABEL = 'Sort lodgings';
const KIND_LABELS = {
  hostel: 'Hostel',
  hotel: 'Hotel',
  guesthouse: 'Guesthouse',
} as const satisfies Record<LodgingKind, string>;
const COPY = {
  ranking: 'Ranked by witnessed meetups among verified guests over the last 90 days.',
  empty: 'No lodgings listed in this city yet.',
  noCity: 'The lodgings query was enabled without a city.',
  tryAgain: 'Try again',
};
const OPEN_OSM = (): void => void Linking.openURL(OSM_COPYRIGHT_URL);
const IMPORT_ACTION = { label: 'Verify my stay', onPress: () => router.push('/proof/import') };
type Heading = TextProps & Readonly<{ 'aria-level': number }>;
const HEADING: Heading = { role: 'heading', 'aria-level': 2 };
const cityMissing = (): Promise<never> => Promise.reject(new Error(COPY.noCity));
function readFailureMessage(error: unknown): string {
  return userMessageFor(isApiError(error) ? error.code : 'invalid_response');
}
function panel(child: ReactElement): ReactElement {
  return <Screen edges={TAB_EDGES}>{child}</Screen>;
}
function lodgingRow(lodging: LodgingSummary): ReactElement {
  const guests = guestCountText(lodging.guestCount);
  const details = [KIND_LABELS[lodging.kind], lodging.address, lodging.phone]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' · ');
  return (
    <ListItem
      key={lodging.id}
      label={`#${lodging.rank} ${lodging.name}`}
      subtitle={details}
      onPress={() => router.push(`/lodgings/${lodging.id}`)}
      role="link"
      testID={`lodging-${lodging.id}`}
      trailing={
        <View style={styles.trailing}>
          <Text style={styles.trailingText}>{`Activity ${lodging.activityScore}`}</Text>
          <Text style={styles.trailingText}>{`Verified guests: ${guests}`}</Text>
        </View>
      }
    />
  );
}
const NO_ROWS = <Text style={styles.note}>{COPY.empty}</Text>;
export default function LodgingsScreen(): ReactElement {
  const [sort, setSort] = useState<LodgingSort>('activity');
  const me = useMe();
  const cityId = me.data?.proof.status === VALID_PROOF_STATUS ? me.data.proof.cityId : undefined;
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const lodgings = useQuery({
    queryKey: queryKeys.lodgings(cityId ?? '', sort),
    queryFn: () => (cityId === undefined ? cityMissing() : apiClient.listLodgings(cityId, sort)),
    enabled: cityId !== undefined,
  });
  const meError = me.error === null ? null : readFailureMessage(me.error);
  const dirMessage = lodgings.error === null ? null : readFailureMessage(lodgings.error);
  const proofRefused = isApiError(lodgings.error) && lodgings.error.code === 'no_valid_proof';
  const retry = { label: COPY.tryAgain, onPress: () => void me.refetch() };
  const retryListing = { label: COPY.tryAgain, onPress: () => void lodgings.refetch() };
  useEffect(() => {
    const message = meError ?? (proofRefused ? null : dirMessage);
    if (message !== null) announce(message);
  }, [meError, dirMessage, proofRefused]);
  useEffect(() => {
    if (proofRefused) void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [proofRefused]);
  if (me.isPending) return panel(<Text style={styles.note}>{'Loading…'}</Text>);
  if (meError !== null) return panel(<Banner tone="error" message={meError} action={retry} />);
  if (cityId === undefined || proofRefused)
    return panel(
      <Banner tone="info" message={IMPORT_BANNER} action={IMPORT_ACTION} testID="proof-banner" />,
    );
  const cityName = cities.data?.items.find((city) => city.id === cityId)?.name ?? cityId;
  const items = lodgings.data?.items ?? [];
  return (
    <Screen edges={TAB_EDGES}>
      <Text {...HEADING} style={styles.heading}>{`Lodgings in ${cityName}`}</Text>
      <Text style={styles.note}>{COPY.ranking}</Text>
      <View role="radiogroup" aria-label={SORT_GROUP_LABEL} style={styles.sortRow}>
        <Chip
          label={SORT_LABELS.activity}
          selected={sort === 'activity'}
          onPress={() => setSort('activity')}
          testID="lodgings-sort-activity"
        />
        <Chip
          label={SORT_LABELS.name}
          selected={sort === 'name'}
          onPress={() => setSort('name')}
          testID="lodgings-sort-name"
        />
      </View>
      {dirMessage !== null && <Banner tone="error" message={dirMessage} action={retryListing} />}
      {dirMessage === null && (items.length === 0 ? NO_ROWS : <View>{items.map(lodgingRow)}</View>)}
      <ListItem label={OSM_ATTRIBUTION} onPress={OPEN_OSM} role="link" testID="osm-attribution" />
    </Screen>
  );
}
