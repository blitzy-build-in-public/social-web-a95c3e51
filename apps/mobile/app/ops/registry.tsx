/** Operator registry, route `/ops/registry` (AAP 0.5.4, 0.5.6, 0.8.1, requirements 10, 14 and 15):
 * venue and lodging onboarding, console secrets and price jobs. The lodging list is the registry's one
 * paged read: its city filter and search run on the server and its rows continue with the read's own
 * cursor, so a registry holding more rows than one page shows is still reachable (AAP 0.5.4). */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { ViewStyle } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import {
  CreateLodgingRequest,
  CreateVenueRequest,
  Latitude,
  LodgingKind,
  Longitude,
  MIN_TOUCH_TARGET,
  PriceJobRequest,
  UpdateVenueRequest,
  borderWidths,
  colors,
  fontWeights,
  layout,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type {
  AdminLodgingDto,
  AdminLodgingsQuery,
  AdminVenueDto,
  CityDto,
  PriceJobKind,
} from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { queryClient, queryKeys } from '../../src/state/meetup-store';
import { Banner, Button, Card, Chip, Screen, Switch, TextField, announce } from '../../src/ui';
import type { SwitchProps } from '../../src/ui';

const SCREEN_TITLE = 'Operator registry';
const NO_FIELD_ERRORS: FieldErrors = {};
const REGISTRY_MESSAGES: Readonly<Record<string, string>> = {
  operator_only: 'Operator access required.',
  city_not_found: 'City not found.',
  not_found: 'Not found.',
  invalid_field: 'Check the highlighted fields.',
  daily_cap_reached: "Today's cap for this city is used up.",
};
const VENUES_HEADING = 'Venues';
const LODGINGS_HEADING = 'Lodgings';
const NAME_LABEL = 'Name';
const ADDRESS_LABEL = 'Address';
const LAT_LABEL = 'Latitude';
const LNG_LABEL = 'Longitude';
const PHONE_HINT = 'For example +351… Leave it empty when the lodging has no callable number.';
const PHONE_LABEL = 'Phone (E.164)';
const PHONE_FORM_MESSAGE =
  'Enter the number in international form, starting with + and the country code.';
const CITY_LABEL = 'City';
const KIND_LABEL = 'Kind';
const ACTIVE_PARTNER_LABEL = 'Active partner';
const FIXTURE_BADGE = 'Fixture';
const SECRET_COPIED = 'Secret copied.';
const LODGINGS_EMPTY = 'No lodgings in this city. Add one below, or wait for the weekly refresh.';
const LODGINGS_SEARCH_LABEL = 'Search by name';
// How long typing pauses before the search term is sent to the server, so one search reads one page
// rather than one per keystroke (the call-task queue waits the same 300 ms).
const LODGINGS_SEARCH_DEBOUNCE_MS = 300;
// The most a search term may carry, which is the bound the contract's own schema puts on `q`. A
// lodging's name runs to 120 characters, so a term is cut here rather than answered with `400
// invalid_field`; the cut term is a prefix of the name, which matches the same row.
const LODGINGS_SEARCH_MAX = 80;
const LODGINGS_MORE = { label: 'Load more lodgings', variant: 'secondary' } as const;
const SECRET_COPY_FAILED = 'Copy failed. Select the text and copy it yourself.';
const VENUES_EMPTY = 'No venues in this city. Add one below.';
const LODGING_CREATE_ID = 'ops-lodging-create';
const REISSUE_WARNING =
  'Issuing a new secret replaces the current one; the console must sign in again.';
const LODGING_SECRET_HINT =
  'Issuing a console secret makes this lodging a partner and adds nearby places to the price pipeline.';
const LODGING_KIND_LABEL = { guesthouse: 'Guest house', hostel: 'Hostel', hotel: 'Hotel' };
const SECTION_HEADING = { 'aria-level': 2, role: 'heading' } as const;
/** A card fills the cell it sits in: inside a wrapping row the cell is as tall as the row's tallest
 * one, so every card on that row ends where its neighbours do (QA qa8b-24). */
const FILL_SLOT: ViewStyle = { flexGrow: 1 };
const BLANK_DRAFT = { address: '', cityId: '', lat: '', lng: '', name: '' };
const EMPTY_VENUE_DRAFT: VenueDraft = { ...BLANK_DRAFT, isActivePartner: true };
const EMPTY_LODGING_DRAFT: LodgingDraft = { ...BLANK_DRAFT, kind: 'hostel', phone: '' };
// The caps the admin schemas impose on the two text fields, read from the schemas themselves so a
// hint, a rejection and an input's `maxLength` can never drift from the rule the API enforces
// (AAP 0.11.1: one schema per shape, imported where used and never redeclared). The edit form
// validates with `UpdateVenueRequest`, which carries the same cap inside an optional, so all three
// schemas must agree on it.
const NAME_MAX = cappedAt(
  CreateVenueRequest.shape.name,
  CreateLodgingRequest.shape.name,
  UpdateVenueRequest.shape.name.unwrap(),
);
const ADDRESS_MAX = cappedAt(
  CreateVenueRequest.shape.address,
  CreateLodgingRequest.shape.address,
  UpdateVenueRequest.shape.address.unwrap(),
);
const NAME_HINT = `Up to ${NAME_MAX} characters.`;
const ADDRESS_HINT = `Up to ${ADDRESS_MAX} characters.`;
const LATITUDE_RANGE = between(Latitude);
const LONGITUDE_RANGE = between(Longitude);
type TextRule = Readonly<{ cap: number; empty: string; over: (limit: number) => string }>;
/** What a rejected text field says (QA qa8b-25): what to enter while it is empty, and the sentence
 * for a value over the schema's own cap. */
const TEXT_RULES: Readonly<Record<'address' | 'name', TextRule>> = {
  address: {
    cap: ADDRESS_MAX,
    empty: 'Enter the address.',
    over: (limit) => `Use ${limit} characters or fewer in the address.`,
  },
  name: {
    cap: NAME_MAX,
    empty: 'Enter a name.',
    over: (limit) => `Use ${limit} characters or fewer in the name.`,
  },
};
/** The range each coordinate states. An empty or unparsable value fails before Zod checks a bound,
 * so both bounds come from the schema rather than from the issue, which carries at most one. */
const COORDINATE_MESSAGES = {
  lat: `Enter a latitude between ${LATITUDE_RANGE[0]} and ${LATITUDE_RANGE[1]}.`,
  lng: `Enter a longitude between ${LONGITUDE_RANGE[0]} and ${LONGITUDE_RANGE[1]}.`,
} as const;
const VENUE_FIELDS = [
  {
    input: { hint: NAME_HINT, inputMode: 'text', maxLength: NAME_MAX },
    key: 'name',
    label: NAME_LABEL,
  },
  {
    input: { hint: ADDRESS_HINT, inputMode: 'text', maxLength: ADDRESS_MAX },
    key: 'address',
    label: ADDRESS_LABEL,
  },
  { input: { inputMode: 'decimal' }, key: 'lat', label: LAT_LABEL },
  { input: { inputMode: 'decimal' }, key: 'lng', label: LNG_LABEL },
] as const;
const LODGING_FIELDS = [
  {
    input: { hint: NAME_HINT, inputMode: 'text', maxLength: NAME_MAX },
    key: 'name',
    label: NAME_LABEL,
  },
  {
    input: { hint: ADDRESS_HINT, inputMode: 'text', maxLength: ADDRESS_MAX },
    key: 'address',
    label: ADDRESS_LABEL,
  },
  { input: { hint: PHONE_HINT, inputMode: 'tel' }, key: 'phone', label: PHONE_LABEL },
  { input: { inputMode: 'decimal' }, key: 'lat', label: LAT_LABEL },
  { input: { inputMode: 'decimal' }, key: 'lng', label: LNG_LABEL },
] as const;
const ISSUED_DATE = { day: 'numeric', month: 'short', year: 'numeric' } as const;
const ISSUED_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' } as const;
const ISSUED_AT_FORMAT: Intl.DateTimeFormatOptions = { ...ISSUED_DATE, ...ISSUED_TIME };
const CHIP_GROUPS = {
  lodgingCity: { all: true, label: `${LODGINGS_HEADING} city filter`, prefix: 'ops-lodging-city' },
  lodgingNew: { label: CITY_LABEL, prefix: 'ops-lodging-new-city' },
  venueCity: { all: true, label: `${VENUES_HEADING} city filter`, prefix: 'ops-venue-city' },
  venueNew: { label: CITY_LABEL, prefix: 'ops-venue-new-city' },
} as const;

// A pending grid shows a few card-sized surfaces, tall enough to read as the cards that follow; the
// count is fixed and never a count of the data, and the height is a multiple of the touch target.
const PENDING_SLOTS = [0, 1, 2] as const;
const PENDING_CARD_MIN_HEIGHT = MIN_TOUCH_TARGET * 5;

type ChipGroup = { readonly all?: boolean; readonly label: string; readonly prefix: string };
type ChipOption = { readonly id: string | null; readonly name: string };
const ALL_CITIES: ChipOption = { id: null, name: 'All cities' };
type FieldErrors = Readonly<Record<string, string>>;
type FieldName = 'address' | 'lat' | 'lng' | 'name' | 'phone';
/** The parts of a Zod issue this screen reads: which field failed, why, and any bound it carries. */
type FieldIssue = Readonly<{
  code: string;
  maximum?: number | bigint;
  message: string;
  path: readonly PropertyKey[];
}>;
type FieldDraft = Partial<Record<FieldName, string>>;
type FieldSpec = (typeof VENUE_FIELDS)[number] | (typeof LODGING_FIELDS)[number];
type FieldWiring = readonly [FieldErrors, IdOf, FieldDraft, WriteField];
type IdOf = (field: string) => string;
type WriteField = (field: string, value: string) => void;
type CitySelect = (cityId: string | null) => void;
type SecretTarget = Readonly<{ id: string; kind: 'venue' | 'lodging'; name: string }>;
type VenueEdit = { draft: VenueDraft; errors: FieldErrors; id: string; original: VenueDraft };
type SecretReveal = { kind: SecretTarget['kind']; name: string; secret: string };
type VenueDraft = Readonly<typeof BLANK_DRAFT & { isActivePartner: boolean }>;
type LodgingDraft = Readonly<typeof BLANK_DRAFT & { kind: LodgingKind; phone: string }>;

function messageFor(error: unknown): string {
  const code = isApiError(error) ? error.code : 'invalid_response';
  return REGISTRY_MESSAGES[code] ?? userMessageFor(code);
}
function createCountFormatter(): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat();
  } catch {
    return null;
  }
}
const COUNT_FORMATTER = createCountFormatter();
/** A count as an operator reads it, grouped by the runtime's locale where it has number formats. */
function formatCount(value: number): string {
  return COUNT_FORMATTER?.format(value) ?? String(value);
}
/**
 * The lodging registry's query string: only the filters that are actually set, because the route
 * validates the query with a strict schema and answers `400 invalid_field` for a value it cannot read,
 * and because `exactOptionalPropertyTypes` forbids handing it an empty one. `limit` is left out on
 * purpose: the read's own page of 200 is the page this screen has always shown, and the control below
 * the rows continues from it (AAP 0.5.4).
 */
