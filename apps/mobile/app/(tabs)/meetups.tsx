/**
 * The Meetups tab (AAP 0.5.8, AAP 0.8.1): the caller's own meetups, newest first, and the entry
 * point to every meetup screen — proposal detail, accept and lock, check-in, chat, a report and the
 * day plan.
 *
 * It lists what `GET /meetups` returned and never gates on proof status: a meetup locked while the
 * caller held a valid proof still has to be reachable for its check-in and settlement once that
 * proof expires (AAP 0.5.8). It decides nothing about disclosure either — the counterpart arrives
 * serialized at the caller's tier, so a field this screen does not find is a field the API did not
 * release (AAP 0.3.2, criterion 5).
 *
 * Three filters narrow one read — every meetup, the proposals waiting for the caller, and the ones
 * the caller proposed — and that read's states are the screen's: loading, an error with a retry,
 * empty with the way on to Discover, and the list itself, 20 to a page and continued by the button
 * under it. Nothing polls: a `meetup_status` frame already invalidates the meetup queries
 * (`bindRealtimeInvalidation` in `src/state/meetup-store.ts`), so a status change needs no timer
 * (AAP 0.3.3). A start time is shown in the venue's own city, because the meeting is at the venue.
 *
 * Client-safe: `react`, `react-native`, `expo-router`, `@tanstack/react-query` and the app's own
 * client modules, with no Node built-in, no DOM global and no effect of its own at module load.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { MeetupDto, MeetupStatus, NextAction, ParticipantRole } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { meetupsInPages, queryKeys, useMeetups } from '../../src/state/meetup-store';
import { Avatar, Banner, Button, ListItem, Screen, announce } from '../../src/ui';

/** How long the city list — and so every venue's timezone — stays fresh, in milliseconds. */
const CITIES_STALE_TIME_MS = 60 * 60 * 1000;

/** The date and time a row's subtitle shows, in the venue's own city. */
const START_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/** The same form in UTC: the fallback for a zone this runtime does not carry (AAP 0.5.8). */
const UTC_TIME_FORMAT: Intl.DateTimeFormatOptions = { ...START_TIME_FORMAT, timeZone: 'UTC' };

/**
 * The word each lifecycle value shows in a row (AAP 0.5.3). Typed through `satisfies`, so a status
 * added to the enum fails the type check here instead of rendering as a blank line.
 */
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

/** What the caller does next, as the row's trailing line (AAP 0.5.4); `null` renders no line. */
export const NEXT_ACTION_HINT = {
  confirm_hold: 'Confirm your card hold',
  retry_hold: 'Retry your card hold',
  accept: 'Review and accept',
  check_in: 'Check in at the venue',
  none: null,
} as const satisfies Record<NextAction, string | null>;

/** Which side of the meetup the caller holds, in the row's own words (AAP 0.5.4). */
export const ROLE_LABEL = {
  initiator: 'You proposed',
  recipient: 'Proposed to you',
} as const satisfies Record<ParticipantRole, string>;

/** The three ways this tab narrows `GET /meetups`. */
export type MeetupFilter = 'all' | 'proposed_to_me' | 'mine';

/**
 * One chip: the text it shows and the read it makes. Both filters are the closed sets the API
 * validates (`MeetupListQuery`), so a chip cannot ask for a value the route would refuse, and an
 * absent filter is what makes `all` every meetup of the caller.
 */
export interface MeetupFilterSpec {
  readonly label: string;
  readonly testID: string;
  readonly role?: ParticipantRole;
  readonly status?: MeetupStatus;
}

/**
 * The filters, keyed by id: "Mine" is the side the caller proposed, which pairs it with "Proposed to
 * me", the side waiting for the caller (AAP 0.5.4). A `Record`, so a filter added to
 * {@link MeetupFilter} without a chip here fails the type check; {@link FILTER_ORDER} alone sets
 * the order the chips appear in.
 */
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

/** The order the chips appear in, read left to right. */
const FILTER_ORDER: readonly MeetupFilter[] = ['all', 'proposed_to_me', 'mine'];

/**
 * Formats a meetup's start in the given IANA zone, or in UTC naming the offset.
 *
 * The zone is the venue city's: a device set to another zone must not show the caller a time the
 * venue and the other traveler do not keep. `Intl` throws a `RangeError` for a zone Hermes does not
 * carry, and the fallback says UTC in the text rather than presenting a UTC time as the local one;
 * a value `Intl` cannot format at all is returned as it arrived.
 *
 * @param iso - The meetup's `startsAt`, as the API sent it.
 * @param timeZone - The venue city's zone, or `undefined` while the city list is unread.
 * @returns The start, ready to place in a row's subtitle.
 */
export function formatStart(iso: string, timeZone?: string): string {
  const start = new Date(iso);

  // A known zone is used as it is: the fallback below is what names UTC, so a resolved zone never
  // carries the suffix. An absent zone (the city list is unread) and one this runtime rejects both
  // reach the UTC branch, which states the offset rather than passing a UTC time off as the local
  // one.
  if (timeZone !== undefined) {
    try {
      return new Intl.DateTimeFormat('en-US', { ...START_TIME_FORMAT, timeZone }).format(start);
    } catch {
      // Unknown zone or unformattable date: fall through to UTC.
    }
  }

  try {
    return `${new Intl.DateTimeFormat('en-US', UTC_TIME_FORMAT).format(start)} UTC`;
  } catch {
    return iso;
  }
}

/** The sentence to show for a failed read: the code's own, or the generic one for anything else. */
function messageFor(error: unknown): string {
  return isApiError(error) ? userMessageFor(error.code) : userMessageFor('invalid_response');
}

