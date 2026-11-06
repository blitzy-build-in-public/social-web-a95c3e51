/**
 * One traveler's profile at the viewer's own disclosure tier — the route `/users/[userId]`
 * (AAP 0.5.8, AAP 0.8.1).
 *
 * Reached from Discover, from a meetup's counterpart and from a lodging's guest list, it is the
 * screen a proposal starts from (Discover → traveler → Propose) and the screen safety is reached
 * from (traveler → More → Block / Report).
 *
 * The client never decides disclosure: the API's three layers — `computeTier`, `selectForTier` and
 * `serializeProfile` — are the only enforcement (AAP 0.3.2, AAP 0.5.4, criterion 5). This screen
 * therefore renders exactly the fields its payload carries and nothing else: which of `nickname`,
 * `bio`, `canMessage`, `hasPhoto`, `fullName` and `externalContact` exist is settled by the API, and
 * a key that is present but null renders no row. No tier is computed here, no field is filtered and
 * no hidden value is derived, so a viewer can never read above their tier through this screen.
 *
 * Reputation is witnessed presence alone (AAP 0.5.7, AAP 0.7.1 row 7): the API's five counters as
 * plain numbers, never a star, a score or a review. Blocking and reporting are the safety basics of
 * AAP 0.7.1 row 12; a block is confirmed inline rather than through `Alert`, which react-native-web
 * cannot render, and `app/report.tsx` owns the report itself. An unblock control and a blocked-users
 * list are explicitly out of scope (AAP 0.7.2).
 *
 * The profile photo is not fetched here: `Avatar` loads `GET /users/:userId/photo` for a profile the
 * API reported a photo for, joining the session's one rotation on a `401`.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { colors, fontWeights, radii, spacing, typography } from '@tablemate/shared';
import { ProofStatus } from '@tablemate/shared';
import type { CityDto, Reputation, Tier0Profile } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { IMPORT_BANNER, REPUTATION_EMPTY, formatCalendarDate } from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { useSession } from '../../src/state/session-store';
import { Avatar, Banner, Button, Card, Screen, announce } from '../../src/ui';

// --- Constants -----------------------------------------------------------------------------------

/** Shown for an unknown, deleted or blocked traveler: the three are indistinguishable by design. */
const NOT_AVAILABLE = "This traveler isn't available.";

/** The accessible name of the loading indicator. */
const LOADING_LABEL = 'Loading profile';

/** The identity avatar's side in points / CSS px. */
const AVATAR_SIZE = 96;

/** Section and control wording that belongs to this screen, in plain English (AAP 0.7.2). */
const PROPOSE_LABEL = 'Propose a meetup';
const MORE_LABEL = 'More';
const MORE_HINT = 'Shows block and report options';
const REPORT_LABEL = 'Report';
const BLOCK_LABEL = 'Block';
const CANCEL_LABEL = 'Cancel';
const RETRY_LABEL = 'Try again';
const BACK_LABEL = 'Back';
const OPEN_MEETUPS_LABEL = 'Open meetups';
const REPUTATION_TITLE = 'Witnessed presence';
const SHARED_TITLE = 'Shared with you';
const CHAT_HINT = 'You can chat with this traveler from your meetup.';
const SHARED_NOTE = 'Shared after two completed meetups together.';

/**
 * The `['cities']` cache root: every city's venue and traveler lists hang beneath it, so one
 * invalidation drops the blocked traveler out of discovery. Taken from the key factory so it cannot
 * drift from the keys `src/state/meetup-store.ts` writes.
 */
const CITY_LIST_ROOT = queryKeys.cities.slice(0, 1);

/**
 * The `['meetup']` cache root — one meetup with its messages and suggestions beneath it — reached
 * through the factory's own key rather than a second hand-written literal; the id it is asked with
 * is discarded by the slice, because only the root is invalidated.
 */
const MEETUP_ROOT = queryKeys.meetup('').slice(0, 1);

// --- Pure helpers --------------------------------------------------------------------------------

/**
 * The code of a failed request, for {@link userMessageFor}. The client raises no error type other
 * than `ApiError`, and an answer that is not the error envelope is reported as `invalid_response`,
 * so neither the server's prose nor any part of a body reaches the screen (AAP 0.5.4, AAP 0.11.1).
 */
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'invalid_response';
}

/** A profile field's own text, or `null` when it is absent or blank. */
function present(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}

/** The configured name of a city, or the slug the profile carries when no city was configured. */
function cityNameFor(cities: readonly CityDto[] | undefined, cityId: string): string {
  return cities?.find((city) => city.id === cityId)?.name ?? cityId;
}