function lodgingsQuery(cityId: string | null, term: string): AdminLodgingsQuery {
  const query: AdminLodgingsQuery = {};

  if (cityId !== null) query.cityId = cityId;
  if (term !== '') query.q = term;

  return query;
}
function failFields(errors: FieldErrors, setErrors: (errors: FieldErrors) => void): void {
  setErrors(errors);
  announce('Check the highlighted fields.');
}
const isFieldKey = (key: PropertyKey | undefined): key is string => typeof key === 'string';
/**
 * The character cap the given admin schemas put on one field, read from the schemas themselves so
 * no number is written twice in the app. A schema that stops carrying the cap, or two that disagree
 * about it, fails here — at import, in the test run — rather than showing an operator a limit the
 * API no longer enforces.
 */
function cappedAt(...schemas: readonly { readonly maxLength?: number | null }[]): number {
  const caps = schemas.map((schema) => schema.maxLength);
  const cap = caps[0];
  if (typeof cap !== 'number' || caps.some((other) => other !== cap)) {
    throw new Error('These admin schemas no longer share one character cap for this field.');
  }
  return cap;
}
/** The range a coordinate schema allows, read from the schema for the reason `cappedAt` gives. */
function between(schema: {
  readonly maxValue?: number | null;
  readonly minValue?: number | null;
}): readonly [number, number] {
  const { maxValue, minValue } = schema;
  if (typeof minValue !== 'number' || typeof maxValue !== 'number') {
    throw new Error('This coordinate schema no longer carries a numeric range.');
  }
  return [minValue, maxValue];
}
/** The bound a rejection states: the number Zod reports on the issue, or the schema's own cap when
 * the value failed before any bound was checked, as an empty one does. */
