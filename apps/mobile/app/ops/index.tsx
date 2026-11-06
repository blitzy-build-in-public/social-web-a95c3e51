/**
 * The operator dashboard, route `app/ops/index` (AAP 0.5.8, AAP 0.8.1): the pilot's headline measure
 * and every figure behind it, read from `GET /v1/admin/metrics` (AAP 0.5.7).
 *
 * One number leads, and only one: the meetup completion rate — meetups both attendees checked in
 * for, over meetups that reached two locked holds. Signups is a secondary figure and sits last on
 * the page (AAP 0.1.1). The pilot's two reference thresholds are drawn as marker lines and labelled
 * as reference values, never as targets this build enforces (AAP 0.7.3).
 *
 * Everything shown comes from `MetricsDto` as the API returned it, with no aggregation here: the
 * arithmetic is display scaling alone — the lock rate, a percentage and a bar's width. The variant
 * filter selects a `VariantPairing`, which a meetup carries fixed at proposal, so every meetup
 * counts exactly once and no participant-weighted reading exists (AAP 0.5.7).
 *
 * The area is web only and gated by `./_layout`; that gate is presentation, not authorization — the
 * API answers `403 operator_only` to anybody else, which the error banner shows as "Operator access
 * required." (AAP 0.3.2). Colour, spacing, radius and type come from `@tablemate/shared` ui-tokens,
 * the bars are inline `react-native-svg` shapes because no chart library is a dependency, and
 * nothing here logs (AAP 0.11.1).
 */