/**
 * The English name of an ISO 3166-1 alpha-2 region code, falling back to the code itself.
 *
 * `Intl.DisplayNames` is missing from some Hermes builds and from older engines, so it is probed
 * before use, and a locale or a code it refuses degrades to the code instead of throwing inside a
 * render (AAP 0.5.8).
 */
function regionName(code: string): string {
  if (typeof Intl.DisplayNames !== 'function') return code;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The stay line of the identity block: `In <city> from <arrival> to <departure>` (AAP 0.5.8), with
 * the city resolved from the cached `GET /cities`. A profile with no resolvable city shows the range
 * alone, and the dates are calendar dates rendered by the copy module's formatter.
 */
function stayLine(
  cityLabel: string | null,
  dates: NonNullable<Tier0Profile['proofDates']>,
): string {
  const from = formatCalendarDate(dates.arrivalDate);
  const to = formatCalendarDate(dates.departureDate);
  return cityLabel === null ? `From ${from} to ${to}` : `In ${cityLabel} from ${from} to ${to}`;
}

/** One labelled counter of the reputation card: the API's own figure, never a computed score. */
interface Counter {
  readonly label: string;
  readonly value: number;
}

/**
 * The five witnessed-presence counters of AAP 0.5.7, in the order they are read. Every counter is
 * shown, including a no-show count on a traveler with no witnessed meetup, because that miss is what
 * the API counted.
 */
function counterRows(reputation: Reputation): readonly Counter[] {
  return [
    { label: 'Witnessed meetups', value: reputation.witnessedMeetups },
    { label: 'Different travelers met', value: reputation.distinctCounterparts },
    { label: 'Venues', value: reputation.distinctVenues },
    { label: 'Cities', value: reputation.distinctCities },
    { label: 'No-shows, last 90 days', value: reputation.noShows90d },
  ];
}

/**
 * The inline block confirmation's question. `Alert` is unusable on react-native-web, so a
 * destructive action is confirmed in place, and the sentence states what a block does and that the
 * app offers no way back (AAP 0.5.3, AAP 0.7.2).
 */
function blockQuestion(handle: string): string {
  return (
    `Block @${handle}? You won't see each other's profiles, any open meetup between you is ` +
    "cancelled, and blocking can't be undone in the app."
  );
}

// --- Screen --------------------------------------------------------------------------------------

/**
 * The traveler profile screen.
 *
 * The route's own id is read from the dynamic segment and normalised, then the profile is read at
 * whichever tier the API answered with. Reading and focus order follow source order — identity,
 * actions, reputation, then the details a higher tier adds — every control is a UI primitive with a
 * visible label and the role, name and target size that go with it, and every failure is both
 * rendered in an error banner and spoken through `announce` (AAP 0.5.8).
 *
 * @returns The profile screen: the identity block, the Propose and More actions when the profile is
 * not the caller's own, the witnessed-presence counters, the interest tags and the higher tiers'
 * details.
 */
export default function TravelerProfileScreen(): ReactElement {
  const params = useLocalSearchParams<{ userId: string | string[] }>();
  const session = useSession();
  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const [proofBanner, setProofBanner] = useState(false);

  // A route reached without the segment — a stale deep link, a hand-written URL — delivers nothing
  // even though the parameter is typed as present, so the value is normalised defensively.
  const routeUserId = Array.isArray(params.userId) ? params.userId[0] : params.userId;
  const userId = typeof routeUserId === 'string' ? routeUserId : '';

  const profile = useQuery({
    queryKey: queryKeys.user(userId),
    queryFn: () => apiClient.getUser(userId),
    // An absent id is never requested: the screen shows the not-available state instead.
    enabled: userId.length > 0,
  });

  const handle = profile.data?.handle;

  const block = useMutation({
    mutationFn: async (): Promise<void> => {
      try {
        await apiClient.blockUser(userId);
      } catch (error) {
        // A traveler who is deleted or already blocked answers `404 user_not_found`: the pair is
        // already in the state a block asks for, so the completion below runs all the same.
        if (!(isApiError(error) && error.code === 'user_not_found')) throw error;
      }
    },
    onSuccess: () => {
      // The profile now answers `404`, so its entry is dropped rather than refetched.
      queryClient.removeQueries({ queryKey: queryKeys.user(userId) });
      // A block cancels any open meetup between the pair and resolves an open dispute `no_fault`
      // (AAP 0.5.3), so every meetup read is refetched along with each city's lists.
      void queryClient.invalidateQueries({ queryKey: CITY_LIST_ROOT });
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll });
      void queryClient.invalidateQueries({ queryKey: MEETUP_ROOT });
      announce(handle === undefined ? 'You blocked this traveler.' : `You blocked @${handle}.`);
      router.replace('/discover');
    },
  });

  const loadCode = profile.isError ? errorCodeOf(profile.error) : undefined;
  const blockCode = block.isError ? errorCodeOf(block.error) : undefined;
  const errorCode = loadCode ?? blockCode;

  // A failure is spoken once per distinct code: a re-render over the same failed answer would
  // otherwise repeat the sentence, and a recovery clears the code so the next failure speaks again.
  const announcedCode = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (errorCode === undefined) {
      announcedCode.current = undefined;
      return;
    }
    if (announcedCode.current === errorCode) return;
    announcedCode.current = errorCode;
    announce(userMessageFor(errorCode));
  }, [errorCode]);

  // A missing id and a `404` are the same screen on purpose: an unknown traveler, a deleted one and
  // a block in either direction are indistinguishable to a viewer (AAP 0.5.4).
  const unavailable = userId === '' || loadCode === 'user_not_found';
  useEffect(() => {
    if (unavailable) announce(NOT_AVAILABLE);
  }, [unavailable]);

  const header = (
    <Stack.Screen options={{ title: handle === undefined ? 'Traveler' : `@${handle}` }} />
  );

  if (unavailable) {
    return (
      <Screen testID="user-profile">
        {header}
        <Text style={styles.body}>{NOT_AVAILABLE}</Text>
        <Button
          variant="secondary"
          label={BACK_LABEL}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/discover'))}
        />
      </Screen>
    );
  }

  if (loadCode !== undefined) {
    return (
      <Screen testID="user-profile">
        {header}
        <Banner
          testID="user-error"
          tone="error"
          message={userMessageFor(loadCode)}
          action={{ label: RETRY_LABEL, onPress: () => void profile.refetch() }}
        />
      </Screen>
    );
  }

  const person = profile.data;
  if (person === undefined) {
    return (
      <Screen testID="user-profile">
        {header}
        <ActivityIndicator
          accessibilityLabel={LOADING_LABEL}
          color={colors.primary}
          size="large"
          testID="user-loading"
        />
      </Screen>
    );
  }

  const callerId = session.userId ?? me.data?.id;
  const isSelf = callerId !== undefined && callerId === userId;

  // The stay range already names the city, so the plain city line stands only when there is no
  // range to show and the two would otherwise repeat the same city.
  const cityLabel =
    person.currentCityId === null ? null : cityNameFor(cities.data?.items, person.currentCityId);
  const stay = person.proofDates === null ? null : stayLine(cityLabel, person.proofDates);
  const region = person.homeRegion === null ? null : regionName(person.homeRegion);
  const placeLines: string[] = [];
  if (region !== null) placeLines.push(region);
  if (stay !== null) placeLines.push(stay);
  else if (cityLabel !== null) placeLines.push(`Currently in ${cityLabel}`);

  // `hasPhoto` and the id are passed together and only for a profile the API reported a photo for:
  // a tier below 2 carries no such field, and `exactOptionalPropertyTypes` keeps an absent optional
  // key distinct from one holding `undefined` (AAP 0.5.4).
  const hasPhoto = 'hasPhoto' in person && person.hasPhoto === true;

  // The self-described fields, present only from tier 1, and the highest tier's fields. A key that
  // is present but null renders no row.
  const tier1 = 'nickname' in person ? person : null;
  const nickname = tier1 === null ? null : present(tier1.nickname);
  const bio = tier1 === null ? null : present(tier1.bio);
  const canMessage = tier1 !== null && tier1.canMessage;

  const tier3 = 'fullName' in person ? person : null;
  const fullName = tier3 === null ? null : present(tier3.fullName);
  const externalContact = tier3 === null ? null : present(tier3.externalContact);

  function onPropose(): void {
    if (me.data?.proof.status === ProofStatus.enum.valid) {
      router.push({ pathname: '/meetups/propose', params: { recipientId: userId } });
      return;
    }
    // Without a valid proof the proposal form is never opened: the banner that explains why is
    // revealed in place and spoken (AAP 0.5.8).
    setProofBanner(true);
    announce(IMPORT_BANNER);
  }

  return (
    <Screen testID="user-profile">
      {header}

      <View style={styles.identity}>
        <Avatar
          avatarSeed={person.avatarSeed}
          handle={person.handle}
          size={AVATAR_SIZE}
          {...(hasPhoto ? { userId, hasPhoto: true } : {})}
        />
        <View style={styles.identityText}>
          <Text accessibilityRole="header" style={styles.handle}>{`@${person.handle}`}</Text>
          {placeLines.map((line) => (
            <Text key={line} style={styles.muted}>
              {line}
            </Text>
          ))}
        </View>
      </View>

      {isSelf ? null : (
        <View style={styles.actions}>
          <Button
            testID="user-propose"
            label={PROPOSE_LABEL}
            busy={me.isPending}
            onPress={onPropose}
          />
          <Button
            testID="user-more"
            label={MORE_LABEL}
            variant="secondary"
            hint={MORE_HINT}
            onPress={() => setMenuOpen((open) => !open)}
          />

          {menuOpen ? (
            <View style={styles.menu}>
              <Button
                testID="user-report"
                label={REPORT_LABEL}
                variant="secondary"
                onPress={() => router.push({ pathname: '/report', params: { userId } })}
              />
              {/* The confirmation replaces the first Block button rather than sitting beside it, so
                  one element carries `user-block` at a time and a flow taps it twice. */}
              {confirmingBlock ? (
                <View style={styles.confirm}>
                  <Text style={styles.body}>{blockQuestion(person.handle)}</Text>
                  <Button
                    testID="user-block"
                    label={`Block @${person.handle}`}
                    variant="danger"
                    busy={block.isPending}
                    onPress={() => block.mutate()}
                  />
                  <Button
                    testID="user-block-cancel"
                    label={CANCEL_LABEL}
                    variant="secondary"
                    onPress={() => setConfirmingBlock(false)}
                  />
                </View>
              ) : (
                <Button
                  testID="user-block"
                  label={BLOCK_LABEL}
                  variant="danger"
                  onPress={() => setConfirmingBlock(true)}
                />
              )}
            </View>
          ) : null}

          {proofBanner ? (
            <Banner
              testID="proof-banner"
              tone="info"
              message={IMPORT_BANNER}
              action={{ label: 'Verify my stay', onPress: () => router.push('/proof/import') }}
            />
          ) : null}

          {/* A failed block keeps the confirmation open for a retry, so the message stands beside
              the buttons that produced it. */}
          {blockCode === undefined ? null : (
            <Banner testID="user-block-error" tone="error" message={userMessageFor(blockCode)} />
          )}
        </View>
      )}

      <Card title={REPUTATION_TITLE}>
        <View style={styles.counterList}>
          {counterRows(person.reputation).map((counter) => (
            <View key={counter.label} style={styles.counterRow}>
              <Text style={styles.body}>{counter.label}</Text>
              <Text style={styles.counterValue}>{counter.value}</Text>
            </View>
          ))}
          {person.reputation.witnessedMeetups === 0 ? (
            <Text style={styles.muted}>{REPUTATION_EMPTY}</Text>
          ) : null}
        </View>
      </Card>

      {person.interestTags.length === 0 ? null : (
        <View style={styles.tags}>
          {person.interestTags.map((tag) => (
            <View key={tag} style={styles.chip}>
              {/* The vocabulary is snake_case identifiers rather than labels, so a tag is read with
                  its underscores written as spaces (AAP 0.5.2). */}
              <Text style={styles.chipText}>{tag.replace(/_/g, ' ')}</Text>
            </View>
          ))}
        </View>
      )}

      {tier1 === null ? null : (
        <View style={styles.details}>
          {nickname === null ? null : <Text style={styles.body}>{nickname}</Text>}
          {bio === null ? null : <Text style={styles.body}>{bio}</Text>}
          {canMessage ? (
            <View style={styles.details}>
              <Text style={styles.muted}>{CHAT_HINT}</Text>
              <Button
                variant="secondary"
                label={OPEN_MEETUPS_LABEL}
                onPress={() => router.push('/meetups')}
              />
            </View>
          ) : null}
        </View>
      )}

      {tier3 === null ? null : (
        <Card title={SHARED_TITLE}>
          {fullName === null ? null : <Text style={styles.body}>{fullName}</Text>}
          {externalContact === null ? null : <Text style={styles.body}>{externalContact}</Text>}
          <Text style={styles.muted}>{SHARED_NOTE}</Text>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  identity: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.lg,
  },
  identityText: {
    flex: 1,
    gap: spacing.xs,
  },
  handle: {
    ...typography.heading,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  body: {
    ...typography.body,
    color: colors.text,
  },
  muted: {
    ...typography.body,
    color: colors.textMuted,
  },
  actions: {
    gap: spacing.sm,
  },
  menu: {
    gap: spacing.sm,
  },
  confirm: {
    gap: spacing.md,
  },
  counterList: {
    gap: spacing.sm,
  },
  counterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  counterValue: {
    ...typography.label,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipText: {
    ...typography.caption,
    color: colors.text,
  },
  details: {
    gap: spacing.sm,
  },
});