function limitOf(issue: FieldIssue, cap: number): number {
  return typeof issue.maximum === 'number' ? issue.maximum : cap;
}
/**
 * What one rejected field shows (QA qa8b-25): the rule it broke and the limit that rule sets, in the
 * field's own terms — what to enter, how many characters are allowed, which range a coordinate takes,
 * which form a phone number takes. Anything else repeats the message the shared schema itself gives,
 * which is what its cross-field refinements say, such as "Supply `lat` and `lng` together."
 */
function fieldMessage(issue: FieldIssue): string {
  const field = issue.path[0];
  if (field === 'name' || field === 'address') {
    const rule = TEXT_RULES[field];
    if (issue.code === 'too_small') return rule.empty;
    return issue.code === 'too_big' ? rule.over(limitOf(issue, rule.cap)) : issue.message;
  }
  if (field === 'lat' || field === 'lng') {
    const offRange =
      issue.code === 'too_big' || issue.code === 'too_small' || issue.code === 'invalid_type';
    return offRange ? COORDINATE_MESSAGES[field] : issue.message;
  }
  const badPhone = field === 'phone' && issue.code === 'invalid_format';
  return badPhone ? PHONE_FORM_MESSAGE : issue.message;
}
function fieldErrorsFrom(issues: readonly FieldIssue[]): FieldErrors {
  const entries: [string, string][] = [];
  for (const issue of issues) {
    const field = issue.path[0];
    if (isFieldKey(field)) entries.push([field, fieldMessage(issue)]);
  }
  return Object.fromEntries(entries);
}
/** The same errors without one field's, leaving every other field's message as it was (QA qa8b-25). */
function withoutField(errors: FieldErrors, field: string): FieldErrors {
  if (errors[field] === undefined) return errors;
  return Object.fromEntries(Object.entries(errors).filter(([key]) => key !== field));
}
function secretStatus(secretIssuedAt: string | null): string {
  if (secretIssuedAt === null) return 'No console secret';
  const at = new Date(secretIssuedAt);
  if (Number.isNaN(at.getTime())) return `Console secret issued ${secretIssuedAt}`;
  return `Console secret issued ${new Intl.DateTimeFormat('en-GB', ISSUED_AT_FORMAT).format(at)} UTC`;
}
function cityLabel(cities: readonly CityDto[], cityId: string): string {
  return cities.find((city) => city.id === cityId)?.name ?? cityId;
}
function clipboardWriter(): { writeText(text: string): Promise<void> } | null {
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return typeof clip?.writeText === 'function' ? clip : null;
}
function ignoreText(): void {}
type SwitchWiring = readonly [boolean, boolean, string, (next: boolean) => void, string];
/**
 * What one registry switch takes: the state the row holds, the label the row shows, the setter the
 * mutation owns and the test handle the operator's own specs name. A busy mutation blocks the control
 * until it answers, which is what `disabled` carries.
 */
function switchProps([on, busy, label, set, id]: SwitchWiring): SwitchProps {
  return { accessibilityLabel: label, disabled: busy, onValueChange: set, testID: id, value: on };
}
function venueDraftOf(venue: AdminVenueDto): VenueDraft {
  const { address, cityId, isActivePartner, name } = venue;
  return { address, cityId, isActivePartner, lat: String(venue.lat), lng: String(venue.lng), name };
}

function changedVenueFields(prior: VenueDraft, draft: VenueDraft) {
  const numbers = { lat: Number.parseFloat(draft.lat), lng: Number.parseFloat(draft.lng) };
  const before = { lat: Number.parseFloat(prior.lat), lng: Number.parseFloat(prior.lng) };
  const texts = (['name', 'address'] as const).filter((field) => draft[field] !== prior[field]);
  const changed = Object.fromEntries(texts.map((field) => [field, draft[field]] as const));
  const moved = numbers.lat !== before.lat || numbers.lng !== before.lng;
  return moved ? { ...changed, ...numbers } : changed;
}
function venuePayload(draft: VenueDraft): CreateVenueRequest {
  const numbers = { lat: Number.parseFloat(draft.lat), lng: Number.parseFloat(draft.lng) };
  const trimmed = { address: draft.address.trim(), name: draft.name.trim() };
  const { cityId, isActivePartner } = draft;
  return { ...trimmed, ...numbers, cityId, isActivePartner };
}
function lodgingPayload(draft: LodgingDraft): CreateLodgingRequest {
  const numbers = { lat: Number.parseFloat(draft.lat), lng: Number.parseFloat(draft.lng) };
  const trimmed = { address: draft.address.trim(), name: draft.name.trim() };
  const { cityId, kind, phone } = draft;
  const dial = phone.trim();
  return { ...trimmed, ...numbers, cityId, kind, phone: dial === '' ? null : dial };
}
/**
 * Writes one field of a draft and drops that field's rejection as it changes, so a message an
 * operator has just acted on does not sit under the field they are retyping (QA qa8b-25). Only the
 * field whose value changed can have stopped breaking its own rule; every other message stays.
 */