import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Svg, { Line, Rect } from 'react-native-svg';
import {
  DateOnly,
  MIN_TOUCH_TARGET,
  VariantPairing,
  borderWidths,
  colors,
  fontWeights,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { CityDto, MetricsDto, MetricsQuery } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { queryKeys } from '../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../src/ui';

/** The page heading, and the title the router gives the document. */
const PAGE_TITLE = 'Operator dashboard';

/** The opening range: the last 30 days, both ends included, counted in UTC. */
const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;

/** Panel copy: a figure the API reports as null, an empty list, and nothing blocked. */
const NOTHING = '—';
const NO_ROWS = 'Nothing in this range.';
const NOTHING_BLOCKED = 'Nothing blocked.';

/** A reference marker's label, and the note that keeps it from reading as a target (AAP 0.7.3). */
const REFERENCE_LABEL = 'Pilot reference';
const REFERENCE_NOTE = 'A reference value for the pilot, not a target this build enforces.';

/** Loading, refusal and action copy; UI labels are not in the fixed-string table of AAP 0.5.8. */
const LOADING = 'Loading metrics…';
const OPERATOR_ONLY_MESSAGE = 'Operator access required.';
const RETRY = 'Retry';
const APPLY = 'Apply';

/** The date fields' labels, each stating the format it takes, and their validation copy. */
const FROM_LABEL = 'From (YYYY-MM-DD)';
const TO_LABEL = 'To (YYYY-MM-DD)';
const DATE_FORMAT_ERROR = 'Enter a date as YYYY-MM-DD.';
const RANGE_ORDER_ERROR = 'The end date must not be before the start date.';

/** The filter groups: each label is visible, and each is its radio group's accessible name. */
const CITY_GROUP_LABEL = 'City';
const VARIANT_GROUP_LABEL = 'Variant pairing';
const ALL_CITIES = 'All cities';
const ALL_PAIRINGS = 'All pairings';

/** The notice the spend panel carries while language-model use is suspended (AAP 0.5.6). */
const LLM_SUSPENDED_MESSAGE = 'Language-model use is suspended after a token-count mismatch';

/** The six call outcomes, keyed to the schema so a new outcome fails this file on typecheck. */
const CALL_OUTCOMES: readonly { key: keyof MetricsDto['calls']['byOutcome']; label: string }[] = [
  { key: 'completed', label: 'Completed' },
  { key: 'refused', label: 'Refused' },
  { key: 'do_not_call', label: 'Do not call' },
  { key: 'unreachable', label: 'Unreachable' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'no_answer', label: 'No answer' },
];

/** Bar geometry: its height, the inset around the fill, and the reference marker's two widths. */
const BAR_HEIGHT = 12;
const BAR_FILL_INSET = 2;
const BAR_FILL_RADIUS = (BAR_HEIGHT - BAR_FILL_INSET * 2) / 2;
const BAR_MARKER_WIDTH = 2;
const BAR_MARKER_CASING = 4;

/**
 * The responsive widths of the wrapping rows, named once: the date fields and the panel grow from
 * their own basis up to a floor, while the headline's two columns carry a basis and no floor, so a
 * row too narrow for its figures wraps them instead of squeezing them.
 */
const DATE_FIELD_BASIS = 180;
const DATE_FIELD_MIN_WIDTH = 160;
const PANEL_BASIS = 340;
const PANEL_MIN_WIDTH = 280;
const HEADLINE_MAIN_BASIS = 240;
const HEADLINE_ASIDE_BASIS = 200;

/**
 * React Native 0.76 declares no `outline` style, so on web the browser's own outline is turned off
 * and the border a control already paints is the ring a keyboard user sees (WCAG 2.4.7). Empty off
 * web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

/** The three fields of a `keydown` event this screen reads; React Native declares no key event. */
interface WebKeyEvent {
  readonly key?: string;
  readonly repeat?: boolean;
  readonly preventDefault?: () => void;
}

/**
 * Takes Space as an activation the responder withholds: react-native-web answers Enter for any
 * element but Space only for a native `button` or a `role="button"`, and each filter chip of this
 * dashboard is a radio. Enter is left to the responder, which would otherwise fire a press twice.
 */
function spaceActivates(activate: () => void): { onKeyDown?: (event: WebKeyEvent) => void } {
  if (Platform.OS !== 'web') return {};
  return {
    onKeyDown: (event) => {
      if (event.repeat === true) return;
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      // Space would otherwise scroll the page behind the chip.
      event.preventDefault?.();
      activate();
    },
  };
}

/**
 * The filter behind the request: the applied range and the two optional selections, each held as
 * `null` while it stands for "all" so the query is built without the key rather than with an
 * `undefined` one (`exactOptionalPropertyTypes`).
 */
interface Filters {
  readonly from: string;
  readonly to: string;
  readonly cityId: string | null;
  readonly variant: VariantPairing | null;
}

/** One label/value row of a panel: what it is and what it reads, both already text. */
type StatRow = readonly [label: string, value: string];

/**
 * A calendar date as `YYYY-MM-DD` in UTC, the form `DateOnly` and `MetricsQuery` carry (AAP 0.3.3).
 * `toISOString` is UTC by definition, which is the day the range is counted in.
 */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The range the dashboard opens on: today and the 29 days before it. */
function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const start = new Date(today.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  return { from: ymd(start), to: ymd(today) };
}

/**
 * The `MetricsQuery` a set of filters sends: `cityId` and `variant` are set only when a specific
 * value is chosen, because the API validates the query with a strict schema and an absent filter is
 * left out rather than sent empty (AAP 0.5.4).
 */
function metricsQuery(filters: Filters): MetricsQuery {
  const query: MetricsQuery = { from: filters.from, to: filters.to };
  if (filters.cityId !== null) query.cityId = filters.cityId;
  if (filters.variant !== null) query.variant = filters.variant;
  return query;
}

/**
 * A fraction in 0..1 as a percentage with one decimal, or `—` when there is none to show. Every rate
 * `MetricsDto` carries is a fraction, which is what the metric definitions compute (AAP 0.5.7).
 */
function percentText(fraction: number | null): string {
  return fraction === null ? NOTHING : `${(fraction * 100).toFixed(1)}%`;
}

/** A count as the text a panel shows it in. */
function countText(value: number): string {
  return String(value);
}

/** Micro-dollars as US dollars with two decimals: `3_200_000` reads `$3.20`. */
function usdText(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** A span of seconds as `2 h 5 min`, `45 min` or `0 min`, or `—` when the API reports none. */
function durationText(seconds: number | null): string {
  if (seconds === null) return NOTHING;

  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${minutes} min` : `${hours} h ${rest} min`;
}

/**
 * A shape's or a marker's width as a percentage of the bar, clamped inside 0..100%: a whole of zero
 * — nothing proposed in the range, or a day whose cap is zero — renders an empty track rather than
 * dividing by zero.
 */
function widthPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '0%';

  return `${(Math.min(Math.max(part / whole, 0), 1) * 100).toFixed(2)}%`;
}

/**
 * A city's display name, or its slug when the cities read holds no record for it: a per-city figure
 * with no city beside it would read as a bug (AAP 0.5.8).
 */
function cityLabel(cities: readonly CityDto[], cityId: string): string {
  return cities.find((city) => city.id === cityId)?.name ?? cityId;
}

/**
 * The code of a failed read, for {@link userMessageFor}. The client raises no error type other than
 * `ApiError`, so anything else is a network failure and no server text reaches a screen (AAP 0.5.4).
 */
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'network_error';
}

/** The five deposit-funnel stages, in order, with the count the API reported for each (AAP 0.5.7). */
function funnelStages(funnel: MetricsDto['funnel']): readonly { label: string; count: number }[] {
  return [
    { label: 'Proposals sent', count: funnel.proposalsSent },
    { label: 'Viewed by the recipient', count: funnel.proposalsViewed },
    { label: 'Recipient accepted', count: funnel.proposalsAccepted },
    { label: 'Both holds locked', count: funnel.bothLocked },
    { label: 'Both checked in', count: funnel.bothCheckedIn },
  ];
}

/** Props of {@link Bar}. */
interface BarProps {
  /** The figure the fill shows. */
  readonly value: number;
  /** The figure a full track stands for. Zero or less renders an empty track. */
  readonly max: number;
  /** A pilot reference marker, in the units of `value` and `max`. */
  readonly reference?: number | undefined;
  /**
   * What the bar stands for, phrased with the figures it draws. The text beside every bar carries
   * the same number, so the figure never rests on the graphic alone.
   */
  readonly accessibilityLabel: string;
}

/**
 * A horizontal bar: a track, a fill proportional to `value`, and an optional reference marker.
 *
 * The shapes are sized as percentages of the viewport rather than in measured pixels, so a bar needs
 * no layout pass and follows its column as the window resizes. The fill is the `primary` token over
 * the `surface` track — a recorded non-text pair at 6.59:1 — and the marker's core is laid on a band
 * of the track's own colour, because no single token clears 3:1 against both an empty track and the
 * fill, and the core has to stay legible over whichever part of the bar it crosses (WCAG 1.4.11).
 *
 * The graphic is decorative, so it is hidden from assistive technology on both platforms.
 */
function Bar({ value, max, reference, accessibilityLabel }: BarProps): ReactElement {
  const marker = reference === undefined ? null : widthPercent(reference, max);

  return (
    <Svg
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      width="100%"
      height={BAR_HEIGHT}
    >
      <Rect x={0} y={0} width="100%" height={BAR_HEIGHT} fill={colors.surface} />
      <Rect
        x={0}
        y={BAR_FILL_INSET}
        width={widthPercent(value, max)}
        height={BAR_HEIGHT - BAR_FILL_INSET * 2}
        rx={BAR_FILL_RADIUS}
        fill={colors.primary}
      />
      {marker === null ? null : (
        <Line
          x1={marker}
          y1={0}
          x2={marker}
          y2={BAR_HEIGHT}
          stroke={colors.surface}
          strokeWidth={BAR_MARKER_WIDTH + BAR_MARKER_CASING}
        />
      )}
      {marker === null ? null : (
        <Line
          x1={marker}
          y1={0}
          x2={marker}
          y2={BAR_HEIGHT}
          stroke={colors.text}
          strokeWidth={BAR_MARKER_WIDTH}
        />
      )}
    </Svg>
  );
}

/** One figure: its label, its value, and the bar that shows it against a whole. */
function MetricRow({
  label,
  value,
  bar,
}: {
  readonly label: string;
  readonly value: string;
  readonly bar?: ReactElement | undefined;
}): ReactElement {
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
      {bar ?? null}
    </View>
  );
}

/**
 * A figure drawn against a whole, which is the bar and its text together. `text` is the reading the
 * bar shows, so the two can never disagree.
 */
function BarRow({
  label,
  text,
  value,
  max,
  reference,
}: {
  readonly label: string;
  readonly text: string;
  readonly value: number;
  readonly max: number;
  readonly reference?: number | undefined;
}): ReactElement {
  return (
    <MetricRow
      label={label}
      value={text}
      bar={
        <Bar
          value={value}
          max={max}
          reference={reference}
          accessibilityLabel={`${label}: ${text}`}
        />
      }
    />
  );
}

/**
 * A list of figures, or the panel's empty line when the API returned none. The rows are built by
 * mapping, so a panel's figures are one array in source order rather than one element each.
 */
function StatRows({
  items,
  empty = NO_ROWS,
}: {
  readonly items: readonly StatRow[];
  /** What the panel shows when it has no row, such as when nothing is blocked. */
  readonly empty?: string | undefined;
}): ReactElement {
  if (items.length === 0) return <Text style={styles.caption}>{empty}</Text>;

  return (
    <>
      {items.map(([label, value]) => (
        <MetricRow key={label} label={label} value={value} />
      ))}
    </>
  );
}

/** One panel of the dashboard: a card in the wrapping grid of panels. */
function Panel({
  title,
  children,
  testID,
}: {
  readonly title: string;
  readonly children: ReactNode;
  /** Forwarded to the card, so a test can find a named panel. */
  readonly testID?: string | undefined;
}): ReactElement {
  return (
    <View style={styles.panel}>
      <Card title={title} {...(testID === undefined ? {} : { testID })}>
        {children}
      </Card>
    </View>
  );
}

/**
 * One option of a filter group, as a radio.
 *
 * The selection is carried by three things together and never by colour alone: `aria-checked`, the
 * label's weight and the border, which is what a reader who cannot see the tint still has
 * (WCAG 1.4.1). The border is painted in every state, so the focus ring cannot shift the layout, and
 * on web {@link webFocusRingReset} leaves that band as the ring a keyboard user sees (WCAG 2.4.7).
 * The target keeps {@link MIN_TOUCH_TARGET} as its minimum size (AAP 0.5.8).
 */
function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  /** The visible label, which is also the control's accessible name. */
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly testID?: string | undefined;
}): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      {...spaceActivates(onPress)}
      role="radio"
      aria-checked={selected}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={testID}
      style={[
        styles.chip,
        hovered && !selected ? styles.chipHovered : null,
        selected ? styles.chipSelected : null,
        focused ? styles.chipFocused : null,
        webFocusRingReset,
      ]}
    >
      <Text style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Every panel of the dashboard, in the order an operator reads them: the headline alone, then the
 * deposit funnel, the counts, the per-city proofs, the per-venue meetups, prices, calls, lodging
 * claims — and signups last, as the pilot's secondary figure (AAP 0.1.1).
 *
 * Nothing is aggregated here. The lock rate is the one derived figure, and it is the funnel's own two
 * stages read against each other, which the panel's label states (AAP 0.5.7).
 */
function Dashboard({
  metrics,
  cities,
}: {
  /** The metrics exactly as the API returned them (AAP 0.5.7). */
  readonly metrics: MetricsDto;
  /** The configured cities, for the names of the per-city figures. */
  readonly cities: readonly CityDto[];
}): ReactElement {
  const { completion, thresholds, funnel, counts, prices, calls, lodgingClaims, signups } = metrics;
  const lockRate =
    funnel.proposalsAccepted === 0 ? null : funnel.bothLocked / funnel.proposalsAccepted;
  const blocked = Object.entries(calls.lifecycle.blockedByReason).filter(([, count]) => count > 0);

  return (
    <>
      <Card testID="ops-completion-rate" title="Meetup completion rate">
        <View style={styles.headline}>
          <View style={styles.headlineMain}>
            <Text style={styles.rate}>{percentText(completion.rate)}</Text>
            <Text style={styles.body}>
              {`${completion.bothCheckedIn} of ${completion.lockedMeetups} locked meetups had both attendees check in`}
            </Text>
          </View>
          <View style={styles.headlineAside}>
            <Text style={styles.rateAside}>{countText(completion.openWindowMeetups)}</Text>
            <Text style={styles.caption}>still within their check-in window</Text>
          </View>
        </View>

        <Bar
          value={completion.rate ?? 0}
          max={1}
          reference={thresholds.completion}
          accessibilityLabel={`Meetup completion rate ${percentText(completion.rate)}, pilot reference ${percentText(thresholds.completion)}`}
        />
        <Text style={styles.caption}>
          {`${REFERENCE_LABEL}: ${percentText(thresholds.completion)}. ${REFERENCE_NOTE}`}
        </Text>
      </Card>

      <View style={styles.grid}>
        <Panel title="Deposit funnel">
          {funnelStages(funnel).map((stage) => (
            <BarRow
              key={stage.label}
              label={stage.label}
              text={countText(stage.count)}
              value={stage.count}
              max={funnel.proposalsSent}
            />
          ))}
          <BarRow
            label="Lock rate: accepted proposals that reached two holds"
            text={percentText(lockRate)}
            value={lockRate ?? 0}
            max={1}
            reference={thresholds.lockRate}
          />
          <Text style={styles.caption}>
            {`${REFERENCE_LABEL}: ${percentText(thresholds.lockRate)}. ${REFERENCE_NOTE}`}
          </Text>
        </Panel>

        <Panel title="Counts">
          <StatRows
            items={[
              ['No-shows (late cancellations included)', countText(counts.noShows)],
              ['Early cancellations', countText(counts.cancelledEarly)],
              ['Late cancellations', countText(counts.cancelledLate)],
              ['Holds lost', countText(counts.lockLost)],
              ['Disputes opened', countText(counts.disputesOpened)],
            ]}
          />
        </Panel>

        <Panel title="Active proofs per city">
          <StatRows
            items={metrics.activeProofsByCity.map((row): StatRow => [
              cityLabel(cities, row.cityId),
              countText(row.count),
            ])}
          />
        </Panel>

        <Panel title="Meetups per partner venue">
          <StatRows
            items={metrics.meetupsByVenue.map((venue): StatRow => [
              venue.venueName,
              countText(venue.count),
            ])}
          />
        </Panel>

        <Panel title="Prices and suggestions">
          <Text style={styles.subheading}>Places with a fresh price</Text>
          <StatRows
            items={prices.placesWithFreshPriceByCity.map((row): StatRow => [
              cityLabel(cities, row.cityId),
              countText(row.count),
            ])}
          />
          <StatRows
            items={[
              [
                'Partner-venue neighbourhoods with at least 10 priced places',
                percentText(prices.neighborhoodsCoveredShare),
              ],
              ['Meetups with suggestions viewed', countText(prices.meetupsWithSuggestionsViewed)],
              ['Places opened', countText(prices.placesOpened)],
            ]}
          />
        </Panel>

        <Panel title="Calls">
          {calls.llmSuspended ? (
            <Banner tone="warning" message={LLM_SUSPENDED_MESSAGE}>
              {`${countText(calls.llmCountMismatches)} ${calls.llmCountMismatches === 1 ? 'mismatch' : 'mismatches'} recorded`}
            </Banner>
          ) : null}

          <Text style={styles.subheading}>By outcome</Text>
          <StatRows
            items={CALL_OUTCOMES.map((outcome): StatRow => [
              outcome.label,
              countText(calls.byOutcome[outcome.key]),
            ])}
          />

          <Text style={styles.subheading}>Lifecycle</Text>
          <StatRows
            items={[
              ['Queued without an outcome', countText(calls.lifecycle.queuedWithoutOutcome)],
              ['In progress', countText(calls.lifecycle.inProgress)],
              ['Cancelled', countText(calls.lifecycle.cancelled)],
            ]}
          />
          <StatRows
            empty={NOTHING_BLOCKED}
            items={blocked.map(([reason, count]): StatRow => [reason, countText(count)])}
          />

          <Text style={styles.subheading}>Calls per day against the cap</Text>
          {calls.perDay.map((day) => (
            <BarRow
              key={`${day.cityId} ${day.localDate}`}
              label={`${cityLabel(cities, day.cityId)} · ${day.localDate}`}
              text={`${countText(day.calls)} / ${countText(day.cap)}`}
              value={day.calls}
              max={day.cap}
            />
          ))}
          {calls.perDay.length === 0 ? <Text style={styles.caption}>{NO_ROWS}</Text> : null}

          <Text style={styles.subheading}>Language-model spend against the cap</Text>
          {calls.spend.map((row) => (
            <BarRow
              key={`${row.cityId} ${row.localDate}`}
              label={`${cityLabel(cities, row.cityId)} · ${row.localDate}`}
              text={`${usdText(row.spendMicros)} of ${usdText(row.capMicros)}`}
              value={row.spendMicros}
              max={row.capMicros}
            />
          ))}
          {calls.spend.length === 0 ? <Text style={styles.caption}>{NO_ROWS}</Text> : null}
        </Panel>

        <Panel title="Lodging claims">
          <StatRows
            items={[
              ['Submitted', countText(lodgingClaims.submitted)],
              ['Verified', countText(lodgingClaims.verified)],
              ['Rejected', countText(lodgingClaims.rejected)],
              ['Unreachable', countText(lodgingClaims.unreachable)],
              ['Median time to resolve', durationText(lodgingClaims.medianResolveSeconds)],
            ]}
          />
        </Panel>

        <Panel testID="ops-signups" title="Signups (secondary)">
          <StatRows items={[['Accounts created', countText(signups)]]} />
        </Panel>
      </View>
    </>
  );
}

/**
 * The operator dashboard: the filters, the reads behind them, and the panels that render what the
 * API returned.
 *
 * The two date fields hold draft text and change the request only when applied — by the Apply button
 * or by Enter in either field. A draft that is not a `YYYY-MM-DD` date, or that reverses the range,
 * fails on its own field and leaves the previous request standing, so a mistyped date can never empty
 * the dashboard (AAP 0.5.4). A city or variant chip applies at once, because a single press is the
 * whole intent. Reading and focus order is source order: dates, Apply, city, variant, headline,
 * panels.
 *
 * The cities read is public and supplies only the names of the per-city figures: when it fails they
 * still render under their slugs, and the page's one banner belongs to the metrics read.
 *
 * @returns The operator dashboard.
 */
export default function OpsDashboardScreen(): ReactElement {
  const [filters, setFilters] = useState<Filters>(() => ({
    ...defaultRange(),
    cityId: null,
    variant: null,
  }));
  const [draftFrom, setDraftFrom] = useState(filters.from);
  const [draftTo, setDraftTo] = useState(filters.to);
  const [rangeError, setRangeError] = useState<{
    field: 'from' | 'to';
    message: string;
  } | null>(null);

  const query = metricsQuery(filters);
  const metrics = useQuery({
    queryKey: queryKeys.adminMetrics(query),
    queryFn: () => apiClient.admin.getMetrics(query),
  });
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });

  const failedCode = metrics.error === null ? undefined : errorCodeOf(metrics.error);
  const failure =
    failedCode === undefined
      ? null
      : failedCode === 'operator_only'
        ? OPERATOR_ONLY_MESSAGE
        : userMessageFor(failedCode);

  // Both messages are spoken as well as shown: iOS has no live region for a banner, and the words
  // spoken are the app's own copy, never server text (AAP 0.5.8, AAP 0.11.1).
  useEffect(() => {
    if (failure !== null) announce(failure);
  }, [failure]);

  useEffect(() => {
    if (rangeError !== null) announce(rangeError.message);
  }, [rangeError]);

  /**
   * Applies the two date fields. The dates are checked against the shared `DateOnly` schema, and
   * their order as strings — exact for fixed-width `YYYY-MM-DD` dates, and the comparison the API
   * makes itself (AAP 0.5.4).
   */
  function applyDates(): void {
    const from = draftFrom.trim();
    const to = draftTo.trim();

    if (!DateOnly.safeParse(from).success) {
      setRangeError({ field: 'from', message: DATE_FORMAT_ERROR });
      return;
    }
    if (!DateOnly.safeParse(to).success) {
      setRangeError({ field: 'to', message: DATE_FORMAT_ERROR });
      return;
    }
    if (from > to) {
      setRangeError({ field: 'to', message: RANGE_ORDER_ERROR });
      return;
    }

    setRangeError(null);
    setFilters((current) => ({ ...current, from, to }));
  }

  const cityItems = cities.data?.items ?? [];

  return (
    <>
      <Stack.Screen options={{ title: PAGE_TITLE }} />
      <Screen title={PAGE_TITLE}>
        <View style={styles.filters}>
          <View style={styles.dateRow}>
            <View style={styles.dateField}>
              <TextField
                label={FROM_LABEL}
                value={draftFrom}
                onChangeText={setDraftFrom}
                onSubmitEditing={applyDates}
                error={rangeError?.field === 'from' ? rangeError.message : null}
                autoCapitalize="none"
                autoCorrect={false}
                testID="ops-from"
              />
            </View>
            <View style={styles.dateField}>
              <TextField
                label={TO_LABEL}
                value={draftTo}
                onChangeText={setDraftTo}
                onSubmitEditing={applyDates}
                error={rangeError?.field === 'to' ? rangeError.message : null}
                autoCapitalize="none"
                autoCorrect={false}
                testID="ops-to"
              />
            </View>
            <Button variant="secondary" label={APPLY} onPress={applyDates} testID="ops-apply" />
          </View>

          <View style={styles.filterGroup}>
            <Text style={styles.filterLabel}>{CITY_GROUP_LABEL}</Text>
            <View role="radiogroup" aria-label={CITY_GROUP_LABEL} style={styles.chips}>
              <Chip
                label={ALL_CITIES}
                selected={filters.cityId === null}
                onPress={() => setFilters((current) => ({ ...current, cityId: null }))}
              />
              {cityItems.map((city) => (
                <Chip
                  key={city.id}
                  label={city.name}
                  selected={filters.cityId === city.id}
                  onPress={() => setFilters((current) => ({ ...current, cityId: city.id }))}
                  testID={`ops-city-${city.id}`}
                />
              ))}
            </View>
          </View>

          <View style={styles.filterGroup}>
            <Text style={styles.filterLabel}>{VARIANT_GROUP_LABEL}</Text>
            <View role="radiogroup" aria-label={VARIANT_GROUP_LABEL} style={styles.chips}>
              <Chip
                label={ALL_PAIRINGS}
                selected={filters.variant === null}
                onPress={() => setFilters((current) => ({ ...current, variant: null }))}
              />
              {VariantPairing.options.map((value) => (
                <Chip
                  key={value}
                  label={value}
                  selected={filters.variant === value}
                  onPress={() => setFilters((current) => ({ ...current, variant: value }))}
                  testID={`ops-variant-${value}`}
                />
              ))}
            </View>
          </View>
        </View>

        {failure === null ? null : (
          <Banner
            tone="error"
            message={failure}
            action={{ label: RETRY, onPress: () => void metrics.refetch() }}
          />
        )}

        {metrics.isPending ? <Text style={styles.body}>{LOADING}</Text> : null}

        {metrics.data === undefined ? null : (
          <Dashboard metrics={metrics.data} cities={cityItems} />
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  filters: { gap: spacing.md },
  dateRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  dateField: { flexBasis: DATE_FIELD_BASIS, flexGrow: 1, minWidth: DATE_FIELD_MIN_WIDTH },
  filterGroup: { gap: spacing.xs },
  // `text` on `background` is a recorded pair at 17.21:1, and the size is a token, so the label
  // follows the reader's system font size (AAP 0.5.8).
  filterLabel: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  // `surface` is the fill the rest of the app paints for a pointer over a control; the selected chip
  // keeps its stronger edge and label weight too, so the two states never read as one.
  chipHovered: { backgroundColor: colors.surface },
  chipSelected: { backgroundColor: colors.surface, borderColor: colors.primary },
  chipFocused: { borderColor: colors.focusRing },
  // `text` on `background` is 17.21:1 and `primary` on `surface` is 6.59:1: both recorded pairs.
  chipLabel: {
    color: colors.text,
    fontSize: typography.label.fontSize,
    fontWeight: fontWeights.medium,
    lineHeight: typography.label.lineHeight,
  },
  chipLabelSelected: { color: colors.primary, fontWeight: fontWeights.bold },
  // Panels wrap rather than stack: on a wide window the figures read side by side, and below the
  // width of one panel every row becomes a single column with no change of markup.
  grid: { alignItems: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  panel: { flexBasis: PANEL_BASIS, flexGrow: 1, minWidth: PANEL_MIN_WIDTH },
  headline: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  headlineMain: { flexBasis: HEADLINE_MAIN_BASIS, flexGrow: 1, gap: spacing.xs },
  headlineAside: { flexBasis: HEADLINE_ASIDE_BASIS, gap: spacing.xs },
  // The headline is the one figure the pilot is judged by, so it takes the display size (AAP 0.1.1).
  rate: { ...typography.display, color: colors.text, fontWeight: fontWeights.bold },
  rateAside: { ...typography.heading, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.text },
  // `textMuted` on `background` is a recorded pair at 7.07:1.
  caption: { ...typography.caption, color: colors.textMuted },
  subheading: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
  row: { gap: spacing.xs },
  rowHead: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  rowLabel: { ...typography.body, color: colors.text, flexShrink: 1 },
  rowValue: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
});
