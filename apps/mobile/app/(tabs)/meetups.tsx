/** The Meetups tab: the caller's own meetups, newest first, and the entry point to every meetup screen. */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { MeetupDto, MeetupStatus, NextAction, ParticipantRole } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { CHECKED_IN_NOTICE } from '../../src/copy/strings';
import { meetupsInPages, queryKeys, useMeetups } from '../../src/state/meetup-store';
import {
  Avatar,
  Banner,
  Button,
  Chip,
  ListItem,
  Screen,
  announce,
  useAppNoticeMessage,
} from '../../src/ui';
const CITIES_STALE_TIME_MS = 60 * 60 * 1000;
/** How many viewports of rows the tab keeps mounted: the rows on screen plus about half a screen either side. */
const LIST_WINDOW_SIZE = 2;
const START_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};
const UTC_TIME_FORMAT: Intl.DateTimeFormatOptions = { ...START_TIME_FORMAT, timeZone: 'UTC' };
export const STATUS_LABEL = {
  proposed: 'Proposed',
  locked: 'Seats held',
  declined: 'Declined',
  lapsed: 'Lapsed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  forfeited: 'Deposit forfeited',
  unattended: 'Nobody checked in',
  lock_lost: 'Card hold ended',
  no_fault: 'Closed without penalty',
} as const satisfies Record<MeetupStatus, string>;
export const NEXT_ACTION_HINT = {
  confirm_hold: 'Confirm your card hold',
  retry_hold: 'Retry your card hold',
  accept: 'Review and accept',
  check_in: 'Check in at the venue',
  none: null,
} as const satisfies Record<NextAction, string | null>;
export const ROLE_LABEL = {
  initiator: 'You proposed',
  recipient: 'Proposed to you',
} as const satisfies Record<ParticipantRole, string>;
export type MeetupFilter = 'all' | 'proposed_to_me' | 'mine';
export interface MeetupFilterSpec {
  readonly label: string;
  readonly testID: string;
  readonly role?: ParticipantRole;
  readonly status?: MeetupStatus;
}
export const MEETUP_FILTERS: Record<MeetupFilter, MeetupFilterSpec> = {
  all: { label: 'All', testID: 'meetups-filter-all' },
  proposed_to_me: {
    label: 'Proposed to me',
    testID: 'meetups-filter-proposed-to-me',
    role: 'recipient',
    status: 'proposed',
  },
  mine: { label: 'Mine', testID: 'meetups-filter-mine', role: 'initiator' },
};
const FILTER_ORDER: readonly MeetupFilter[] = ['all', 'proposed_to_me', 'mine'];
const DISCOVER = { label: 'Find travelers on Discover', testID: 'meetups-discover' };
const SHOW_MORE = { label: 'Show more meetups', testID: 'meetups-show-more' };
/** The filter row is a `radiogroup`: axe's `aria-required-parent` rule requires the radio chips to sit in a named group, and VoiceOver and TalkBack announce it with them. */
const FILTER_GROUP_LABEL = 'Filter meetups';
export function formatStart(iso: string, timeZone?: string): string {
  const start = new Date(iso);
  if (timeZone !== undefined) {
    try {
      return new Intl.DateTimeFormat('en-US', { ...START_TIME_FORMAT, timeZone }).format(start);
    } catch {}
  }
  try {
    return `${new Intl.DateTimeFormat('en-US', UTC_TIME_FORMAT).format(start)} UTC`;
  } catch {
    return iso;
  }
}
function messageFor(error: unknown): string {
  return isApiError(error) ? userMessageFor(error.code) : userMessageFor('invalid_response');
}
function meetupRow(meetup: MeetupDto, cityZones: ReadonlyMap<string, string>): ReactElement {
  const counterpart = meetup.counterpart;
  const hasPhoto = 'hasPhoto' in counterpart && counterpart.hasPhoto;
  const nextAction = NEXT_ACTION_HINT[meetup.nextAction];
  const zone = cityZones.get(meetup.venue.cityId);
  const where = `${meetup.venue.name} · ${formatStart(meetup.startsAt, zone)}`;
  const subtitle = [where, STATUS_LABEL[meetup.status], ROLE_LABEL[meetup.role]];
  if (meetup.checkedIn) subtitle.push(CHECKED_IN_NOTICE);
  return (
    <ListItem
      testID={`meetup-${meetup.id}`}
      role="link"
      onPress={() => router.push(`/meetups/${meetup.id}`)}
      label={counterpart.handle}
      leading={
        <Avatar
          avatarSeed={counterpart.avatarSeed}
          handle={counterpart.handle}
          decorative
          {...(hasPhoto ? { userId: counterpart.id, hasPhoto: true } : {})}
        />
      }
      subtitle={subtitle.join(' · ')}
      trailing={nextAction === null ? undefined : <Text style={styles.trailing}>{nextAction}</Text>}
    />
  );
}
export default function MeetupsScreen(): ReactElement {
  const [filter, setFilter] = useState<MeetupFilter>('all');
  const noticeMessage = useAppNoticeMessage();
  const active = MEETUP_FILTERS[filter];
  const meetups = useMeetups(active.role, active.status);
  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: CITIES_STALE_TIME_MS,
  });
  const cityZones = useMemo(
    () => new Map((cities.data?.items ?? []).map((city) => [city.id, city.timezone] as const)),
    [cities.data],
  );
  const items = meetups.data === undefined ? [] : meetupsInPages(meetups.data.pages);
  const errorMessage = meetups.isError ? messageFor(meetups.error) : null;
  const hasRows = items.length > 0;
  // While the API is unreachable the read stays pending, so the loading line yields to the app notice that already reports the failure.
  const showLoading =
    !hasRows && errorMessage === null && noticeMessage === null && meetups.isPending;
  const showEmpty = !hasRows && errorMessage === null && !meetups.isPending;
  const paging = meetups.isFetchingNextPage;
  const retry = () => void meetups.refetch();
  const showMore = () => void meetups.fetchNextPage();
  const retryAction = {
    label: 'Try again',
    onPress: retry,
    busy: meetups.isFetching,
    testID: 'meetups-retry',
  };
  useEffect(() => {
    if (errorMessage !== null) announce(errorMessage);
  }, [errorMessage]);
  return (
    <Screen edges={['left', 'right']} scroll={false}>
      <FlatList
        data={items}
        keyExtractor={(meetup) => meetup.id}
        renderItem={({ item }) => meetupRow(item, cityZones)}
        ListHeaderComponent={
          <View style={styles.header}>
            <View role="radiogroup" aria-label={FILTER_GROUP_LABEL} style={styles.filters}>
              {FILTER_ORDER.map((id) => (
                <Chip
                  key={id}
                  label={MEETUP_FILTERS[id].label}
                  selected={id === filter}
                  onPress={() => setFilter(id)}
                  testID={MEETUP_FILTERS[id].testID}
                />
              ))}
            </View>
            {errorMessage === null ? null : (
              <Banner
                tone="error"
                message={errorMessage}
                action={retryAction}
                testID="meetups-error"
              />
            )}
            {showLoading ? <Text style={styles.notice}>Loading…</Text> : null}
            {showEmpty ? (
              <View style={styles.emptyState}>
                <Text style={styles.notice}>No meetups yet.</Text>
                <ListItem {...DISCOVER} role="link" onPress={() => router.navigate('/discover')} />
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={
          meetups.hasNextPage ? (
            <Button {...SHOW_MORE} variant="secondary" busy={paging} onPress={showMore} />
          ) : null
        }
        contentContainerStyle={styles.listContent}
        style={styles.fill}
        windowSize={LIST_WINDOW_SIZE}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  notice: { ...typography.body, color: colors.textMuted },
  emptyState: { gap: spacing.sm },
  trailing: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: fontWeights.medium,
    flexShrink: 1,
    textAlign: 'right',
  },
  fill: { flex: 1 },
  header: { gap: spacing.lg },
  listContent: { gap: spacing.lg },
});