/**
 * One row: who the meetup is with, where and when it starts, where it stands, and what the caller
 * does next. The avatar is decorative because the handle beside it names the traveler, and the
 * profile photo is asked for only where the API reported one — `hasPhoto` is used exactly as it
 * arrived, never inferred from the tier this client thinks the viewer holds (AAP 0.3.2, AAP 0.5.4).
 */
function meetupRow(meetup: MeetupDto, cityZones: ReadonlyMap<string, string>): ReactElement {
  const counterpart = meetup.counterpart;
  const hasPhoto = 'hasPhoto' in counterpart && counterpart.hasPhoto;
  const nextAction = NEXT_ACTION_HINT[meetup.nextAction];
  const zone = cityZones.get(meetup.venue.cityId);
  const where = `${meetup.venue.name} · ${formatStart(meetup.startsAt, zone)}`;

  return (
    <ListItem
      key={meetup.id}
      testID={`meetup-${meetup.id}`}
      role="link"
      onPress={() => {
        router.push(`/meetups/${meetup.id}`);
      }}
      label={counterpart.handle}
      leading={
        <Avatar
          avatarSeed={counterpart.avatarSeed}
          handle={counterpart.handle}
          decorative
          {...(hasPhoto ? { userId: counterpart.id, hasPhoto: true } : {})}
        />
      }
      subtitle={`${where} · ${STATUS_LABEL[meetup.status]} · ${ROLE_LABEL[meetup.role]}`}
      trailing={nextAction === null ? undefined : <Text style={styles.trailing}>{nextAction}</Text>}
    />
  );
}

/**
 * The Meetups tab.
 *
 * Every meetup the caller is part of is listed whatever its status, and no part of this screen asks
 * for a valid proof, so a locked meetup whose proof expired stays reachable through its check-in
 * and settlement (AAP 0.5.8). Opening a row is `app/meetups/[id]/index.tsx`, which owns the accept,
 * lock, check-in, chat, dispute and day-plan actions.
 *
 * @returns The Meetups tab screen.
 */
export default function MeetupsScreen(): ReactElement {
  const [filter, setFilter] = useState<MeetupFilter>('all');
  const active = MEETUP_FILTERS[filter];
  const meetups = useMeetups(active.role, active.status);

  // A public read that changes only when the pilot adds a city, so one answer an hour serves every
  // row; its failure costs the city-local time and nothing else, because `formatStart` falls back.
  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: CITIES_STALE_TIME_MS,
  });

  const cityZones = useMemo(() => {
    const zones = new Map<string, string>();
    for (const city of cities.data?.items ?? []) {
      zones.set(city.id, city.timezone);
    }
    return zones;
  }, [cities.data]);

  const items = meetups.data === undefined ? [] : meetupsInPages(meetups.data.pages);

  // `isError` is the read having failed, which is what the banner reports; a refetch that failed
  // over a list already on screen is not a state of its own here.
  const errorMessage = meetups.isError ? messageFor(meetups.error) : null;

  useEffect(() => {
    // iOS has no live region to speak a banner, so the core flows' errors are announced as well as
    // shown (AAP 0.5.8). `announce` drops an immediate repeat and does nothing off iOS and Android.
    if (errorMessage !== null) announce(errorMessage);
  }, [errorMessage]);

  const hasRows = items.length > 0;
  const showLoading = !hasRows && errorMessage === null && meetups.isPending;
  const showEmpty = !hasRows && errorMessage === null && !meetups.isPending;
  const retry = (): void => {
    void meetups.refetch();
  };
  const showMore = (): void => {
    void meetups.fetchNextPage();
  };

  return (
    <Screen edges={['left', 'right']}>
      {/* Each chip is a real button: the selected one is filled, the others outlined, and the
          selected one carries the word for assistive technology the outline cannot show. */}
      <View style={styles.filters}>
        {FILTER_ORDER.map((id) => {
          const spec = MEETUP_FILTERS[id];
          const selected = id === filter;
          return (
            <Button
              key={id}
              label={spec.label}
              variant={selected ? 'primary' : 'secondary'}
              testID={spec.testID}
              {...(selected ? { hint: 'Selected' } : {})}
              onPress={() => {
                setFilter(id);
              }}
            />
          );
        })}
      </View>

      {errorMessage === null ? null : (
        <Banner
          tone="error"
          message={errorMessage}
          action={{ label: 'Try again', onPress: retry, testID: 'meetups-retry' }}
          testID="meetups-error"
        />
      )}

      {hasRows ? items.map((meetup) => meetupRow(meetup, cityZones)) : null}

      {showLoading ? <Text style={styles.notice}>Loading…</Text> : null}

      {showEmpty ? (
        <View style={styles.emptyState}>
          <Text style={styles.notice}>No meetups yet.</Text>
          <ListItem
            label="Find travelers on Discover"
            role="link"
            testID="meetups-discover"
            onPress={() => {
              router.navigate('/discover');
            }}
          />
        </View>
      ) : null}

      {meetups.hasNextPage ? (
        <Button
          label="Show more meetups"
          variant="secondary"
          busy={meetups.isFetchingNextPage}
          testID="meetups-show-more"
          onPress={showMore}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Chips wrap rather than shrink, so a long label stays legible at any system font size.
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  notice: {
    color: colors.textMuted,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
  emptyState: { gap: spacing.sm },
  // A status line, not a control label: the caption step in the muted pair (7.07:1 on the page).
  // The row's text column keeps the free space, so a long hint wraps instead of crushing it.
  trailing: {
    color: colors.textMuted,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    fontWeight: fontWeights.medium,
    flexShrink: 1,
    textAlign: 'right',
  },
});