function fieldWriter<T extends object>(
  set: (update: (draft: T) => T) => void,
  clear: (field: string) => void,
) {
  return (field: string, value: string): void => {
    clear(field);
    set((draft) => ({ ...draft, [field]: value }));
  };
}
function idOf(prefix: string): IdOf {
  return (field: string) => `${prefix}-${field}`;
}
function button(variant: 'primary' | 'secondary') {
  return (label: string, onPress: () => void, busy: boolean) => ({ busy, label, onPress, variant });
}
const primary = button('primary');
const secondary = button('secondary');
function fieldRow(spec: FieldSpec, wiring: FieldWiring): ReactElement {
  const [errors, id, values, write] = wiring;
  const props = {
    error: errors[spec.key],
    label: spec.label,
    onChangeText: (text: string) => write(spec.key, text),
    testID: id(spec.key),
    value: values[spec.key] ?? '',
  };
  return <TextField key={spec.key} {...props} {...spec.input} />;
}
type CityChipsProps = {
  readonly all?: boolean;
  readonly cities: readonly CityDto[];
  readonly label: string;
  readonly onSelect: (cityId: string | null) => void;
  readonly prefix: string;
  readonly selected: string | null;
};
function CityChips(props: CityChipsProps): ReactElement {
  const { label, cities, selected, onSelect, all = false, prefix } = props;
  const options: readonly ChipOption[] = all ? [ALL_CITIES, ...cities] : cities;
  return (
    <View aria-label={label} role="radiogroup" style={styles.chips}>
      {options.map((option) => (
        <Chip
          key={option.id ?? 'all'}
          label={option.name}
          onPress={() => onSelect(option.id)}
          selected={selected === option.id}
          testID={`${prefix}-${option.id ?? 'all'}`}
        />
      ))}
    </View>
  );
}
type SecretCardProps = { readonly reveal: SecretReveal; readonly onDone: () => void };
function SecretCard({ reveal, onDone }: SecretCardProps): ReactElement {
  const writer = clipboardWriter();
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const subtitle = reveal.kind === 'venue' ? 'Venue' : 'Lodging';
  const copyButton = { ...secondary('Copy', () => void copy(), false), testID: 'ops-secret-copy' };
  async function copy(): Promise<void> {
    if (writer === null) return;
    try {
      await writer.writeText(reveal.secret);
      setCopyNote(SECRET_COPIED);
      announce(SECRET_COPIED);
    } catch {
      setCopyNote(SECRET_COPY_FAILED);
      announce(SECRET_COPY_FAILED);
    }
  }
  return (
    <Card subtitle={subtitle} testID="ops-secret" title={reveal.name}>
      <TextField
        hint={'This secret is shown only once. The console keeps it in this browser session only.'}
        label={'Console secret'}
        onChangeText={ignoreText}
        readOnly
        selectTextOnFocus
        testID="ops-secret-value"
        value={reveal.secret}
      />
      {copyNote === null ? null : <Text style={styles.meta}>{copyNote}</Text>}
      <View style={styles.actions}>
        {writer === null ? null : <Button {...copyButton} />}
        <Button {...primary('Done', onDone, false)} testID="ops-secret-done" />
      </View>
    </Card>
  );
}
type SecretControlsProps = {
  readonly confirming: boolean;
  readonly issued: boolean;
  readonly busy: boolean;
  readonly onIssue: () => void;
  readonly onStartReissue: () => void;
  readonly onKeep: () => void;
  readonly testID: string;
};
function SecretControls(props: SecretControlsProps): ReactElement {
  const { busy, confirming, issued, onIssue, onKeep, onStartReissue, testID } = props;
  const issueLabel = issued ? 'Reissue console secret' : 'Issue console secret';
  const issue = { ...secondary(issueLabel, issued ? onStartReissue : onIssue, busy), testID };
  const keep = { ...secondary('Keep current secret', onKeep, false), testID: `${testID}-keep` };
  const action = { label: 'Issue new secret', onPress: onIssue, testID: `${testID}-confirm` };
  const warning = { action, message: REISSUE_WARNING, tone: 'warning' as const };
  return (
    <View style={styles.actions}>
      {confirming ? <Button {...keep} /> : <Button {...issue} />}
      {confirming ? <Banner {...warning} testID={`${testID}-warning`} /> : null}
    </View>
  );
}
type ReadProps = Readonly<{ error: unknown; pending: boolean; retry: () => void; testID: string }>;
function announceIf(message: string | null): void {
  if (message !== null) announce(message);
}
function ReadState({ error, pending, retry, testID }: ReadProps): ReactElement {
  const action = { label: 'Try again', onPress: retry, testID: `${testID}-retry` };
  if (error === null) return <>{pending ? <Text style={styles.meta}>{'Loading…'}</Text> : null}</>;
  return (
    <Banner action={action} message={messageFor(error)} testID={`${testID}-error`} tone="error" />
  );
}
const errorBanner = (message: string | null, testID: string): ReactElement | null =>
  message === null ? null : <Banner message={message} testID={testID} tone="error" />;
type PendingGridProps = Readonly<{ minHeight: number; testID: string; wide: boolean }>;
/**
 * The room a card grid holds while its query is pending (QA qa8b-26). The grid is the tallest thing
 * on this screen — a few thousand pixels of venue cards on the web and one column of them four
 * times that on a phone — so a grid that renders nothing until its data lands pushes the create
 * form and every section after it down by that height, and the operator watches the page jump.
 * Reserving a viewport of space keeps everything below the grid below the fold until the cards
 * arrive, so nothing visible moves.
 *
 * The surfaces are the card's own tokens and carry nothing to read: `ReadState`'s "Loading…" line
 * stays the announced loading state, and no placeholder invents a name or a count.
 */
