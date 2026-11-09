/** The operator dashboard, route `app/ops/index`: the pilot's headline measure and every figure behind it, read from `GET /v1/admin/metrics`. */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import Svg, { Line, Rect } from 'react-native-svg';
import {
  BlockedReason,
  DateOnly,
  VariantPairing,
  colors,
  fontWeights,
  layout,
  spacing,
  typography,
} from '@tablemate/shared';
import type { CityDto, MetricsDto, MetricsQuery } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor, type ClientErrorCode } from '../../src/api/errors';
import { queryClient, queryKeys } from '../../src/state/meetup-store';
import { Banner, Button, Card, Chip, Screen, TextField, announce } from '../../src/ui';

const PAGE_TITLE = 'Operator dashboard';
const DEFAULT_RANGE_DAYS = 30;
const NOTHING = '—';
const NO_ROWS = 'Nothing in this range.';
const REFERENCE_LABEL = 'Pilot reference';
const REFERENCE_NOTE = 'A reference value for the pilot, not a target this build enforces.';
const DATE_FORMAT_ERROR = 'Enter a date as YYYY-MM-DD.';
const RANGE_ORDER_ERROR = 'The end date must not be before the start date.';
const DATE_HINT = 'Ten characters, as YYYY-MM-DD.';
const DATE_INPUT = {
  inputMode: 'numeric',
  keyboardType: 'numbers-and-punctuation',
  maxLength: 10,
} as const;
const CITY_GROUP_LABEL = 'City';
const VARIANT_GROUP_LABEL = 'Variant pairing';
const LLM_SUSPENDED_MESSAGE = 'Language-model use is suspended after a token-count mismatch';
const LLM_MISMATCH_MESSAGE =
  'A token-count mismatch suspends language-model use in every city until an operator re-enables it';
const LLM_SUSPENDED_STATE = 'Suspended in every city';
const LLM_ACTIVE_STATE = 'Active in every city';
const RE_ENABLE_LABEL = 'Re-enable language model';
const RE_ENABLED_NOTICE = 'Language-model use is re-enabled.';
const CALL_OUTCOMES: { key: keyof MetricsDto['calls']['byOutcome']; label: string }[] = [
  { key: 'completed', label: 'Completed' },
  { key: 'refused', label: 'Refused' },
  { key: 'do_not_call', label: 'Do not call' },
  { key: 'unreachable', label: 'Unreachable' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'no_answer', label: 'No answer' },
];
/** Each blocked reason in the words the operations runbook gives it, so no enum key leads a row. */
const BLOCKED_REASON_LABELS: Record<BlockedReason, string> = {
  not_allowlisted: 'Number not on the call allowlist',
  no_phone: 'No phone number',
  do_not_call: 'Number asked not to be called',
  invalid_number: 'Number is not valid',
  vendor_unavailable: 'Calling provider unavailable',
  dispatch_unknown: 'Dispatch unconfirmed',
  no_final_status: 'No final call status',
};
const BAR_FILL_RADIUS = (layout.barHeight - layout.barFillInset * 2) / 2;
const SVG_HIDDEN = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;
type Stat = readonly [label: string, value: string];
type Stage = readonly [label: string, text: string, value: number];
type DateField = 'from' | 'to';
type Filters = { from: string; to: string; cityId: string | null; variant: VariantPairing | null };
type RangeError = { field: DateField; message: string };
type MetricRowProps = { label: string; value: string; bar?: ReactElement | undefined };
type StatRowsProps = { items: readonly Stat[]; empty?: string | undefined };
type ReEnableControl = {
  readonly onPress: () => void;
  readonly busy: boolean;
  readonly failure: string | null;
};
type DashboardProps = {
  metrics: MetricsDto;
  cities: readonly CityDto[];
  reEnable: ReEnableControl;
};
type CityCount = { cityId: string; count: number };
type BarProps = { label: string; value: number; max: number; reference?: number | undefined };
type BarRowProps = { label: string; text: string; value: number; max: number; reference?: number };
type PanelProps = { title: string; rows?: readonly Stat[]; testID?: string; children?: ReactNode };
const ymd = (date: Date): string => date.toISOString().slice(0, 10);
const countText = (value: number): string => String(value);
const usdText = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;
const fieldError = (field: DateField, message: string): RangeError => ({ field, message });
const percentText = (fraction: number | null): string =>
  fraction === null ? NOTHING : `${(fraction * 100).toFixed(1)}%`;
