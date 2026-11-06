/**
 * Plan the day — the day-plan suggestions for a locked meetup (AAP 0.5.8, AAP 0.8.1, criterion 13).
 *
 * Reached from Meetups → locked meetup → Plan the day, it renders `GET /meetups/:id/suggestions`: up
 * to ten priced places within 2 km of the venue that fit the pair's shared per-person budget. The
 * estimate, its range, the ranking, the freshness windows and the three empty reasons are the API's
 * (AAP 0.5.7), so this screen computes no price of its own and never guesses one (AAP 0.5.6), and the
 * places it shows come from OpenStreetMap, whose ODbL credit is shown wherever one appears (AAP
 * 0.3.3). Suggestions are informational: nothing here books, orders or pays at a place (AAP 0.7.2).
 *
 * The read is a state-writing one — a supplied budget is stored as the pair's shared budget, latest
 * change by either attendee winning, and the first read stamps `suggestionsFirstViewedAt` — so it is
 * read once per applied budget and never on a refocus, a keystroke or a timer (AAP 0.5.4, 0.7.3).
 *
 * Client-safe: `react`, `react-native`, `expo-router`, `@tanstack/react-query` and the app's own
 * modules, no Node built-in, no DOM global, no effect at module load. Nothing logs: a failure arrives
 * as an error code and is shown through the app's own sentence for it (AAP 0.11.1).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  BUDGET_MAX_CENTS,
  BUDGET_MIN_CENTS,
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  fontWeights,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { ClientEventRequest, PlaceCategory, PriceSource, Suggestion } from '@tablemate/shared';

import { apiClient } from '../../../src/api/client';
import { isApiError, userMessageFor } from '../../../src/api/errors';
import {
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  SUGGESTIONS_EMPTY,
  formatCalendarDate,
} from '../../../src/copy/strings';
import { queryKeys } from '../../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../../src/ui';

/** The navigator header's title (AAP 0.5.8: Meetups → locked meetup → Plan the day). */
const SCREEN_TITLE = 'Plan the day';

/** How long an answer stays fresh; retries for a request that never reached the API. */
const STALE_TIME_MS = 60_000;
const NETWORK_RETRIES = 2;

/**
 * The two sentences this screen adds to the app's error copy (AAP 0.5.8): `MEETUP_NOT_LOCKED` states
 * the eligibility rule of AAP 0.7.3 — a locked meetup, or one completed within the last day — and
 * `MEETUP_UNAVAILABLE` also answers a route that arrived without a meetup id.
 */
const MEETUP_NOT_LOCKED =
  'Suggestions are available for locked meetups and for a day after you meet.';
const MEETUP_UNAVAILABLE = "This meetup isn't available.";

/** The budget control, its rejected-amount message using the bounds the route enforces (AAP 0.5.4). */
const BUDGET_LABEL = 'Per-person budget (USD)';
const BUDGET_SHARED_NOTE = 'Your budget is shared with your counterpart.';
const APPLY_BUDGET_LABEL = 'Update budget';
const BUDGET_ERROR = `Enter an amount from ${BUDGET_MIN_CENTS / 100} to ${BUDGET_MAX_CENTS / 100} USD.`;

/** What a card says: its fallback for absent hours, its badge, and its two disclosure labels. */
const HOURS_NOT_LISTED = 'Hours not listed';
const PARTNER_BADGE = 'Partner venue';
const SHOW_PRICES_LABEL = 'Show prices used';
const HIDE_PRICES_LABEL = 'Hide prices used';

/** The label a price record's reference is shown under (AAP 0.5.6: a menu URL or a phone quote). */
const OPEN_SOURCE_LABEL = 'Open source';
const CALL_LABEL = 'Call';

/** The action offered when the suggestions route alone is briefly unavailable (AAP 0.5.4). */
const RETRY_LABEL = 'Retry';

/** Shown while the first answer is in flight. */
const LOADING = 'Loading…';

/** The category a place is listed under (AAP 0.5.7); a new one fails the type check here. */
const CATEGORY_LABELS = {
  restaurant: 'Restaurant',
  cafe: 'Café',
  bar: 'Bar',
  activity: 'Activity',
} as const satisfies Record<PlaceCategory, string>;