function PendingGrid({ minHeight, testID, wide }: PendingGridProps): ReactElement {
  const container = [styles.cards, wide ? styles.cardsRow : null, { minHeight }];
  return (
    <View aria-busy={true} style={container} testID={testID}>
      {PENDING_SLOTS.map((slot) => (
        <View key={slot} style={[wide ? styles.slot : null, styles.pendingCard]} />
      ))}
    </View>
  );
}

export default function OperatorRegistryScreen(): ReactElement {
  const { height: viewportHeight, width: viewportWidth } = useWindowDimensions();
  const wide = viewportWidth >= 900;
  const cardsStyle = [styles.cards, wide ? styles.cardsRow : null];
  // The operator's own read of the catalogue (AAP 0.5.4): the age-gated `GET /cities` would refuse an
  // operator who has recorded no consents, which is precisely the session this area admits, and the
  // venue and lodging forms below select a city from it.
  const cities = useQuery({ queryKey: queryKeys.adminCities, queryFn: apiClient.admin.listCities });
  const venues = useQuery({ queryFn: apiClient.admin.listVenues, queryKey: queryKeys.adminVenues });
  const [venueFilter, setVenueFilter] = useState<string | null>(null);
  const [lodgingFilter, setLodgingFilter] = useState<string | null>(null);
  const [lodgingSearch, setLodgingSearch] = useState('');
  const [lodgingTerm, setLodgingTerm] = useState('');
  const pendingLodgingSearch = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The filters travel to the server, so the city chips narrow the registry itself rather than a page
  // of it: a page holds at most 200 rows, and a city past the first page was invisible before.
  const lodgingQuery = useMemo(
    () => lodgingsQuery(lodgingFilter, lodgingTerm),
    [lodgingFilter, lodgingTerm],
  );
  const lodgings = useInfiniteQuery({
    queryKey: [...queryKeys.adminLodgings, lodgingQuery],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.admin.listLodgings(
        pageParam === undefined ? lodgingQuery : { ...lodgingQuery, cursor: pageParam },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const cityList: readonly CityDto[] = cities.data?.items ?? [];
  const [reveal, setReveal] = useState<SecretReveal | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [secretBusyId, setSecretBusyId] = useState<string | null>(null);
  const [reissueFor, setReissueFor] = useState<string | null>(null);
  const [venueDraft, setVenueDraft] = useState<VenueDraft>(EMPTY_VENUE_DRAFT);
  const [venueErrors, setVenueErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const [edit, setEdit] = useState<VenueEdit | null>(null);
  const [lodgingDraft, setLodgingDraft] = useState<LodgingDraft>(EMPTY_LODGING_DRAFT);
  const [lodgingErrors, setLodgingErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const [notice, setNotice] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<Readonly<Record<string, string>>>({});
  const [jobBusy, setJobBusy] = useState<string | null>(null);
  const clearVenueError = (field: string): void =>
    setVenueErrors((errors) => withoutField(errors, field));
  const clearLodgingError = (field: string): void =>
    setLodgingErrors((errors) => withoutField(errors, field));
  const writeVenue = fieldWriter(setVenueDraft, clearVenueError);
  const writeLodging = fieldWriter(setLodgingDraft, clearLodgingError);
  const venueRows: readonly AdminVenueDto[] = venues.data?.items ?? [];
  const lodgingRows = (lodgings.data?.pages ?? []).flatMap((page) => page.items);
  const lodgingTotal = lodgings.data?.pages[0]?.total ?? 0;
  const venueShown = venueRows.filter((row) => venueFilter === null || row.cityId === venueFilter);
  const venuesEmpty = !venues.isPending && venues.error === null && venueShown.length === 0;
  const lodgingsEmpty = !lodgings.isPending && lodgings.error === null && lodgingRows.length === 0;
  // What the page holds against what the filters match, which is what tells an operator that the list
  // is one page of a larger registry rather than the whole of it (AAP 0.5.4). No line when the filters
  // match a single lodging: it is on screen already, and the line would report one of one.
  const lodgingsCountLine =
    lodgingTotal <= 1 ? null : (
      <Text style={styles.meta} testID="ops-lodgings-count">
        {`Showing ${formatCount(lodgingRows.length)} of ${formatCount(lodgingTotal)} lodgings`}
      </Text>
    );
  const lodgingsMore = {
    ...LODGINGS_MORE,
    busy: lodgings.isFetchingNextPage,
    onPress: () => void lodgings.fetchNextPage(),
  };
  // The secret leaves with the screen's focus, whether the operator navigates away or the component unmounts (AAP 0.3.2).
  useFocusEffect(useCallback(() => () => setReveal(null), []));
  // A pending search pause is dropped with the component, so no timer outlives the screen.
  useEffect(
    () => () => {
      if (pendingLodgingSearch.current !== null) clearTimeout(pendingLodgingSearch.current);
    },
    [],
  );
  const createVenue = useMutation({
    mutationFn: (body: CreateVenueRequest) => apiClient.admin.createVenue(body),
    onSuccess: () => {
      setVenueDraft(EMPTY_VENUE_DRAFT);
      setVenueErrors(NO_FIELD_ERRORS);
      succeed('Venue created.', queryKeys.adminVenues);
    },
  });
  const updateVenue = useMutation({
    mutationFn: (input: { readonly id: string; readonly body: UpdateVenueRequest }) =>
      apiClient.admin.updateVenue(input.id, input.body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.adminVenues }),
  });
  const createLodging = useMutation({
    mutationFn: (body: CreateLodgingRequest) => apiClient.admin.createLodging(body),
    onSuccess: (created) => {
      setLodgingDraft(EMPTY_LODGING_DRAFT);
      setLodgingErrors(NO_FIELD_ERRORS);
      showLodging(created.name);
      succeed('Lodging created.', queryKeys.adminLodgings);
    },
  });
  const venueFailure = createVenue.error ?? updateVenue.error ?? null;
  const venueFailureMessage = venueFailure === null ? null : messageFor(venueFailure);
  const lodgingFailureMessage =
    createLodging.error === null ? null : messageFor(createLodging.error);
  useEffect(() => announceIf(venueFailureMessage), [venueFailureMessage]);
  useEffect(() => announceIf(lodgingFailureMessage), [lodgingFailureMessage]);
  function succeed(message: string, refresh?: readonly unknown[], reset?: () => void): void {
    reset?.();
    setNotice(message);
    announce(message);
    if (refresh !== undefined) void queryClient.invalidateQueries({ queryKey: refresh });
  }
  const edited = (): void => succeed('Venue updated.', undefined, () => setEdit(null));
  const refetchLodgings = (): void => void lodgings.refetch();
  /**
   * The search term is applied from the change handler after a pause in typing, never from an effect,
   * so one search reads one page rather than one per keystroke. Trimming here rather than at the
   * request keeps the field as the operator typed it.
   */
  function changeLodgingSearch(text: string): void {
    setLodgingSearch(text);
    if (pendingLodgingSearch.current !== null) clearTimeout(pendingLodgingSearch.current);
    pendingLodgingSearch.current = setTimeout(() => {
      pendingLodgingSearch.current = null;
      setLodgingTerm(text.trim().slice(0, LODGINGS_SEARCH_MAX));
    }, LODGINGS_SEARCH_DEBOUNCE_MS);
  }
  /**
   * Puts one lodging on the screen. The registry is paged in (city, name, id) order, so the row an
   * operator has just entered sits wherever its name falls among pages of the whole table: the city
   * filter is dropped — the list's filter is not the city the form entered the row in — and the search
   * is left naming that row, which is what makes the read answer it whatever the registry holds
   * (AAP 0.5.4). A search pause still pending is dropped with the term it would have applied.
   */
  function showLodging(name: string): void {
    const term = name.trim().slice(0, LODGINGS_SEARCH_MAX);

    if (pendingLodgingSearch.current !== null) {
      clearTimeout(pendingLodgingSearch.current);
      pendingLodgingSearch.current = null;
    }
    setLodgingFilter(null);
    setLodgingSearch(term);
    setLodgingTerm(term);
  }
  const secretControls = (row: AdminVenueDto | AdminLodgingDto, kind: SecretTarget['kind']) => ({
    busy: secretBusyId === row.id,
    confirming: reissueFor === row.id,
    issued: row.secretIssuedAt !== null,
    onIssue: () => void issueSecret({ id: row.id, kind, name: row.name }),
    onKeep: () => setReissueFor(null),
    onStartReissue: () => setReissueFor(row.id),
    testID: `ops-${kind}-secret-${row.id}`,
  });
  async function issueSecret(target: SecretTarget): Promise<void> {
    setSecretError(null);
    setReveal(null);
    setSecretBusyId(target.id);
    try {
      const issued =
        target.kind === 'venue'
          ? await apiClient.admin.issueVenueSecret(target.id)
          : await apiClient.admin.issueLodgingSecret(target.id);
      setReveal({ kind: target.kind, name: target.name, secret: issued.secret });
      setReissueFor(null);
      const secretKey = target.kind === 'venue' ? queryKeys.adminVenues : queryKeys.adminLodgings;
      await queryClient.invalidateQueries({ queryKey: secretKey });
    } catch (error) {
      const message = messageFor(error);
      setSecretError(message);
      announce(message);
    } finally {
      setSecretBusyId(null);
    }
  }
  async function runPriceJob(cityId: string, kind: PriceJobKind): Promise<void> {
    const parsed = PriceJobRequest.safeParse({ cityId, kind });
    if (!parsed.success) return setCityStatus(cityId, 'Check the highlighted fields.');
    setJobBusy(cityId);
    setCityStatus(cityId, 'Running…');
    try {
      const queued = await apiClient.admin.enqueuePriceJob(parsed.data);
      setCityStatus(cityId, `Queued (job ${queued.jobId})`);
    } catch (error) {
      setCityStatus(cityId, messageFor(error));
    } finally {
      setJobBusy(null);
    }
  }
  function setCityStatus(cityId: string, status: string): void {
    setJobStatus((previous) => ({ ...previous, [cityId]: status }));
    announce(status);
  }
  const newVenueCity = (cityId: string | null) => writeVenue('cityId', cityId ?? '');
  const newLodgingCity = (cityId: string | null) => writeLodging('cityId', cityId ?? '');
  function toggleEdit(venue: AdminVenueDto): void {
    const draft = venueDraftOf(venue);
    const open = edit !== null && edit.id === venue.id;
    setEdit(open ? null : { draft, errors: NO_FIELD_ERRORS, id: venue.id, original: draft });
  }
  function writeEdit(field: string, value: string): void {
    setEdit((open) =>
      open === null
        ? null
        : {
            ...open,
            draft: { ...open.draft, [field]: value },
            errors: withoutField(open.errors, field),
          },
    );
  }
  function saveVenueEdit(): void {
    if (edit === null) return;
    const parsed = UpdateVenueRequest.safeParse(changedVenueFields(edit.original, edit.draft));
    const apply = (errors: FieldErrors): void => setEdit({ ...edit, errors });
    if (!parsed.success) return failFields(fieldErrorsFrom(parsed.error.issues), apply);
    setEdit({ ...edit, errors: NO_FIELD_ERRORS });
    updateVenue.mutate({ body: parsed.data, id: edit.id }, { onSuccess: edited });
  }
  function submitVenue(): void {
    const parsed = CreateVenueRequest.safeParse(venuePayload(venueDraft));
    if (!parsed.success) return failFields(fieldErrorsFrom(parsed.error.issues), setVenueErrors);
    setVenueErrors(NO_FIELD_ERRORS);
    createVenue.mutate(parsed.data);
  }
  function submitLodging(): void {
    const parsed = CreateLodgingRequest.safeParse(lodgingPayload(lodgingDraft));
    if (!parsed.success) return failFields(fieldErrorsFrom(parsed.error.issues), setLodgingErrors);
    setLodgingErrors(NO_FIELD_ERRORS);
    createLodging.mutate(parsed.data);
  }
  const chips = (group: ChipGroup, selected: string | null, onSelect: CitySelect) => (
    <CityChips {...group} cities={cityList} onSelect={onSelect} selected={selected} />
  );
  function readState(error: unknown, pending: boolean, retry: () => void, testID: string) {
    return <ReadState error={error} pending={pending} retry={retry} testID={testID} />;
  }
  function renderVenue(venue: AdminVenueDto): ReactElement {
    const editing = edit !== null && edit.id === venue.id ? edit : null;
    const busy = updateVenue.isPending;
    const on = venue.isActivePartner;
    const id = (name: string): string => `ops-venue-${name}-${venue.id}`;
    const label = `${ACTIVE_PARTNER_LABEL}: ${venue.name}`;
    const change = (next: boolean) =>
      void updateVenue.mutate({ body: { isActivePartner: next }, id: venue.id });
    const toggle = (): void => toggleEdit(venue);
    const editLabel = editing === null ? 'Edit' : 'Cancel';
    const editButton = { ...secondary(editLabel, toggle, false), testID: id('edit') };
    const save = { ...primary('Save changes', saveVenueEdit, busy), testID: id('save') };
    const badge = venue.isFixture ? <Text style={styles.badge}>{FIXTURE_BADGE}</Text> : null;
    const subtitle = `${cityLabel(cityList, venue.cityId)} · ${venue.address}`;
    const card = { subtitle, testID: `ops-venue-${venue.id}`, title: venue.name, trailing: badge };
    const meta = `${venue.lat.toFixed(5)}, ${venue.lng.toFixed(5)} · ${secretStatus(venue.secretIssuedAt)}`;
    const editID = (field: string): string => `ops-venue-edit-${field}-${venue.id}`;
    const editFields =
      editing === null ? null : ([editing.errors, editID, editing.draft, writeEdit] as const);
    return (
      <View key={venue.id} style={wide ? styles.slot : null}>
        <Card {...card} style={FILL_SLOT}>
          <Text style={styles.meta}>{meta}</Text>
          <View style={styles.footer}>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{ACTIVE_PARTNER_LABEL}</Text>
              <Switch {...switchProps([on, busy, label, change, id('active')])} />
            </View>
            {editFields === null ? null : VENUE_FIELDS.map((field) => fieldRow(field, editFields))}
            <View style={styles.actions}>
              <Button {...editButton} />
              {editing === null ? null : <Button {...save} />}
            </View>
            <SecretControls {...secretControls(venue, 'venue')} />
          </View>
        </Card>
      </View>
    );
  }
  function renderLodging(lodging: AdminLodgingDto): ReactElement {
    const subtitle = `${cityLabel(cityList, lodging.cityId)} · ${LODGING_KIND_LABEL[lodging.kind]}`;
    const phone = `${lodging.phone ?? 'No phone'} (${lodging.phoneSource})`;
    const badges = (
      <View style={styles.badges}>
        {lodging.isFixture ? <Text style={styles.badge}>{FIXTURE_BADGE}</Text> : null}
        {lodging.doNotCall ? <Text style={styles.badge}>{'Do not call'}</Text> : null}
      </View>
    );
    const id = `ops-lodging-${lodging.id}`;
    const card = { subtitle, testID: id, title: lodging.name, trailing: badges };
    return (
      <View key={lodging.id} style={wide ? styles.slot : null}>
        <Card {...card} style={FILL_SLOT}>
          <Text style={styles.meta}>{lodging.address ?? 'No address'}</Text>
          <Text style={styles.meta}>{`${phone} · ${secretStatus(lodging.secretIssuedAt)}`}</Text>
          <Text style={styles.meta}>{LODGING_SECRET_HINT}</Text>
          <View style={styles.footer}>
            <SecretControls {...secretControls(lodging, 'lodging')} />
          </View>
        </Card>
      </View>
    );
  }
  function renderPriceJob(city: CityDto): ReactElement {
    const status = jobStatus[city.id];
    const busy = jobBusy === city.id;
    const id = (name: string): string => `ops-price-${name}-${city.id}`;
    const run = (kind: PriceJobKind) => () => void runPriceJob(city.id, kind);
    const subtitle = `${city.timezone} · ${city.currency}`;
    return (
      <View key={city.id} style={wide ? styles.slot : null}>
        <Card subtitle={subtitle} testID={`ops-price-${city.id}`} title={city.name}>
          <View style={styles.actions}>
            <Button {...primary('Run menu ingestion', run('menus'), busy)} testID={id('menus')} />
            <Button {...secondary('Run price calls', run('calls'), busy)} testID={id('calls')} />
            {status === undefined ? null : (
              <Text aria-live="polite" style={styles.meta} testID={id('status')}>
                {status}
              </Text>
            )}
          </View>
        </Card>
      </View>
    );
  }
  function renderVenueForm(): ReactElement {
    const busy = createVenue.isPending;
    const create = { ...primary('Create venue', submitVenue, busy), testID: 'ops-venue-create' };
    const on = venueDraft.isActivePartner;
    const setActive = (isActivePartner: boolean): void => {
      setVenueDraft((draft) => ({ ...draft, isActivePartner }));
    };
    const wire = [on, false, ACTIVE_PARTNER_LABEL, setActive, 'ops-venue-new-active'] as const;
    const fields = [venueErrors, idOf('ops-venue-new'), venueDraft, writeVenue] as const;
    return (
      <Card testID="ops-venue-form" title={'New venue'}>
        {chips(CHIP_GROUPS.venueNew, venueDraft.cityId || null, newVenueCity)}
        {VENUE_FIELDS.map((field) => fieldRow(field, fields))}
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{ACTIVE_PARTNER_LABEL}</Text>
          <Switch {...switchProps(wire)} />
        </View>
        <View style={styles.actions}>
          <Button {...create} />
        </View>
      </Card>
    );
  }
  function renderLodgingForm(): ReactElement {
    const busy = createLodging.isPending;
    const create = { ...primary('Create lodging', submitLodging, busy), testID: LODGING_CREATE_ID };
    const fields = [lodgingErrors, idOf('ops-lodging-new'), lodgingDraft, writeLodging] as const;
    return (
      <Card testID="ops-lodging-form" title={'New lodging'}>
        {chips(CHIP_GROUPS.lodgingNew, lodgingDraft.cityId || null, newLodgingCity)}
        <View aria-label={KIND_LABEL} role="radiogroup" style={styles.chips}>
          {LodgingKind.options.map((kind) => (
            <Chip
              key={kind}
              label={LODGING_KIND_LABEL[kind]}
              onPress={() => setLodgingDraft((draft) => ({ ...draft, kind }))}
              selected={lodgingDraft.kind === kind}
              testID={`ops-lodging-new-kind-${kind}`}
            />
          ))}
        </View>
        {LODGING_FIELDS.map((field) => fieldRow(field, fields))}
        <View style={styles.actions}>
          <Button {...create} />
        </View>
      </Card>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen testID="ops-registry" title={SCREEN_TITLE}>
        {reveal === null ? null : <SecretCard onDone={() => setReveal(null)} reveal={reveal} />}
        {errorBanner(secretError, 'ops-secret-error')}
        {notice === null ? null : <Banner message={notice} testID="ops-notice" tone="success" />}
        {readState(cities.error, cities.isPending, () => void cities.refetch(), 'ops-cities')}
        <View style={styles.section}>
          <Text {...{ ...SECTION_HEADING, style: styles.sectionTitle }}>{VENUES_HEADING}</Text>
          {chips(CHIP_GROUPS.venueCity, venueFilter, setVenueFilter)}
          {readState(venues.error, venues.isPending, () => void venues.refetch(), 'ops-venues')}
          {errorBanner(venueFailureMessage, 'ops-venues-failure')}
          {venues.isPending ? (
            <PendingGrid minHeight={viewportHeight} testID="ops-venues-pending" wide={wide} />
          ) : (
            <View style={cardsStyle}>{venueShown.map(renderVenue)}</View>
          )}
          {venuesEmpty ? <Text style={styles.meta}>{VENUES_EMPTY}</Text> : null}
          {renderVenueForm()}
        </View>
        <View style={styles.section}>
          <Text {...{ ...SECTION_HEADING, style: styles.sectionTitle }}>{LODGINGS_HEADING}</Text>
          <TextField
            label={LODGINGS_SEARCH_LABEL}
            onChangeText={changeLodgingSearch}
            testID="ops-lodgings-search"
            value={lodgingSearch}
          />
          {chips(CHIP_GROUPS.lodgingCity, lodgingFilter, setLodgingFilter)}
          {lodgingsCountLine}
          {readState(lodgings.error, lodgings.isPending, refetchLodgings, 'ops-lodgings')}
          {errorBanner(lodgingFailureMessage, 'ops-lodgings-failure')}
          {lodgings.isPending ? (
            <PendingGrid minHeight={viewportHeight} testID="ops-lodgings-pending" wide={wide} />
          ) : (
            <View style={cardsStyle}>{lodgingRows.map(renderLodging)}</View>
          )}
          {lodgingsEmpty ? <Text style={styles.meta}>{LODGINGS_EMPTY}</Text> : null}
          {lodgings.hasNextPage ? <Button {...lodgingsMore} testID="ops-lodgings-more" /> : null}
          {renderLodgingForm()}
        </View>
        <View style={styles.section}>
          <Text {...{ ...SECTION_HEADING, style: styles.sectionTitle }}>{'Price jobs'}</Text>
          <View style={cardsStyle}>{cityList.map(renderPriceJob)}</View>
        </View>
      </Screen>
    </>
  );
}
const CENTERED_ROW = {
  alignItems: 'center',
  flexDirection: 'row',
  minHeight: MIN_TOUCH_TARGET,
} as const;
const LABEL_STYLE = { ...typography.label, color: colors.text, fontWeight: fontWeights.medium };

const styles = StyleSheet.create({
  actions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  badge: {
    ...typography.caption,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: borderWidths.edge,
    color: colors.text,
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  badges: { alignItems: 'flex-end', gap: spacing.xs },
  cards: { gap: spacing.lg },
  cardsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  // The card's own gap is `spacing.md`, so grouping these children with the same gap leaves the
  // spacing between them as it was when there is no room to spare; when the card is stretched to a
  // taller neighbour, `marginTop` takes that room and anchors the group to the card's bottom edge,
  // which is what puts the switch line and the buttons on one line across a row (QA qa8b-24).
  footer: { gap: spacing.md, marginTop: 'auto' },
  meta: { ...typography.body, color: colors.textMuted },
  pendingCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: borderWidths.edge,
    minHeight: PENDING_CARD_MIN_HEIGHT,
  },
  section: { gap: spacing.lg },
  sectionTitle: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  slot: { flexBasis: layout.panelBasis, flexGrow: 1 },
  switchLabel: { ...LABEL_STYLE, flexShrink: 1 },
  switchRow: { ...CENTERED_ROW, gap: spacing.md, justifyContent: 'space-between' },
});