const referenceLine = (value: number | null): string =>
  `${REFERENCE_LABEL}: ${percentText(value)}. ${REFERENCE_NOTE}`;
const mismatchCountLine = (count: number): string =>
  `${countText(count)} ${count === 1 ? 'mismatch' : 'mismatches'} recorded`;
function defaultFilters(): Filters {
  const today = new Date();
  const start = new Date(today.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000);
  return { from: ymd(start), to: ymd(today), cityId: null, variant: null };
}
function metricsQuery(filters: Filters): MetricsQuery {
  const query: MetricsQuery = { from: filters.from, to: filters.to };
  if (filters.cityId !== null) query.cityId = filters.cityId;
  if (filters.variant !== null) query.variant = filters.variant;
  return query;
}
function durationText(seconds: number | null): string {
  if (seconds === null) return NOTHING;
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes} min` : `${hours} h ${minutes % 60} min`;
}
function widthPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '0%';
  return `${(Math.min(Math.max(part / whole, 0), 1) * 100).toFixed(2)}%`;
}
function cityLabel(cities: readonly CityDto[], cityId: string): string {
  return cities.find((city) => city.id === cityId)?.name ?? cityId;
}
/** A reason this build does not know still reads as words, never as a raw enum key. */
function blockedReasonLabel(reason: string): string {
  const known = BlockedReason.options.find((option) => option === reason);
  if (known !== undefined) return BLOCKED_REASON_LABELS[known];
  const words = reason.replace(/_/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
const funnelStages = (f: MetricsDto['funnel']): readonly Stage[] => [
  ['Proposals sent', countText(f.proposalsSent), f.proposalsSent],
  ['Viewed by the recipient', countText(f.proposalsViewed), f.proposalsViewed],
  ['Recipient accepted', countText(f.proposalsAccepted), f.proposalsAccepted],
  ['Both holds locked', countText(f.bothLocked), f.bothLocked],
  ['Both checked in', countText(f.bothCheckedIn), f.bothCheckedIn],
];
const countRows = ({ counts }: MetricsDto): readonly Stat[] => [
  ['No-shows (late cancellations included)', countText(counts.noShows)],
  ['Early cancellations', countText(counts.cancelledEarly)],
  ['Late cancellations', countText(counts.cancelledLate)],
  ['Holds lost', countText(counts.lockLost)],
  ['Disputes opened', countText(counts.disputesOpened)],
];
const cityRows = (rows: readonly CityCount[], cities: readonly CityDto[]): readonly Stat[] =>
  rows.map((row): Stat => [cityLabel(cities, row.cityId), countText(row.count)]);
const venueRows = ({ meetupsByVenue }: MetricsDto): readonly Stat[] =>
  meetupsByVenue.map((row): Stat => [row.venueName, countText(row.count)]);
const priceRows = ({ prices }: MetricsDto): readonly Stat[] => [
  [
    'Partner-venue neighbourhoods with at least 10 priced places',
    percentText(prices.neighborhoodsCoveredShare),
  ],
  ['Meetups with suggestions viewed', countText(prices.meetupsWithSuggestionsViewed)],
  ['Places opened', countText(prices.placesOpened)],
];
const outcomeRows = ({ calls }: MetricsDto): readonly Stat[] =>
  CALL_OUTCOMES.map((outcome): Stat => [outcome.label, countText(calls.byOutcome[outcome.key])]);
const lifecycleRows = ({ calls: { lifecycle } }: MetricsDto): readonly Stat[] => [
  ['Queued without an outcome', countText(lifecycle.queuedWithoutOutcome)],
  ['In progress', countText(lifecycle.inProgress)],
  ['Cancelled', countText(lifecycle.cancelled)],
];
const blockedRows = (blocked: readonly (readonly [string, number])[]): readonly Stat[] =>
  blocked.map(([reason, count]): Stat => [blockedReasonLabel(reason), countText(count)]);
/** The spend section's state at all times: the mismatches recorded, and whether use is stopped. The suspension is fleet-wide, so no filter narrows it and no state can hide it. */
const spendRows = ({ calls }: MetricsDto): readonly Stat[] => [
  ['Token-count mismatches recorded', countText(calls.llmCountMismatches)],
  ['Language-model use', calls.llmSuspended ? LLM_SUSPENDED_STATE : LLM_ACTIVE_STATE],
];
/** A mismatch warns in both states: while use is stopped, and once an operator re-enables it. */
const llmWarningMessage = ({ llmSuspended }: MetricsDto['calls']): string =>
  llmSuspended ? LLM_SUSPENDED_MESSAGE : LLM_MISMATCH_MESSAGE;
const lodgingRows = ({ lodgingClaims }: MetricsDto): readonly Stat[] => [
  ['Submitted', countText(lodgingClaims.submitted)],
  ['Verified', countText(lodgingClaims.verified)],
  ['Rejected', countText(lodgingClaims.rejected)],
  ['Unreachable', countText(lodgingClaims.unreachable)],
  ['Median time to resolve', durationText(lodgingClaims.medianResolveSeconds)],
];
const signupRows = ({ signups }: MetricsDto): readonly Stat[] => [
  ['Accounts created', countText(signups)],
];
function Bar({ label, value, max, reference }: BarProps): ReactElement {
  const marker = reference === undefined ? null : widthPercent(reference, max);
  const fill = {
    width: widthPercent(value, max),
    height: layout.barHeight - layout.barFillInset * 2,
  };
  const ends = { x1: marker ?? 0, x2: marker ?? 0, y1: 0, y2: layout.barHeight };
  const markerLine = (stroke: string, strokeWidth: number): ReactElement => (
    <Line stroke={stroke} strokeWidth={strokeWidth} {...ends} />
  );
  return (
    <Svg
      {...SVG_HIDDEN}
      width="100%"
      height={layout.barHeight}
      accessibilityLabel={label}
      aria-hidden
    >
      <Rect x={0} y={0} width="100%" height={layout.barHeight} fill={colors.surface} />
      <Rect x={0} y={layout.barFillInset} rx={BAR_FILL_RADIUS} fill={colors.primary} {...fill} />
      {marker === null
        ? null
        : markerLine(colors.surface, layout.barMarkerWidth + layout.barMarkerCasing)}
      {marker === null ? null : markerLine(colors.text, layout.barMarkerWidth)}
    </Svg>
  );
}
const MetricRow = ({ label, value, bar }: MetricRowProps): ReactElement => (
  <View style={styles.row}>
    <View style={styles.rowHead}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
    {bar ?? null}
  </View>
);
function BarRow({ label, text, value, max, reference }: BarRowProps): ReactElement {
  const bar = <Bar label={`${label}: ${text}`} value={value} max={max} reference={reference} />;
  return <MetricRow label={label} value={text} bar={bar} />;
}
type BarDayProps<T> = { readonly cities: readonly CityDto[]; readonly day: T };
type CapDay = MetricsDto['calls']['perDay'][number];
type SpendDay = MetricsDto['calls']['spend'][number];
function StageBar({ max, stage }: { readonly max: number; readonly stage: Stage }): ReactElement {
  const [label, text, value] = stage;
  return <BarRow label={label} max={max} text={text} value={value} />;
}
function DayBar({ cities, day }: BarDayProps<CapDay>): ReactElement {
  const label = `${cityLabel(cities, day.cityId)} · ${day.localDate}`;
  const text = `${countText(day.calls)} / ${countText(day.cap)}`;
  return <BarRow label={label} max={day.cap} text={text} value={day.calls} />;
}
function SpendBar({ cities, day }: BarDayProps<SpendDay>): ReactElement {
  const label = `${cityLabel(cities, day.cityId)} · ${day.localDate}`;
  const usd = `${usdText(day.spendMicros)} of ${usdText(day.capMicros)}`;
  return <BarRow label={label} max={day.capMicros} text={usd} value={day.spendMicros} />;
}
function StatRows({ items, empty = NO_ROWS }: StatRowsProps): ReactElement {
  const rows = items.map(([label, value]) => <MetricRow key={label} label={label} value={value} />);
  return items.length === 0 ? <Text style={styles.caption}>{empty}</Text> : <>{rows}</>;
}
const Panel = ({ title, rows, testID, children }: PanelProps): ReactElement => (
  <View style={styles.panel}>
    <Card title={title} {...(testID === undefined ? {} : { testID })}>
      {rows === undefined ? children : <StatRows items={rows} />}
    </Card>
  </View>
);
/** Every panel of the dashboard, in the order an operator reads them, signups last (AAP 0.1.1). */
function Dashboard({ metrics, cities, reEnable }: DashboardProps): ReactElement {
  const { completion, thresholds, funnel, prices, calls } = metrics;
  const lockRate =
    funnel.proposalsAccepted === 0 ? null : funnel.bothLocked / funnel.proposalsAccepted;
  const blocked = Object.entries(calls.lifecycle.blockedByReason).filter(([, count]) => count > 0);
  const rateBar = { value: completion.rate ?? 0, max: 1, reference: thresholds.completion };
  const rateLabel = `Meetup completion rate ${percentText(completion.rate)}, pilot reference ${percentText(thresholds.completion)}`;
  const checkInLine = `${completion.bothCheckedIn} of ${completion.lockedMeetups} locked meetups had both attendees check in`;
  return (
    <>
      <Card title="Meetup completion rate" testID="ops-completion-rate">
        <View style={styles.headline}>
          <View style={styles.headlineMain}>
            <Text style={styles.rate}>{percentText(completion.rate)}</Text>
            <Text style={styles.body}>{checkInLine}</Text>
          </View>
          <View style={styles.headlineAside}>
            <Text style={styles.rateAside}>{countText(completion.openWindowMeetups)}</Text>
            <Text style={styles.caption}>still within their check-in window</Text>
          </View>
        </View>
        <Bar {...rateBar} label={rateLabel} />
        <Text style={styles.caption}>{referenceLine(thresholds.completion)}</Text>
      </Card>
      <View style={styles.grid}>
        <Panel title="Deposit funnel">
          {funnelStages(funnel).map((stage) => (
            <StageBar key={stage[0]} max={funnel.proposalsSent} stage={stage} />
          ))}
          <BarRow
            label="Lock rate: accepted proposals that reached two holds"
            text={percentText(lockRate)}
            value={lockRate ?? 0}
            max={1}
            reference={thresholds.lockRate}
          />
          <Text style={styles.caption}>{referenceLine(thresholds.lockRate)}</Text>
        </Panel>
        <Panel title="Counts" rows={countRows(metrics)} />
        <Panel title="Active proofs per city" rows={cityRows(metrics.activeProofsByCity, cities)} />
        <Panel title="Meetups per partner venue" rows={venueRows(metrics)} />
        <Panel title="Prices and suggestions">
          <Text style={styles.subheading}>Places with a fresh price</Text>
          <StatRows items={cityRows(prices.placesWithFreshPriceByCity, cities)} />
          <StatRows items={priceRows(metrics)} />
        </Panel>
        <Panel title="Calls">
          <Text style={styles.subheading}>By outcome</Text>
          <StatRows items={outcomeRows(metrics)} />
          <Text style={styles.subheading}>Lifecycle</Text>
          <StatRows items={lifecycleRows(metrics)} />
          <StatRows empty="Nothing blocked." items={blockedRows(blocked)} />
          <Text style={styles.subheading}>Calls per day against the cap</Text>
          {calls.perDay.map((day) => (
            <DayBar key={`${day.cityId} ${day.localDate}`} cities={cities} day={day} />
          ))}
          {calls.perDay.length === 0 ? <Text style={styles.caption}>{NO_ROWS}</Text> : null}
          <Text style={styles.subheading}>Language-model spend against the cap</Text>
          {/* The mismatch warning belongs with the two facts it qualifies: a counted mismatch suspends language-model use in every city until an operator re-enables it, so the stop is stated in the spend section itself. */}
          {calls.llmSuspended || calls.llmCountMismatches > 0 ? (
            <Banner tone="warning" message={llmWarningMessage(calls)}>
              {mismatchCountLine(calls.llmCountMismatches)}
            </Banner>
          ) : null}
          {calls.llmSuspended ? (
            <View style={styles.suspension}>
              {/* AAP 0.5.6 suspends use in every city until an operator re-enables it, so the one control that ends the suspension sits with the banner that reports it. */}
              <Button
                label={RE_ENABLE_LABEL}
                busy={reEnable.busy}
                onPress={reEnable.onPress}
                testID="ops-llm-re-enable"
              />
              {reEnable.failure === null ? null : (
                <Banner tone="error" message={reEnable.failure} />
              )}
            </View>
          ) : null}
          <StatRows items={spendRows(metrics)} />
          {calls.spend.map((day) => (
            <SpendBar key={`${day.cityId} ${day.localDate}`} cities={cities} day={day} />
          ))}
          {calls.spend.length === 0 ? <Text style={styles.caption}>{NO_ROWS}</Text> : null}
        </Panel>
        <Panel title="Lodging claims" rows={lodgingRows(metrics)} />
        <Panel title="Signups (secondary)" rows={signupRows(metrics)} testID="ops-signups" />
      </View>
    </>
  );
}

export default function OpsDashboardScreen(): ReactElement {
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [draftFrom, setDraftFrom] = useState(filters.from);
  const [draftTo, setDraftTo] = useState(filters.to);
  const [rangeError, setRangeError] = useState<RangeError | null>(null);
  const [reEnableFailure, setReEnableFailure] = useState<string | null>(null);
  const query = metricsQuery(filters);
  const fetchMetrics = (): Promise<MetricsDto> => apiClient.admin.getMetrics(query);
  const metrics = useQuery({ queryKey: queryKeys.adminMetrics(query), queryFn: fetchMetrics });
  // The operator's own read of the catalogue (AAP 0.5.4): the age-gated `GET /cities` would refuse an
  // operator who has recorded no consents, which is precisely the session this area admits.
  const cities = useQuery({ queryKey: queryKeys.adminCities, queryFn: apiClient.admin.listCities });
  // The operator's re-enable (AAP 0.5.6): the flag is cleared server-side, the news is spoken, and
  // the dashboard is re-read so the banner and the spend figures report the state it answered.
  const reEnable = useMutation({
    mutationFn: () => apiClient.admin.reEnableLanguageModel(),
    onSuccess: () => {
      setReEnableFailure(null);
      announce(RE_ENABLED_NOTICE);
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminMetrics(query) });
    },
    onError: (error: unknown) => {
      const code: ClientErrorCode = isApiError(error) ? error.code : 'network_error';
      setReEnableFailure(userMessageFor(code));
    },
  });
  let failure: string | null = null;
  if (metrics.error !== null) {
    const code: ClientErrorCode = isApiError(metrics.error) ? metrics.error.code : 'network_error';
    failure = code === 'operator_only' ? 'Operator access required.' : userMessageFor(code);
  }
  useEffect(() => (failure === null ? undefined : announce(failure)), [failure]);
  useEffect(() => (rangeError === null ? undefined : announce(rangeError.message)), [rangeError]);
  useEffect(
    () => (reEnableFailure === null ? undefined : announce(reEnableFailure)),
    [reEnableFailure],
  );
  function applyDates(): void {
    const f = draftFrom.trim();
    const t = draftTo.trim();
    if (!DateOnly.safeParse(f).success) return setRangeError(fieldError('from', DATE_FORMAT_ERROR));
    if (!DateOnly.safeParse(t).success) return setRangeError(fieldError('to', DATE_FORMAT_ERROR));
    if (f > t) return setRangeError(fieldError('to', RANGE_ORDER_ERROR));
    setRangeError(null);
    setFilters((current) => ({ ...current, from: f, to: t }));
  }
  const pickCity = (cityId: string | null): void =>
    setFilters((current) => ({ ...current, cityId }));
  const pickVariant = (variant: VariantPairing | null): void =>
    setFilters((current) => ({ ...current, variant }));
  const noCity = filters.cityId === null;
  const noVariant = filters.variant === null;
  const retry = { label: 'Retry', onPress: () => void metrics.refetch() };
  const reEnableControl: ReEnableControl = {
    onPress: () => reEnable.mutate(),
    busy: reEnable.isPending,
    failure: reEnableFailure,
  };
  const cityItems = cities.data?.items ?? [];
  const dateFields = [
    ['from', 'From (YYYY-MM-DD)', 'ops-from', draftFrom, setDraftFrom],
    ['to', 'To (YYYY-MM-DD)', 'ops-to', draftTo, setDraftTo],
  ] as const;
  return (
    <>
      <Stack.Screen options={{ title: PAGE_TITLE }} />
      <Screen title={PAGE_TITLE}>
        <View style={styles.filters}>
          <View style={styles.dateRow}>
            {dateFields.map(([field, label, testID, value, set]) => (
              <View key={field} style={styles.dateField}>
                <TextField
                  {...DATE_INPUT}
                  autoCapitalize="none"
                  autoCorrect={false}
                  error={rangeError?.field === field ? rangeError.message : null}
                  hint={rangeError?.field === field ? undefined : DATE_HINT}
                  label={label}
                  onChangeText={set}
                  onSubmitEditing={applyDates}
                  testID={testID}
                  value={value}
                />
              </View>
            ))}
            <View style={styles.apply}>
              <Button variant="secondary" label="Apply" onPress={applyDates} testID="ops-apply" />
            </View>
          </View>
          <View style={styles.filterGroup}>
            <Text style={styles.filterLabel}>{CITY_GROUP_LABEL}</Text>
            <View role="radiogroup" aria-label={CITY_GROUP_LABEL} style={styles.chips}>
              <Chip label="All cities" selected={noCity} onPress={() => pickCity(null)} />
              {cityItems.map((city) => (
                <Chip
                  key={city.id}
                  label={city.name}
                  selected={filters.cityId === city.id}
                  onPress={() => pickCity(city.id)}
                  testID={`ops-city-${city.id}`}
                />
              ))}
            </View>
          </View>
          <View style={styles.filterGroup}>
            <Text style={styles.filterLabel}>{VARIANT_GROUP_LABEL}</Text>
            <View role="radiogroup" aria-label={VARIANT_GROUP_LABEL} style={styles.chips}>
              <Chip label="All pairings" selected={noVariant} onPress={() => pickVariant(null)} />
              {VariantPairing.options.map((value) => (
                <Chip
                  key={value}
                  label={value}
                  selected={filters.variant === value}
                  onPress={() => pickVariant(value)}
                  testID={`ops-variant-${value}`}
                />
              ))}
            </View>
          </View>
        </View>
        {failure === null ? null : <Banner tone="error" message={failure} action={retry} />}
        {metrics.isPending ? <Text style={styles.body}>{'Loading metrics…'}</Text> : null}
        {metrics.data === undefined ? null : (
          <Dashboard cities={cityItems} metrics={metrics.data} reEnable={reEnableControl} />
        )}
      </Screen>
    </>
  );
}
/** The wrapping rows take their responsive widths from the `layout` tokens' `*Basis` and `*MinWidth` pairs, named once there rather than per row. */
const WRAP = { flexDirection: 'row', flexWrap: 'wrap' } as const;

const styles = StyleSheet.create({
  filters: { gap: spacing.md },
  dateRow: { alignItems: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  dateField: {
    flexBasis: layout.dateFieldBasis,
    flexGrow: 1,
    minWidth: layout.dateFieldMinWidth,
  },
  apply: { paddingTop: typography.label.lineHeight + spacing.xs },
  filterGroup: { gap: spacing.xs },
  filterLabel: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  grid: { alignItems: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  panel: { flexBasis: layout.panelBasis, flexGrow: 1, minWidth: layout.panelMinWidth },
  headline: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  headlineMain: { flexBasis: layout.headlineMainBasis, flexGrow: 1, gap: spacing.xs },
  headlineAside: { flexBasis: layout.headlineAsideBasis, gap: spacing.xs },
  rate: { ...typography.display, color: colors.text, fontWeight: fontWeights.bold },
  rateAside: { ...typography.heading, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.text },
  caption: { ...typography.caption, color: colors.textMuted },
  subheading: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
  suspension: { gap: spacing.sm },
  row: { gap: spacing.xs },
  rowHead: { ...WRAP, alignItems: 'baseline', gap: spacing.sm, justifyContent: 'space-between' },
  rowLabel: { ...typography.body, color: colors.text, flexShrink: 1 },
  rowValue: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
});
