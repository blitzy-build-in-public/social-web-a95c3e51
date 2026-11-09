/** Plan the day — the day-plan suggestions for a locked meetup (AAP 0.5.8, AAP 0.8.1, criterion 13). */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
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

const PARTNER_BADGE = 'Partner venue';
const NOT_LOCKED = 'Suggestions are available for locked meetups and for a day after you meet.';
const UNAVAILABLE = "This meetup isn't available.";
const BUDGET_ERROR = `Enter an amount from ${BUDGET_MIN_CENTS / 100} to ${BUDGET_MAX_CENTS / 100} USD.`;
const CATEGORY_LABELS = {
  restaurant: 'Restaurant',
  cafe: 'Café',
  bar: 'Bar',
  activity: 'Activity',
} as const satisfies Record<PlaceCategory, string>;
const SOURCE_LABELS = {
  online_menu: 'Online menu',
  phone_quote: 'Phone quote',
  operator_entry: 'Checked by our team',
} as const satisfies Record<PriceSource, string>;
export const formatUsdAmount = (cents: number): string =>
  Number.isInteger(cents / 100) ? String(cents / 100) : (cents / 100).toFixed(2);
export const estimateText = (range: Suggestion['estimatedCostRange']): string =>
  `About ${formatUsdAmount(range.estimateCents)} USD (${formatUsdAmount(range.lowCents)}–${formatUsdAmount(range.highCents)} USD) per person`;
export const formatDistance = (meters: number): string =>
  meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
const instantDay = (instant: string): string => formatCalendarDate(instant.slice(0, 10));
export function sourceLinkLabel(url: string | null): string | null {
  if (url === null) return null;
  if (url.startsWith('https://') || url.startsWith('http://')) return 'Open source';
  return url.startsWith('tel:') ? 'Call' : null;
}
const openUrl = (url: string): void => void Linking.openURL(url).catch(() => {});
export function budgetFromText(text: string): number | null {
  const entered = text.trim();
  if (entered === '') return null;
  const amount = Number(entered);
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  return cents < BUDGET_MIN_CENTS || cents > BUDGET_MAX_CENTS ? null : cents;
}
export function bannerMessageFor(error: unknown): string | null {
  if (error === null) return null;
  if (!isApiError(error)) return userMessageFor('invalid_response');
  if (error.code === 'budget_out_of_range') return null;
  if (error.code === 'meetup_not_locked') return NOT_LOCKED;
  if (error.code === 'meetup_not_found') return UNAVAILABLE;
  return userMessageFor(error.code);
}
export const budgetFieldErrorFor = (error: unknown): string | null =>
  isApiError(error) && error.code === 'budget_out_of_range'
    ? userMessageFor('budget_out_of_range')
    : null;
type TextLinkProps = {
  readonly label: string;
  readonly name?: string;
  readonly onPress: () => void;
  readonly testID?: string;
};
const linkKeys = (onPress: () => void): { onKeyDown?: (e: { key?: string }) => void } =>
  Platform.OS === 'web' ? { onKeyDown: (event) => void (event.key === 'Enter' && onPress()) } : {};

