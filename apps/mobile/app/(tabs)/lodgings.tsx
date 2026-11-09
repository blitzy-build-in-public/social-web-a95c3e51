/**
 * Lodgings — the city directory and leaderboard (AAP 0.5.8, AAP 0.8.1, criterion 15).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { FlatList, Linking, StyleSheet, Text, View, type TextProps } from 'react-native';
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
import { Banner, Chip, ListItem, Screen, announce, useAppNoticeMessage } from '../../src/ui';

const styles = StyleSheet.create({
  heading: { ...typography.heading, color: colors.text, fontWeight: fontWeights.bold },
  note: { ...typography.body, color: colors.textMuted },
  sortRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  // `marginLeft: 'auto'` is what puts these figures on the row's right edge once the row wraps and
  // this block is alone on the line below the text column: that line's free space goes to the auto
  // margin. Unwrapped it moves nothing — the column's `flex: 1` absorbs that free space before an
  // auto margin receives any — and a layout keyword is no measurement, so the entry's values stay
  // design tokens.
  trailing: { alignItems: 'flex-end', gap: spacing.xs, marginLeft: 'auto' },
  trailingText: { ...typography.body, color: colors.textMuted },
  fill: { flex: 1 },
  // The block spacing the screen's content container gives every child: a row sits flush against the
  // next one, its own hairline separating them, so the header and the footer carry it instead.
  listHeader: { gap: spacing.lg, paddingBottom: spacing.lg },
  listFooter: { paddingTop: spacing.lg },
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
  name: 'Lodgings',
};
const OPEN_OSM = (): void => void Linking.openURL(OSM_COPYRIGHT_URL);
const IMPORT_ACTION = { label: 'Verify my stay', onPress: () => router.push('/proof/import') };
/**
 * The narrowest a lodging row's text column is allowed to become, in points / CSS px: eight `xxl`
 * steps, 256 px. The activity and guest block beside it is about 200 px wide, so below the width that
 * leaves a column this wide the row stacks — the block drops under the text and the name, the address
 * and the phone number each keep a readable measure at the app's own 375-point width, where the row's
 * padding leaves 343 px to share.
 */
const LODGING_TEXT_MIN_WIDTH = spacing.xxl * 8;
/**
 * How many viewports of rows the directory keeps mounted: the rows on screen plus about half a screen
 * either side of them. A city's directory arrives in one read and can hold every hostel, hotel and
 * guest house in the city, so the list mounts a couple of screens of it and mounts the rest as the
 * reader scrolls, instead of the whole directory at once.
 */
const LIST_WINDOW_SIZE = 2;
type Heading = TextProps & Readonly<{ 'aria-level': number }>;
const HEADING: Heading = { role: 'heading', 'aria-level': 2 };
const cityMissing = (): Promise<never> => Promise.reject(new Error(COPY.noCity));
function readFailureMessage(error: unknown): string {
  return userMessageFor(isApiError(error) ? error.code : 'invalid_response');
}
function panel(child: ReactElement | null): ReactElement {
  return <Screen edges={TAB_EDGES}>{child}</Screen>;
}
function lodgingRow(lodging: LodgingSummary): ReactElement {
  const guests = guestCountText(lodging.guestCount);
  const details = [KIND_LABELS[lodging.kind], lodging.address, lodging.phone]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' · ');
  return (
    <ListItem
      label={`#${lodging.rank} ${lodging.name}`}
      subtitle={details}
      onPress={() => router.push(`/lodgings/${lodging.id}`)}
      role="link"
      testID={`lodging-${lodging.id}`}
      textMinWidth={LODGING_TEXT_MIN_WIDTH}
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
  const noticeMessage = useAppNoticeMessage();
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
  const retry = { label: COPY.tryAgain, onPress: () => void me.refetch(), busy: me.isFetching };
  const retryListing = {
    label: COPY.tryAgain,
    onPress: () => void lodgings.refetch(),
    busy: lodgings.isFetching,
  };
  useEffect(() => {
    const message = meError ?? (proofRefused ? null : dirMessage);
    if (message !== null) announce(message);
  }, [meError, dirMessage, proofRefused]);
  useEffect(() => {
    if (proofRefused) void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [proofRefused]);
  if (me.isPending)
    return panel(noticeMessage === null ? <Text style={styles.note}>{'Loading…'}</Text> : null);
  if (meError !== null) return panel(<Banner tone="error" message={meError} action={retry} />);
  if (cityId === undefined || proofRefused)
    return panel(
      <Banner tone="info" message={IMPORT_BANNER} action={IMPORT_ACTION} testID="proof-banner" />,
    );
  // The city list is the only source of a display name: the proof carries a city id, a slug such as
  // `mexico-city`, and a slug is never painted. The section's own name stands in until the list
  // answers, and stays it when the list settles without that city.
  const cityName = cities.data?.items.find((city) => city.id === cityId)?.name;
  const heading = cityName === undefined ? COPY.name : `${COPY.name} in ${cityName}`;
  const items = lodgings.data?.items ?? [];
  // An error supersedes the rows, the empty state and the loading notice; a directory that has not
  // answered yet is not an empty one, so the reader sees the notice this screen already shows while it
  // waits until the query has settled and the empty state only when the server returns no rows.
  const rows = dirMessage === null ? items : [];
  const waiting = <Text style={styles.note}>{'Loading…'}</Text>;
  const settledNotice = lodgings.isSuccess ? NO_ROWS : waiting;
  const emptyState = dirMessage === null && rows.length === 0 ? settledNotice : null;
  // With no rows the header's own bottom step is already the gap above the attribution row.
  const footerStyle = rows.length === 0 ? undefined : styles.listFooter;
  return (
    <Screen edges={TAB_EDGES} scroll={false}>
      <FlatList
        data={rows}
        keyExtractor={(lodging) => lodging.id}
        renderItem={({ item }) => lodgingRow(item)}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text {...HEADING} style={styles.heading}>
              {heading}
            </Text>
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
            {dirMessage !== null && (
              <Banner tone="error" message={dirMessage} action={retryListing} />
            )}
            {emptyState}
          </View>
        }
        ListFooterComponent={
          <View style={footerStyle}>
            <ListItem
              label={OSM_ATTRIBUTION}
              onPress={OPEN_OSM}
              role="link"
              testID="osm-attribution"
            />
          </View>
        }
        style={styles.fill}
        windowSize={LIST_WINDOW_SIZE}
      />
    </Screen>
  );
}