/** Where a price came from, in the card's own words (AAP 0.5.6, 0.5.7). */
const SOURCE_LABELS = {
  online_menu: 'Online menu',
  phone_quote: 'Phone quote',
  operator_entry: 'Checked by our team',
} as const satisfies Record<PriceSource, string>;

// The pure helpers below are exported for their unit tests, the way `app/(tabs)/meetups.tsx` exports
// its status and filter tables; nothing outside this module calls them.

/**
 * A USD amount in cents as the copy shows it: a whole dollar amount keeps no decimals and an amount
 * with cents keeps exactly two, so `1800` reads `18` and `1750` reads `17.50`. Written by hand rather
 * than with `Intl`, so the copy is byte-stable across Hermes, the browser and Node.
 */
export function formatUsdAmount(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

/**
 * Three of the lines a ranked place shows under its name (AAP 0.5.7): its cost, from the estimate and
 * the range the server computed; its distance, in metres under a kilometre and in kilometres above
 * it; and the date part of an instant, which is what a check or capture date shows, because a capture
 * time must not be read in the device's own zone (AAP 0.3.3).
 */
export function estimateText(range: Suggestion['estimatedCostRange']): string {
  const low = formatUsdAmount(range.lowCents);
  const high = formatUsdAmount(range.highCents);
  return `About ${formatUsdAmount(range.estimateCents)} USD (${low}–${high} USD) per person`;
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
}

function instantDay(instant: string): string {
  return formatCalendarDate(instant.slice(0, 10));
}

/** The label a price record's reference is shown under, or null when it carries none (AAP 0.5.6). */
export function sourceLinkLabel(url: string | null): string | null {
  if (url === null) return null;
  if (url.startsWith('https://') || url.startsWith('http://')) return OPEN_SOURCE_LABEL;
  return url.startsWith('tel:') ? CALL_LABEL : null;
}

/**
 * Opens a reference outside the app. A platform with no handler for the link — no browser, no dialer
 * — leaves it unopened and the link's own text stays on screen, so nothing is reported or retried.
 */
function openUrl(url: string): void {
  void Linking.openURL(url).catch(() => {});
}

/**
 * The budget an entered amount asks for, in cents, or null when the field holds no amount inside the
 * accepted range: the route answers `422 budget_out_of_range` outside 500 to 10,000 cents, so the
 * same bound is checked here before a rate-limited request is spent on it (AAP 0.5.4).
 */
export function budgetFromText(text: string): number | null {
  const entered = text.trim();
  if (entered === '') return null;
  const amount = Number(entered);
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  return cents < BUDGET_MIN_CENTS || cents > BUDGET_MAX_CENTS ? null : cents;
}

/**
 * The notice a failed read shows in its banner, or null when it has none to show: an out-of-range
 * budget belongs to the field below, and a request that never reached the API has no code to name.
 */
export function bannerMessageFor(error: unknown): string | null {
  if (error === null) return null;
  if (!isApiError(error)) return userMessageFor('invalid_response');
  if (error.code === 'budget_out_of_range') return null;
  if (error.code === 'meetup_not_locked') return MEETUP_NOT_LOCKED;
  if (error.code === 'meetup_not_found') return MEETUP_UNAVAILABLE;
  return userMessageFor(error.code);
}

/** The inline field error a rejected budget shows in place of a banner (AAP 0.5.4). */
export function budgetFieldErrorFor(error: unknown): string | null {
  return isApiError(error) && error.code === 'budget_out_of_range'
    ? userMessageFor('budget_out_of_range')
    : null;
}

/**
 * A reference the screen opens outside the app: a price record's menu page or phone number, and the
 * OpenStreetMap copyright. Text rather than a `Button`, because it reads as the reference it is, and
 * it keeps the 44-point target of every other control without painting an edge of its own.
 *
 * Enter is wired on web by hand: react-native-web assumes the browser activates a real anchor and
 * withholds the press from a `div[role="link"]`, the gap `ListItem` closes the same way (AAP 0.5.8:
 * every web flow is keyboard-operable). The browser's own focus ring is left on.
 */
function LinkText({
  label,
  name,
  onPress,
  testID,
}: {
  /** Visible link text, always part of the accessible name (WCAG 2.5.3, Label in Name). */
  readonly label: string;
  /** The item the reference belongs to, so two links on one card are told apart by name. */
  readonly name?: string;
  readonly onPress: () => void;
  readonly testID?: string;
}): ReactElement {
  const webKeys =
    Platform.OS === 'web'
      ? {
          onKeyDown: (event: { key?: string; repeat?: boolean }) => {
            if (event.key === 'Enter' && event.repeat !== true) onPress();
          },
        }
      : {};

  return (
    <Pressable
      {...webKeys}
      role="link"
      accessibilityLabel={name === undefined ? label : `${label}: ${name}`}
      onPress={onPress}
      style={styles.linkTarget}
      {...(testID === undefined ? {} : { testID })}
    >
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  );
}

/**
 * The one control a card carries: it reveals the price records the estimate was built from and reports
 * the section's state as a disclosure, so a screen reader announces it as expanded or collapsed
 * rather than reading a different label only (WCAG 4.1.2).
 *
 * The state is passed twice because the two platforms read it from different places: React Native
 * 0.76 aliases `aria-expanded` onto `accessibilityState.expanded` (the spelling iOS and Android
 * announce), while react-native-web 0.19 renders the `aria-` attribute and, as a browser check
 * confirmed, drops `accessibilityState.expanded` entirely — so the attribute alone would leave the
 * disclosure unannounced on native and the state alone would leave it unannounced on the web.
 */
function DisclosureToggle({
  expanded,
  onPress,
}: {
  readonly expanded: boolean;
  readonly onPress: () => void;
}): ReactElement {
  const label = expanded ? HIDE_PRICES_LABEL : SHOW_PRICES_LABEL;

  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-expanded={expanded}
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [styles.toggle, pressed ? styles.togglePressed : null]}
    >
      <Text style={styles.toggleLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * One ranked place (AAP 0.5.7): what it is and how far it is, what it costs per person, where that
 * price came from and when it was checked, its hours today, a partner badge, and — on demand — the
 * price records the estimate was built from. A partner venue is named in words as well as tinted, so
 * the state is never carried by colour alone (WCAG 1.4.1), and the server's own order is kept.
 */
function SuggestionCard({
  item,
  expanded,
  onToggle,
}: {
  readonly item: Suggestion;
  readonly expanded: boolean;
  readonly onToggle: (item: Suggestion) => void;
}): ReactElement {
  return (
    <Card
      testID={`suggestion-${item.placeId}`}
      title={item.name}
      trailing={item.isPartnerVenue ? <Text style={styles.badge}>{PARTNER_BADGE}</Text> : undefined}
    >
      <Text style={styles.category}>
        {`${CATEGORY_LABELS[item.category]} · ${formatDistance(item.distanceM)}`}
      </Text>
      <Text style={styles.cost}>{estimateText(item.estimatedCostRange)}</Text>
      <Text style={styles.detail}>
        {`${SOURCE_LABELS[item.priceSource]} · Prices checked ${instantDay(item.priceVerifiedAt)}`}
      </Text>
      <Text style={styles.detail}>{item.openingHoursToday ?? HOURS_NOT_LISTED}</Text>
      <DisclosureToggle
        expanded={expanded}
        onPress={() => {
          onToggle(item);
        }}
      />
      {expanded ? (
        <View style={styles.provenanceList}>
          {item.itemsUsed.map((used, index) => {
            const url = used.sourceUrl;
            const linkLabel = sourceLinkLabel(url);
            return (
              // The records are rendered as they arrived and never reordered, so the position names
              // one row of this card.
              <View key={`${used.name}-${index}`} style={styles.provenance}>
                <Text style={styles.provenanceName}>
                  {`${used.name} · ${formatUsdAmount(used.priceUsdCents)} USD`}
                </Text>
                <Text style={styles.detail}>
                  {`${SOURCE_LABELS[used.source]} · ${instantDay(used.capturedAt)}`}
                </Text>
                {url === null || linkLabel === null ? null : (
                  <LinkText
                    label={linkLabel}
                    name={used.name}
                    onPress={() => {
                      openUrl(url);
                    }}
                  />
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </Card>
  );
}

/**
 * Plan the day: the pair's shared budget, then the places the API ranked under it (AAP 0.5.8). The
 * deposit is never spent and served only to set the default budget (AAP 0.7.3), so nothing here moves
 * money: a hold is released or forfeited by settlement alone (AAP 0.5.7).
 *
 * @returns The suggestions screen for the meetup named by the route parameter.
 */
export default function SuggestionsScreen(): ReactElement {
  // A route parameter can be momentarily absent while a deep link resolves, so an empty id leaves the
  // read disabled rather than asking for a meetup that cannot exist (`useMeetup` guards the same way).
  const params = useLocalSearchParams<{ id: string }>();
  const meetupId = params.id ?? '';

  // The budget the read was made with, or null for the pair's stored one, which the server derives
  // from the deposit: 500 -> 1,500, 1,000 -> 3,000 and 2,000 -> 6,000 cents (AAP 0.5.7).
  const [appliedBudget, setAppliedBudget] = useState<number | null>(null);
  // What the traveller has typed, or null while the field follows the stored budget. Holding the
  // draft rather than copying each answer into state is what lets an answer arriving mid-typing leave
  // the field alone while a fresh one re-initialises it (AAP 0.5.4).
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  // The place whose prices are open, and the ones already reported in this visit.
  const [expandedPlaceId, setExpandedPlaceId] = useState<string | null>(null);
  const openedPlaces = useRef<Set<string>>(new Set());

  const suggestions = useQuery({
    queryKey: queryKeys.suggestions(meetupId, appliedBudget ?? undefined),
    queryFn: () => apiClient.getSuggestions(meetupId, appliedBudget ?? undefined),
    // The route writes state, so it is read once per applied budget: a refocus or a reconnect would
    // spend a rate-limited write on an answer that cannot have changed (AAP 0.5.4).
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: STALE_TIME_MS,
    retry: (failureCount, error) =>
      isApiError(error) && error.code === 'network_error' && failureCount < NETWORK_RETRIES,
    enabled: meetupId.length > 0,
  });

  const serverBudget = suggestions.data?.budgetCents;
  const budgetValue =
    budgetDraft ?? (serverBudget === undefined ? '' : formatUsdAmount(serverBudget));
  const budgetFieldError = budgetError ?? budgetFieldErrorFor(suggestions.error);
  const errorNotice =
    meetupId.length === 0 ? MEETUP_UNAVAILABLE : bannerMessageFor(suggestions.error);

  // iOS has no live region to speak a banner and a field error has none on any platform, so both are
  // announced as well as shown (AAP 0.5.8). `announce` drops an immediate repeat of one sentence and
  // does nothing off iOS and Android, where nothing implements an announcement.
  useEffect(() => {
    const spoken = budgetFieldError ?? errorNotice;
    if (spoken !== null) announce(spoken);
  }, [budgetFieldError, errorNotice]);

  const applyBudget = (): void => {
    const cents = budgetFromText(budgetValue);
    if (cents === null) {
      setBudgetError(BUDGET_ERROR);
      return;
    }
    setBudgetError(null);
    // The field follows the stored budget again, which the next answer confirms.
    setBudgetDraft(null);
    setAppliedBudget(cents);
  };

  const changeBudget = (text: string): void => {
    setBudgetError(null);
    setBudgetDraft(text);
  };

  const togglePlace = (item: Suggestion): void => {
    const expanding = expandedPlaceId !== item.placeId;
    setExpandedPlaceId(expanding ? item.placeId : null);
    if (!expanding || openedPlaces.current.has(item.placeId)) return;
    openedPlaces.current.add(item.placeId);
    // Fire and forget: opening a place is a measure of the screen, never a condition of it, so a
    // failed event is swallowed rather than shown (AAP 0.3.2, AAP 0.5.7).
    const event: ClientEventRequest = {
      name: 'suggestion_place_opened',
      meetupId,
      placeId: item.placeId,
      placeCategory: item.category,
    };
    void apiClient.postEvent(event).catch(() => {});
  };

  const items = suggestions.data?.items ?? [];
  // An empty answer always carries its reason; should one ever arrive without it, the first reason
  // the API checks is the one shown (AAP 0.5.7).
  const emptyReason = suggestions.data?.emptyReason;
  const emptyMessage =
    emptyReason === undefined ? SUGGESTIONS_EMPTY.no_priced_places : SUGGESTIONS_EMPTY[emptyReason];

  const budgetControl =
    suggestions.data === undefined ? null : (
      <View style={styles.budget}>
        <TextField
          label={BUDGET_LABEL}
          value={budgetValue}
          onChangeText={changeBudget}
          error={budgetFieldError}
          inputMode="decimal"
          returnKeyType="done"
          onSubmitEditing={applyBudget}
          testID="suggestions-budget"
        />
        <Text style={styles.detail}>{BUDGET_SHARED_NOTE}</Text>
        <Button label={APPLY_BUDGET_LABEL} onPress={applyBudget} />
      </View>
    );

  // The budget control always precedes the answer, so for `budget_too_low` the sentence the API gave
  // and the control that raises the budget sit together (AAP 0.5.8).
  let answer: ReactElement | ReactElement[] | null = null;
  if (suggestions.data === undefined) {
    if (suggestions.isPending && errorNotice === null) {
      answer = <Text style={styles.detail}>{LOADING}</Text>;
    }
  } else if (items.length === 0) {
    answer = <Banner tone="info" message={emptyMessage} testID="suggestions-empty" />;
  } else {
    answer = items.map((item) => (
      <SuggestionCard
        key={item.placeId}
        item={item}
        expanded={expandedPlaceId === item.placeId}
        onToggle={togglePlace}
      />
    ));
  }

  return (
    <Screen testID="suggestions-screen">
      <Stack.Screen options={{ title: SCREEN_TITLE }} />

      {errorNotice === null ? null : (
        <Banner
          tone="error"
          message={errorNotice}
          // Only the suggestions route's own failure is worth retrying; every other code has a
          // sentence saying what to do (AAP 0.5.4).
          {...(isApiError(suggestions.error) && suggestions.error.code === 'suggestions_unavailable'
            ? {
                action: {
                  label: RETRY_LABEL,
                  onPress: (): void => {
                    void suggestions.refetch();
                  },
                },
              }
            : {})}
        />
      )}

      {budgetControl}

      {answer}

      <LinkText
        label={OSM_ATTRIBUTION}
        onPress={() => {
          openUrl(OSM_COPYRIGHT_URL);
        }}
        testID="osm-attribution"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Every colour below is a recorded pair: `text` and `primary` on `background` (17.21:1, 7.3:1),
  // `textMuted` on `background` (7.07:1), and the `border` boundary at 3.7:1 over the page.
  badge: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: fontWeights.bold,
  },
  budget: {
    gap: spacing.sm,
  },
  category: {
    ...typography.label,
    color: colors.text,
    fontWeight: fontWeights.medium,
  },
  cost: {
    ...typography.body,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  detail: {
    ...typography.body,
    color: colors.textMuted,
  },
  link: {
    ...typography.body,
    color: colors.primary,
    textDecorationLine: 'underline',
  },
  // A link keeps at least the 44-point target of every other control without painting an edge of its
  // own: the underline is the whole visible affordance (AAP 0.5.8).
  linkTarget: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
  },
  provenance: {
    gap: spacing.xs,
  },
  provenanceList: {
    borderTopColor: colors.border,
    borderTopWidth: borderWidths.separator,
    gap: spacing.md,
    paddingTop: spacing.md,
  },
  provenanceName: {
    ...typography.body,
    color: colors.text,
  },
  toggle: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  toggleLabel: {
    ...typography.label,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  // An outlined control's own fill is the lightest token, so its press takes the `surface` step.
  togglePressed: {
    backgroundColor: colors.surface,
  },
});