/**
 * Keeps the browser's own focus outline off a focused control on web, where it would otherwise be
 * painted over the 2 px band the control's own border reserves and the ring a keyboard user sees
 * would be the browser's default rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76
 * declares no `outline` style, so the long form is asserted once here; react-native-web drops the
 * `outline` shorthand as an invalid short form. The value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const LinkText = ({ label, name, onPress, testID }: TextLinkProps): ReactElement => {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...linkKeys(onPress)}
      role="link"
      accessibilityLabel={name === undefined ? label : `${label}: ${name}`}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      // Hover is a web state: React Native 0.76 declares the pair on `PressableProps` and
      // react-native-web forwards it to its hover hook, while iOS and Android never fire it.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.linkTarget,
        hovered ? styles.linkHovered : null,
        pressed ? styles.linkPressed : null,
        focused ? styles.linkFocused : null,
        webFocusRingReset,
      ]}
      {...(testID === undefined ? {} : { testID })}
    >
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  );
};
type ToggleProps = { readonly expanded: boolean; readonly onPress: () => void };
function DisclosureToggle({ expanded, onPress }: ToggleProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      role="button"
      aria-label={expanded ? 'Hide prices used' : 'Show prices used'}
      aria-expanded={expanded}
      accessibilityState={{ expanded }}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      // Hover is a web state: React Native 0.76 declares the pair on `PressableProps` and
      // react-native-web forwards it to its hover hook, while iOS and Android never fire it.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toggle,
        hovered ? styles.toggleHovered : null,
        pressed ? styles.togglePressed : null,
        focused ? styles.toggleFocused : null,
        webFocusRingReset,
      ]}
    >
      <Text style={styles.toggleLabel}>{expanded ? 'Hide prices used' : 'Show prices used'}</Text>
    </Pressable>
  );
}
type CardProps = {
  readonly item: Suggestion;
  readonly expandedPlaceId: string | null;
  readonly onToggle: (item: Suggestion) => void;
};
function SuggestionCard({ item, expandedPlaceId, onToggle }: CardProps): ReactElement {
  const expanded = expandedPlaceId === item.placeId;
  const category = `${CATEGORY_LABELS[item.category]} · ${formatDistance(item.distanceM)}`;
  const checked = `${SOURCE_LABELS[item.priceSource]} · Prices checked ${instantDay(item.priceVerifiedAt)}`;
  return (
    <Card
      testID={`suggestion-${item.placeId}`}
      title={item.name}
      trailing={item.isPartnerVenue ? <Text style={styles.badge}>{PARTNER_BADGE}</Text> : undefined}
    >
      <Text style={styles.category}>{category}</Text>
      <Text style={styles.cost}>{estimateText(item.estimatedCostRange)}</Text>
      <Text style={styles.detail}>{checked}</Text>
      <Text style={styles.detail}>{item.openingHoursToday ?? 'Hours not listed'}</Text>
      <DisclosureToggle expanded={expanded} onPress={() => onToggle(item)} />
      {expanded ? (
        <View style={styles.provenanceList}>
          {item.itemsUsed.map((used, index) => {
            const url = used.sourceUrl;
            const linkLabel = sourceLinkLabel(url);
            const price = `${used.name} · ${formatUsdAmount(used.priceUsdCents)} USD`;
            const captured = `${SOURCE_LABELS[used.source]} · ${instantDay(used.capturedAt)}`;
            return (
              <View key={`${used.name}-${index}`} style={styles.provenance}>
                <Text style={styles.provenanceName}>{price}</Text>
                <Text style={styles.detail}>{captured}</Text>
                {url === null || linkLabel === null ? null : (
                  <LinkText label={linkLabel} name={used.name} onPress={() => openUrl(url)} />
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </Card>
  );
}

export default function SuggestionsScreen(): ReactElement {
  const meetupId = useLocalSearchParams<{ id: string }>().id ?? '';
  const [appliedBudget, setAppliedBudget] = useState<number | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [expandedPlaceId, setExpandedPlaceId] = useState<string | null>(null);
  const openedPlaces = useRef<Set<string>>(new Set());
  // The route writes state, so it is read once per applied budget: a refocus or a reconnect would
  // spend a rate-limited write on an answer that cannot have changed (AAP 0.5.4).
  const suggestions = useQuery({
    queryKey: queryKeys.suggestions(meetupId, appliedBudget ?? undefined),
    queryFn: () => apiClient.getSuggestions(meetupId, appliedBudget ?? undefined),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 60_000,
    retry: (failureCount, error) =>
      isApiError(error) && error.code === 'network_error' && failureCount < 2,
    enabled: meetupId.length > 0,
  });
  const { budgetCents, emptyReason, items = [] } = suggestions.data ?? {};
  const entered = budgetDraft ?? (budgetCents === undefined ? '' : formatUsdAmount(budgetCents));
  const budgetFieldError = budgetError ?? budgetFieldErrorFor(suggestions.error);
  const errorNotice = meetupId.length === 0 ? UNAVAILABLE : bannerMessageFor(suggestions.error);
  useEffect(() => {
    const spoken = budgetFieldError ?? errorNotice;
    if (spoken !== null) announce(spoken);
  }, [budgetFieldError, errorNotice]);
  const applyBudget = (): void => {
    const cents = budgetFromText(entered);
    if (cents === null) {
      setBudgetError(BUDGET_ERROR);
      return;
    }
    setBudgetError(null);
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
    const event: ClientEventRequest = {
      name: 'suggestion_place_opened',
      meetupId,
      placeId: item.placeId,
      placeCategory: item.category,
    };
    void apiClient.postEvent(event).catch(() => {});
  };
  const emptyMessage =
    emptyReason === undefined ? SUGGESTIONS_EMPTY.no_priced_places : SUGGESTIONS_EMPTY[emptyReason];
  // Retryable: the two failures a second attempt can answer differently — a suggestion service that
  // was briefly unavailable, and a request that never reached the API. The terminal codes (the meetup
  // not locked, not found, or not the caller's) keep the banner without one, because the same request
  // would be refused again.
  const showRetry =
    isApiError(suggestions.error) &&
    (suggestions.error.code === 'suggestions_unavailable' ||
      suggestions.error.code === 'network_error');
  const card = (item: Suggestion): CardProps => ({ item, expandedPlaceId, onToggle: togglePlace });
  const osmNow = (): void => openUrl(OSM_COPYRIGHT_URL);
  const retryNow = (): void => void suggestions.refetch();
  const retryAction = showRetry ? { action: { label: 'Retry', onPress: retryNow } } : {};
  const budgetControl = (
    <View style={styles.budget}>
      <TextField
        label="Per-person budget (USD)"
        value={entered}
        onChangeText={changeBudget}
        error={budgetFieldError}
        inputMode="decimal"
        returnKeyType="done"
        onSubmitEditing={applyBudget}
        testID="suggestions-budget"
      />
      <Text style={styles.detail}>{'Your budget is shared with your counterpart.'}</Text>
      <Button label="Update budget" onPress={applyBudget} />
    </View>
  );
  const answer: ReactElement | ReactElement[] | null =
    suggestions.data === undefined ? (
      suggestions.isPending && errorNotice === null ? (
        <Text style={styles.detail}>{'Loading…'}</Text>
      ) : null
    ) : items.length === 0 ? (
      <Banner tone="info" message={emptyMessage} testID="suggestions-empty" />
    ) : (
      items.map((item) => <SuggestionCard key={item.placeId} {...card(item)} />)
    );
  return (
    <Screen testID="suggestions-screen">
      <Stack.Screen options={{ title: 'Plan the day' }} />
      {errorNotice === null ? null : <Banner tone="error" message={errorNotice} {...retryAction} />}
      {suggestions.data === undefined ? null : budgetControl}
      {answer}
      <LinkText label={OSM_ATTRIBUTION} onPress={osmNow} testID="osm-attribution" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  badge: { ...typography.caption, color: colors.primary, fontWeight: fontWeights.bold },
  budget: { gap: spacing.sm },
  category: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  cost: { ...typography.body, color: colors.text, fontWeight: fontWeights.bold },
  detail: { ...typography.body, color: colors.textMuted },
  link: { ...typography.body, color: colors.primary, textDecorationLine: 'underline' },
  linkFocused: { borderColor: colors.focusRing },
  linkHovered: { backgroundColor: colors.surface },
  linkPressed: { backgroundColor: colors.surface },
  // Reserved focus ring, the treatment the attribution page's external link uses: the 2px band is
  // painted in the fill the text sits on until the link takes keyboard focus, so revealing the ring
  // never moves the label, and the reset above leaves that band as the ring a keyboard user sees.
  linkTarget: {
    alignSelf: 'flex-start',
    borderColor: colors.background,
    borderRadius: radii.sm,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
  },
  provenance: { gap: spacing.xs },
  provenanceList: {
    borderTopColor: colors.border,
    borderTopWidth: borderWidths.separator,
    gap: spacing.md,
    paddingTop: spacing.md,
  },
  provenanceName: { ...typography.body, color: colors.text },
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
  toggleFocused: { borderColor: colors.focusRing },
  toggleHovered: { backgroundColor: colors.surface },
  toggleLabel: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
  togglePressed: { backgroundColor: colors.surface },
});
