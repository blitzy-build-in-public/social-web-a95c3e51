/**
 * Operator registry — venue and lodging onboarding, console secrets and price jobs
 * (`/ops/registry`, AAP 0.5.4, AAP 0.5.6, AAP 0.8.1, requirements 10, 14 and 15).
 *
 * Three sections over the `/admin/*` routes: the venue registry with operator-led onboarding, the
 * lodging registry with manual entry, and one row per city that queues its menu ingestion or its
 * phone fallback. Every one of those routes answers `403 operator_only` to a caller whose role is
 * not `operator` (AAP 0.5.4). The `/ops` layout above this route is the gate; the API's answer is
 * the authority, and nothing here decides who may read a registry.
 *
 * The screen holds one rule of its own: a console secret is shown once and lives only in this
 * component's state (AAP 0.3.2). It is issued with a plain `await` rather than through React Query,
 * because a mutation keeps its `variables` and its answer in the cache; it is never logged, never
 * put in a URL and never persisted, it leaves with the screen's focus, and the issue route answers
 * `Cache-Control: no-store`. The console at `/venue` or `/lodging` keeps the secret a person types
 * into it in `sessionStorage` alone.
 *
 * Everything rendered is the API's own serialization: which venues and lodgings exist, each row's
 * fixture, phone and secret state, and each city's price-job answer. The two city selectors filter
 * their list for display only and never drop a field a row carries. Creating a venue, activating
 * one, or issuing a lodging's console secret enqueues the server-side place refresh (AAP 0.5.6),
 * and a price job runs in `workers`, where its failure cannot reach the meetup flow (AAP 0.3.2).
 *
 * @see AAP 0.5.2 for the fixture rows only `test` and `demo` carry, 0.5.4 for the routes and their
 * errors, 0.5.6 for the crawl policy a job's work obeys, and 0.5.8 for the token-only styling, the
 * fixed copy and the WCAG 2.1 AA rules.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { SwitchProps, TextProps, ViewStyle } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CreateLodgingRequest,
  CreateVenueRequest,
  LodgingKind,
  MIN_TOUCH_TARGET,
  PriceJobRequest,
  UpdateVenueRequest,
  borderWidths,
  colors,
  fontWeights,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { AdminLodgingDto, AdminVenueDto, CityDto, PriceJobKind } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { queryClient, queryKeys } from '../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../src/ui';

// --- Constants ---------------------------------------------------------------------------------

/** The route's title, and the page's only heading: the `/ops` Stack renders no header of its own. */
const SCREEN_TITLE = 'Operator registry';

/** From this window width up, a section's cards sit side by side; below it they stack. */
const WIDE_LAYOUT_MIN_WIDTH = 900;

/** The narrowest a card grows in the wide layout, and the share of the row it claims. */
const CARD_MIN_WIDTH = 340;

/** The first segment of a Zod issue path, for the field message a rejected form shows. */
const FIELD_ERROR = 'Check this value.';

/** No field of a form carries a message; shared so the common case allocates nothing. */
const NO_FIELD_ERRORS: FieldErrors = {};

/** The sentence a body the route would refuse is answered with, before the request is sent. */
const INVALID_FIELDS = 'Check the highlighted fields.';

/**
 * The five codes these routes answer with that deserve this screen's own wording (AAP 0.5.4).
 * Every other code falls back to the client's map in `src/api/errors.ts`, which covers
 * `service_unavailable` and `network_error`.
 */
const REGISTRY_MESSAGES: Readonly<Record<string, string>> = {
  operator_only: 'Operator access required.',
  city_not_found: 'City not found.',
  not_found: 'Not found.',
  invalid_field: INVALID_FIELDS,
  daily_cap_reached: "Today's cap for this city is used up.",
};

const LOADING_TEXT = 'Loading…';
const RETRY_LABEL = 'Try again';
const ALL_CITIES_LABEL = 'All cities';
const VENUES_HEADING = 'Venues';
const LODGINGS_HEADING = 'Lodgings';
const PRICE_JOBS_HEADING = 'Price jobs';
const NAME_LABEL = 'Name';
const ADDRESS_LABEL = 'Address';
const LAT_LABEL = 'Latitude';
const LNG_LABEL = 'Longitude';
const PHONE_LABEL = 'Phone (E.164)';
const PHONE_HINT = 'For example +351… Leave it empty when the lodging has no callable number.';
const CITY_LABEL = 'City';
const KIND_LABEL = 'Kind';
const ACTIVE_PARTNER_LABEL = 'Active partner';
const FIXTURE_BADGE = 'Fixture';
const DO_NOT_CALL_BADGE = 'Do not call';
const NO_SECRET = 'No console secret';
const SECRET_LABEL = 'Console secret';
const SECRET_ONCE_HINT =
  'This secret is shown only once. The console keeps it in this browser session only.';
const SECRET_COPIED = 'Secret copied.';
const SECRET_COPY_FAILED = 'Copy failed. Select the text and copy it yourself.';
const DONE_LABEL = 'Done';
const COPY_LABEL = 'Copy';
const EDIT_LABEL = 'Edit';
const CANCEL_LABEL = 'Cancel';
const SAVE_LABEL = 'Save changes';
const ISSUE_SECRET_LABEL = 'Issue console secret';
const REISSUE_SECRET_LABEL = 'Reissue console secret';
const REISSUE_CONFIRM_LABEL = 'Issue new secret';
const KEEP_SECRET_LABEL = 'Keep current secret';
const REISSUE_WARNING =
  'Issuing a new secret replaces the current one; the console must sign in again.';
const NEW_VENUE_LABEL = 'New venue';
const NEW_LODGING_LABEL = 'New lodging';
const CREATE_VENUE_LABEL = 'Create venue';
const CREATE_LODGING_LABEL = 'Create lodging';
const VENUE_CREATED = 'Venue created.';
const VENUE_UPDATED = 'Venue updated.';
const LODGING_CREATED = 'Lodging created.';
const VENUES_EMPTY = 'No venues in this city. Add one below.';
const LODGINGS_EMPTY = 'No lodgings in this city. Add one below, or wait for the weekly refresh.';
const NO_ADDRESS = 'No address';
const NO_PHONE = 'No phone';
const LODGING_SECRET_HINT =
  'Issuing a console secret makes this lodging a partner and adds nearby places to the price pipeline.';
const MENU_JOB_LABEL = 'Run menu ingestion';
const CALL_JOB_LABEL = 'Run price calls';
const JOB_RUNNING = 'Running…';

/**
 * The three kinds a lodging may be, in the words a person reads. A complete record of the contract's
 * own enum, so a kind added to `LodgingKind` fails the type check here instead of rendering nothing.
 */
const LODGING_KIND_LABEL: Readonly<Record<AdminLodgingDto['kind'], string>> = {
  guesthouse: 'Guest house',
  hostel: 'Hostel',
  hotel: 'Hotel',
};

/** The switch's two track colours, each a token whose recorded pair covers where it is painted. */
const TRACK_COLOR = { false: colors.border, true: colors.primary } as const;

/** A section heading at level 2: the platform's header trait, and the `<h2>` the web build renders. */
const SECTION_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  'aria-level': 2,
  role: 'heading',
};

/** Keeps the browser's own focus outline off a focused chip, so the reserved band is the ring. */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

// --- Helpers -----------------------------------------------------------------------------------

/** One inline message per field, keyed by the first segment of the issue's path. */
type FieldErrors = Readonly<Record<string, string>>;

/**
 * The sentence this screen shows for a failure: the code's own wording for the five codes above,
 * and the client's map for anything else. The server's `message` text is never shown (AAP 0.11.1).
 */
function messageFor(error: unknown): string {
  const code = isApiError(error) ? error.code : 'invalid_response';
  return REGISTRY_MESSAGES[code] ?? userMessageFor(code);
}

/** Maps a rejected body's issues onto the fields a form shows them under. */
function fieldErrorsFrom(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): FieldErrors {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && errors[field] === undefined) errors[field] = FIELD_ERROR;
  }
  return errors;
}

/** `2027-03-12T09:31:00.000Z` -> `12 Mar 2027, 09:31 UTC`. Anything else reads as it arrived. */
function formatIssuedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${new Intl.DateTimeFormat('en-GB', ISSUED_AT_FORMAT).format(at)} UTC`;
}

const ISSUED_AT_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
};

/** A coordinate to five decimals, the precision the seeded venues are laid out on. */
function coordinate(value: number): string {
  return value.toFixed(5);
}

/** A row's secret state, in one sentence. */
function secretStatus(secretIssuedAt: string | null): string {
  return secretIssuedAt === null
    ? NO_SECRET
    : `Console secret issued ${formatIssuedAt(secretIssuedAt)}`;
}

/** The city's name, or its slug while the list is still in flight. */
function cityLabel(cities: readonly CityDto[], cityId: string): string {
  return cities.find((city) => city.id === cityId)?.name ?? cityId;
}

/** The web clipboard, or null where the platform has none — Hermes on iOS and Android has none. */
function clipboardWriter(): { writeText(text: string): Promise<void> } | null {
  const writer: { writeText?(text: string): Promise<void> } | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return writer !== undefined && typeof writer.writeText === 'function'
    ? (writer as { writeText(text: string): Promise<void> })
    : null;
}

/** The read-only secret field's change handler: `TextField` requires one and never edits it here. */
function ignoreText(): void {}

/**
 * A native `Switch`'s role and state, stated for VoiceOver and TalkBack and withheld on web.
 *
 * `react-native-web` 0.19 forwards both onto the wrapper element it draws around the control, where
 * they add a nameless, non-activatable `role="switch"` ahead of the real input in the tab order
 * (WCAG 2.1.1, 2.4.3); the input it renders already carries the role, the checked state and the
 * visible label as its accessible name.
 */
function switchProps(checked: boolean, disabled: boolean): Partial<SwitchProps> {
  if (Platform.OS === 'web') return {};
  return { accessibilityRole: 'switch', accessibilityState: { checked, disabled } };
}

// --- Shared pieces -----------------------------------------------------------------------------

/**
 * One selectable chip. `role="radio"` with `aria-checked` is the pair both platforms understand:
 * React Native maps it onto the native radio role and react-native-web onto the DOM attribute, and
 * the press responder answers Space for a radio-role element as it does for a button (AAP 0.5.8).
 */
function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}): ReactElement {
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      aria-checked={selected}
      aria-label={label}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onPress={onPress}
      role="radio"
      style={[
        styles.chip,
        selected && styles.chipSelected,
        focused && styles.chipFocused,
        webFocusRingReset,
      ]}
      testID={testID}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

/**
 * One labelled radio group over the configured cities. `includeAll` adds the list filter's "All
 * cities" radio; the two create forms leave it out, because a new venue or lodging names a city.
 */
function CityChips({
  label,
  cities,
  selected,
  onSelect,
  includeAll,
  testIDPrefix,
}: {
  readonly label: string;
  readonly cities: readonly CityDto[];
  readonly selected: string | null;
  readonly onSelect: (cityId: string | null) => void;
  readonly includeAll: boolean;
  readonly testIDPrefix: string;
}): ReactElement {
  return (
    <View aria-label={label} role="radiogroup" style={styles.chips}>
      {includeAll ? (
        <Chip
          label={ALL_CITIES_LABEL}
          onPress={() => onSelect(null)}
          selected={selected === null}
          testID={`${testIDPrefix}-all`}
        />
      ) : null}
      {cities.map((city) => (
        <Chip
          key={city.id}
          label={city.name}
          onPress={() => onSelect(city.id)}
          selected={selected === city.id}
          testID={`${testIDPrefix}-${city.id}`}
        />
      ))}
    </View>
  );
}

/** The issued secret and the row it belongs to, held in the screen's own state (AAP 0.3.2). */
interface SecretReveal {
  readonly targetKind: 'venue' | 'lodging';
  readonly targetId: string;
  readonly targetName: string;
  readonly secret: string;
}

/**
 * The one-time console secret: a read-only field a person can select, a copy action where the
 * platform has a clipboard, and nothing that outlives the screen's focus.
 */
function SecretCard({
  reveal,
  onDone,
}: {
  readonly reveal: SecretReveal;
  readonly onDone: () => void;
}): ReactElement {
  const writer = clipboardWriter();
  const [copyNote, setCopyNote] = useState<string | null>(null);

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
    <Card
      subtitle={reveal.targetKind === 'venue' ? 'Venue' : 'Lodging'}
      testID="ops-secret"
      title={reveal.targetName}
    >
      <TextField
        hint={SECRET_ONCE_HINT}
        label={SECRET_LABEL}
        onChangeText={ignoreText}
        readOnly
        selectTextOnFocus
        testID="ops-secret-value"
        value={reveal.secret}
      />
      {copyNote === null ? null : <Text style={styles.meta}>{copyNote}</Text>}
      <View style={styles.actions}>
        {writer === null ? null : (
          <Button
            label={COPY_LABEL}
            onPress={() => void copy()}
            testID="ops-secret-copy"
            variant="secondary"
          />
        )}
        <Button label={DONE_LABEL} onPress={onDone} testID="ops-secret-done" />
      </View>
    </Card>
  );
}

/**
 * The console-secret control both registry rows share.
 *
 * A first secret is issued on the press; a reissue replaces the secret the console is signed in
 * with, so it waits for the inline warning's own confirm action, and the row's button becomes the
 * way back out. The value itself is never held here — only the screen's state holds it (AAP 0.3.2).
 */
function SecretControls({
  confirming,
  issued,
  busy,
  onIssue,
  onStartReissue,
  onKeep,
  testID,
}: {
  readonly confirming: boolean;
  readonly issued: boolean;
  readonly busy: boolean;
  readonly onIssue: () => void;
  readonly onStartReissue: () => void;
  readonly onKeep: () => void;
  readonly testID: string;
}): ReactElement {
  return (
    <View style={styles.actions}>
      {confirming ? (
        <Button
          label={KEEP_SECRET_LABEL}
          onPress={onKeep}
          testID={`${testID}-keep`}
          variant="secondary"
        />
      ) : (
        <Button
          busy={busy}
          label={issued ? REISSUE_SECRET_LABEL : ISSUE_SECRET_LABEL}
          onPress={issued ? onStartReissue : onIssue}
          testID={testID}
          variant="secondary"
        />
      )}
      {confirming ? (
        <Banner
          action={{ label: REISSUE_CONFIRM_LABEL, onPress: onIssue, testID: `${testID}-confirm` }}
          message={REISSUE_WARNING}
          testID={`${testID}-warning`}
          tone="warning"
        />
      ) : null}
    </View>
  );
}

/**
 * What a section's own read shows above its rows: a loading line while it is in flight, and the
 * retry notice once it has failed. The section's rows render only what the API returned.
 */
function ReadState({
  error,
  pending,
  retry,
  testID,
}: {
  readonly error: unknown;
  readonly pending: boolean;
  readonly retry: () => void;
  readonly testID: string;
}): ReactElement {
  if (error === null) {
    return <>{pending ? <Text style={styles.meta}>{LOADING_TEXT}</Text> : null}</>;
  }
  return (
    <Banner
      action={{ label: RETRY_LABEL, onPress: retry, testID: `${testID}-retry` }}
      message={messageFor(error)}
      testID={`${testID}-error`}
      tone="error"
    />
  );
}

// --- The screen (AAP 0.5.4, AAP 0.5.6) ---------------------------------------------------------

/** The venue form's draft. An inline edit reuses the same fields, so one shape carries both. */
interface VenueDraft {
  readonly cityId: string;
  readonly name: string;
  readonly address: string;
  readonly lat: string;
  readonly lng: string;
  readonly isActivePartner: boolean;
}

const EMPTY_VENUE_DRAFT: VenueDraft = {
  address: '',
  cityId: '',
  isActivePartner: true,
  lat: '',
  lng: '',
  name: '',
};

/** The lodging form's draft; `kind` is one of the three kinds the contract names. */
interface LodgingDraft {
  readonly cityId: string;
  readonly name: string;
  readonly kind: AdminLodgingDto['kind'];
  readonly address: string;
  readonly phone: string;
  readonly lat: string;
  readonly lng: string;
}

const EMPTY_LODGING_DRAFT: LodgingDraft = {
  address: '',
  cityId: '',
  // The first of the three kinds, and the one a pilot's shared housing is entered as most often.
  kind: 'hostel',
  lat: '',
  lng: '',
  name: '',
  phone: '',
};

/** An open inline edit: which venue, what it held, what it holds now, and its field messages. */
interface VenueEdit {
  readonly id: string;
  readonly original: VenueDraft;
  readonly draft: VenueDraft;
  readonly errors: FieldErrors;
}

/** A row's editable text, as the fields take it: `String(number)` parses back to the same number. */
function venueDraftOf(venue: AdminVenueDto): VenueDraft {
  return {
    address: venue.address,
    cityId: venue.cityId,
    isActivePartner: venue.isActivePartner,
    lat: String(venue.lat),
    lng: String(venue.lng),
    name: venue.name,
  };
}

/**
 * The keys an edit sends: only those whose value differs from the row it started from, with `lat`
 * and `lng` travelled together, because a venue moved half-way would leave the 150 m check-in
 * geofence measured from a point that is not the venue any more (AAP 0.5.4, 0.5.7).
 */
function changedVenueFields(
  original: VenueDraft,
  draft: VenueDraft,
): Record<string, string | number> {
  const changed: Record<string, string | number> = {};
  if (draft.name !== original.name) changed.name = draft.name;
  if (draft.address !== original.address) changed.address = draft.address;
  const lat = Number.parseFloat(draft.lat);
  const lng = Number.parseFloat(draft.lng);
  if (lat !== Number.parseFloat(original.lat) || lng !== Number.parseFloat(original.lng)) {
    changed.lat = lat;
    changed.lng = lng;
  }
  return changed;
}

/** The four text fields of a venue form, in reading order. */
const VENUE_FIELDS = [
  { key: 'name', label: NAME_LABEL },
  { key: 'address', label: ADDRESS_LABEL },
  { key: 'lat', label: LAT_LABEL },
  { key: 'lng', label: LNG_LABEL },
] as const;

/** The five text fields of a lodging form, in reading order. */
const LODGING_FIELDS = [
  { key: 'name', label: NAME_LABEL },
  { key: 'address', label: ADDRESS_LABEL },
  { key: 'phone', label: PHONE_LABEL },
  { key: 'lat', label: LAT_LABEL },
  { key: 'lng', label: LNG_LABEL },
] as const;

/** A field of either form that takes a number rather than text. */
function isNumericField(key: string): boolean {
  return key === 'lat' || key === 'lng';
}

/**
 * The operator registry.
 *
 * @returns The venue and lodging registries with their console-secret controls, and one price-job
 * row per city (AAP 0.5.4, AAP 0.5.6, AAP 0.8.1).
 */
export default function OperatorRegistryScreen(): ReactElement {
  const wide = useWindowDimensions().width >= WIDE_LAYOUT_MIN_WIDTH;

  // Three reads, each under the key its own mutations invalidate. None is gated on a session: the
  // `/ops` layout has already established an operator session before this route renders, and an
  // answer of `403 operator_only` is what tells the truth about any of them (AAP 0.5.4).
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const venues = useQuery({
    queryKey: queryKeys.adminVenues,
    queryFn: () => apiClient.admin.listVenues(),
  });
  const lodgings = useQuery({
    queryKey: queryKeys.adminLodgings,
    queryFn: () => apiClient.admin.listLodgings(),
  });
  const cityList: readonly CityDto[] = cities.data?.items ?? [];

  const [venueFilter, setVenueFilter] = useState<string | null>(null);
  const [lodgingFilter, setLodgingFilter] = useState<string | null>(null);
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

  // The two lists as their chips show them: a display filter over the API's own rows, which never
  // drops a field a row carries (AAP 0.5.4).
  const venueRows: readonly AdminVenueDto[] = venues.data?.items ?? [];
  const lodgingRows: readonly AdminLodgingDto[] = lodgings.data?.items ?? [];
  const visibleVenues =
    venueFilter === null ? venueRows : venueRows.filter((venue) => venue.cityId === venueFilter);
  const visibleLodgings =
    lodgingFilter === null
      ? lodgingRows
      : lodgingRows.filter((lodging) => lodging.cityId === lodgingFilter);
  // The empty sentence belongs to a list that has loaded and holds nothing, not to one still in
  // flight or one that failed: `ReadState` above already speaks for those two.
  const venuesSettled = !venues.isPending && venues.error === null;
  const lodgingsSettled = !lodgings.isPending && lodgings.error === null;

  // The secret leaves with the screen's focus, whether the operator navigates away or the component
  // unmounts (AAP 0.3.2).
  useFocusEffect(
    useCallback(() => {
      return () => setReveal(null);
    }, []),
  );

  const createVenue = useMutation({
    mutationFn: (body: CreateVenueRequest) => apiClient.admin.createVenue(body),
    onSuccess: () => {
      setVenueDraft(EMPTY_VENUE_DRAFT);
      setVenueErrors(NO_FIELD_ERRORS);
      succeed(VENUE_CREATED);
      // The API enqueues the place refresh for a new venue (AAP 0.5.6); the list shows it at once.
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminVenues });
    },
  });

  const updateVenue = useMutation({
    mutationFn: (input: { readonly id: string; readonly body: UpdateVenueRequest }) =>
      apiClient.admin.updateVenue(input.id, input.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminVenues });
    },
  });

  const createLodging = useMutation({
    mutationFn: (body: CreateLodgingRequest) => apiClient.admin.createLodging(body),
    onSuccess: () => {
      setLodgingDraft(EMPTY_LODGING_DRAFT);
      setLodgingErrors(NO_FIELD_ERRORS);
      succeed(LODGING_CREATED);
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminLodgings });
    },
  });

  const venueFailure = createVenue.error ?? updateVenue.error ?? null;
  const venueFailureMessage = venueFailure === null ? null : messageFor(venueFailure);
  const lodgingFailureMessage =
    createLodging.error === null ? null : messageFor(createLodging.error);

  // Each failure is spoken once: a re-render over the same failed request repeats nothing. On web
  // the error banner's own live region speaks it and `announce` is a no-op there (AAP 0.5.8).
  useEffect(() => {
    if (venueFailureMessage !== null) announce(venueFailureMessage);
  }, [venueFailureMessage]);

  useEffect(() => {
    if (lodgingFailureMessage !== null) announce(lodgingFailureMessage);
  }, [lodgingFailureMessage]);

  /** Shows a success sentence and speaks it: the banner's live region carries it on web. */
  function succeed(message: string): void {
    setNotice(message);
    announce(message);
  }

  /**
   * Issues a console secret and shows it once.
   *
   * A plain `await` on purpose: a React Query mutation keeps its `variables` and its answer in the
   * cache, and the secret is the one value that may live only in this component's state (AAP 0.3.2).
   */
  async function issueSecret(target: {
    readonly kind: 'venue' | 'lodging';
    readonly id: string;
    readonly name: string;
  }): Promise<void> {
    setSecretError(null);
    setReveal(null);
    setSecretBusyId(target.id);
    try {
      const issued =
        target.kind === 'venue'
          ? await apiClient.admin.issueVenueSecret(target.id)
          : await apiClient.admin.issueLodgingSecret(target.id);
      setReveal({
        secret: issued.secret,
        targetId: target.id,
        targetKind: target.kind,
        targetName: target.name,
      });
      setReissueFor(null);
      // The row's `secretIssuedAt` is what moved, so the list it came from is read again.
      await queryClient.invalidateQueries({
        queryKey: target.kind === 'venue' ? queryKeys.adminVenues : queryKeys.adminLodgings,
      });
    } catch (error) {
      const message = messageFor(error);
      setSecretError(message);
      announce(message);
    } finally {
      setSecretBusyId(null);
    }
  }

  /** Queues a city's menu ingestion or its phone fallback, and reports the answer on that row. */
  async function runPriceJob(cityId: string, kind: PriceJobKind): Promise<void> {
    const parsed = PriceJobRequest.safeParse({ cityId, kind });
    if (!parsed.success) {
      setJobStatus((previous) => ({ ...previous, [cityId]: INVALID_FIELDS }));
      announce(INVALID_FIELDS);
      return;
    }

    setJobBusy(cityId);
    setJobStatus((previous) => ({ ...previous, [cityId]: JOB_RUNNING }));
    try {
      const queued = await apiClient.admin.enqueuePriceJob(parsed.data);
      const message = `Queued (job ${queued.jobId})`;
      setJobStatus((previous) => ({ ...previous, [cityId]: message }));
      announce(message);
    } catch (error) {
      const message = messageFor(error);
      setJobStatus((previous) => ({ ...previous, [cityId]: message }));
      announce(message);
    } finally {
      setJobBusy(null);
    }
  }

  /** Toggles a venue's partner flag: meetups are offered only at active partners (AAP 0.12.2). */
  function toggleActivePartner(venue: AdminVenueDto, next: boolean): void {
    updateVenue.mutate({ body: { isActivePartner: next }, id: venue.id });
  }

  /** Opens or closes one row's inline edit, seeding its draft from the row the API returned. */
  function toggleEdit(venue: AdminVenueDto): void {
    const draft = venueDraftOf(venue);
    setEdit((open) =>
      open !== null && open.id === venue.id
        ? null
        : { draft, errors: NO_FIELD_ERRORS, id: venue.id, original: draft },
    );
  }

  /** Writes one field of the open edit. */
  function patchEditField(field: 'name' | 'address' | 'lat' | 'lng', value: string): void {
    setEdit((open) => {
      if (open === null) return null;
      if (field === 'name') return { ...open, draft: { ...open.draft, name: value } };
      if (field === 'address') return { ...open, draft: { ...open.draft, address: value } };
      if (field === 'lat') return { ...open, draft: { ...open.draft, lat: value } };
      return { ...open, draft: { ...open.draft, lng: value } };
    });
  }

  /** Writes one field of the new-venue form. */
  function patchVenueDraft(field: 'name' | 'address' | 'lat' | 'lng', value: string): void {
    setVenueDraft((draft) => {
      if (field === 'name') return { ...draft, name: value };
      if (field === 'address') return { ...draft, address: value };
      if (field === 'lat') return { ...draft, lat: value };
      return { ...draft, lng: value };
    });
  }

  /** Writes one field of the new-lodging form. */
  function patchLodgingDraft(
    field: 'name' | 'address' | 'phone' | 'lat' | 'lng',
    value: string,
  ): void {
    setLodgingDraft((draft) => {
      if (field === 'name') return { ...draft, name: value };
      if (field === 'address') return { ...draft, address: value };
      if (field === 'phone') return { ...draft, phone: value };
      if (field === 'lat') return { ...draft, lat: value };
      return { ...draft, lng: value };
    });
  }

  /** Sends an edit's changed keys, and closes the editor once the API has taken them. */
  function saveVenueEdit(): void {
    if (edit === null) return;
    const parsed = UpdateVenueRequest.safeParse(changedVenueFields(edit.original, edit.draft));
    if (!parsed.success) {
      setEdit({ ...edit, errors: fieldErrorsFrom(parsed.error.issues) });
      announce(INVALID_FIELDS);
      return;
    }
    setEdit({ ...edit, errors: NO_FIELD_ERRORS });
    updateVenue.mutate(
      { body: parsed.data, id: edit.id },
      {
        onSuccess: () => {
          setEdit(null);
          succeed(VENUE_UPDATED);
        },
      },
    );
  }

  /** Validates the venue form with the route's own schema, so a refused body is never sent. */
  function submitVenue(): void {
    const parsed = CreateVenueRequest.safeParse({
      address: venueDraft.address.trim(),
      cityId: venueDraft.cityId,
      isActivePartner: venueDraft.isActivePartner,
      lat: Number.parseFloat(venueDraft.lat),
      lng: Number.parseFloat(venueDraft.lng),
      name: venueDraft.name.trim(),
    });
    if (!parsed.success) {
      setVenueErrors(fieldErrorsFrom(parsed.error.issues));
      announce(INVALID_FIELDS);
      return;
    }
    setVenueErrors(NO_FIELD_ERRORS);
    createVenue.mutate(parsed.data);
  }

  /** Validates the lodging form; an empty phone travels as `null`, which the contract requires. */
  function submitLodging(): void {
    const phone = lodgingDraft.phone.trim();
    const parsed = CreateLodgingRequest.safeParse({
      address: lodgingDraft.address.trim(),
      cityId: lodgingDraft.cityId,
      kind: lodgingDraft.kind,
      lat: Number.parseFloat(lodgingDraft.lat),
      lng: Number.parseFloat(lodgingDraft.lng),
      name: lodgingDraft.name.trim(),
      phone: phone === '' ? null : phone,
    });
    if (!parsed.success) {
      setLodgingErrors(fieldErrorsFrom(parsed.error.issues));
      announce(INVALID_FIELDS);
      return;
    }
    setLodgingErrors(NO_FIELD_ERRORS);
    createLodging.mutate(parsed.data);
  }

  /** One venue row: its facts, its partner switch, its inline edit and its console secret. */
  function renderVenue(venue: AdminVenueDto): ReactElement {
    const editing = edit !== null && edit.id === venue.id ? edit : null;
    const confirming = reissueFor === venue.id;
    const issue = (): void => void issueSecret({ id: venue.id, kind: 'venue', name: venue.name });

    return (
      <View key={venue.id} style={wide ? styles.slot : null}>
        <Card
          subtitle={`${cityLabel(cityList, venue.cityId)} · ${venue.address}`}
          testID={`ops-venue-${venue.id}`}
          title={venue.name}
          trailing={venue.isFixture ? <Text style={styles.badge}>{FIXTURE_BADGE}</Text> : null}
        >
          <Text style={styles.meta}>
            {`${coordinate(venue.lat)}, ${coordinate(venue.lng)} · ${secretStatus(
              venue.secretIssuedAt,
            )}`}
          </Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>{ACTIVE_PARTNER_LABEL}</Text>
            <Switch
              accessibilityLabel={`${ACTIVE_PARTNER_LABEL}: ${venue.name}`}
              disabled={updateVenue.isPending}
              ios_backgroundColor={colors.border}
              onValueChange={(next) => toggleActivePartner(venue, next)}
              testID={`ops-venue-active-${venue.id}`}
              thumbColor={colors.onPrimary}
              trackColor={TRACK_COLOR}
              value={venue.isActivePartner}
              {...switchProps(venue.isActivePartner, updateVenue.isPending)}
            />
          </View>

          {editing === null
            ? null
            : VENUE_FIELDS.map((field) => (
                <TextField
                  error={editing.errors[field.key]}
                  inputMode={isNumericField(field.key) ? 'decimal' : 'text'}
                  key={field.key}
                  label={field.label}
                  onChangeText={(value) => patchEditField(field.key, value)}
                  testID={`ops-venue-edit-${field.key}-${venue.id}`}
                  value={editing.draft[field.key]}
                />
              ))}

          <View style={styles.actions}>
            <Button
              label={editing === null ? EDIT_LABEL : CANCEL_LABEL}
              onPress={() => toggleEdit(venue)}
              testID={`ops-venue-edit-${venue.id}`}
              variant="secondary"
            />
            {editing === null ? null : (
              <Button
                busy={updateVenue.isPending}
                label={SAVE_LABEL}
                onPress={saveVenueEdit}
                testID={`ops-venue-save-${venue.id}`}
              />
            )}
          </View>

          <SecretControls
            busy={secretBusyId === venue.id}
            confirming={confirming}
            issued={venue.secretIssuedAt !== null}
            onIssue={issue}
            onKeep={() => setReissueFor(null)}
            onStartReissue={() => setReissueFor(venue.id)}
            testID={`ops-venue-secret-${venue.id}`}
          />
        </Card>
      </View>
    );
  }

  /** One lodging row: its facts, its phone and its console secret. */
  function renderLodging(lodging: AdminLodgingDto): ReactElement {
    const confirming = reissueFor === lodging.id;
    const issue = (): void =>
      void issueSecret({ id: lodging.id, kind: 'lodging', name: lodging.name });
    // The source is shown whether or not a number exists: a manually entered lodging with none is
    // still the operator's own entry, which is what `phoneSource` distinguishes (AAP 0.5.6).
    const phone = `${lodging.phone ?? NO_PHONE} (${lodging.phoneSource})`;

    return (
      <View key={lodging.id} style={wide ? styles.slot : null}>
        <Card
          subtitle={`${cityLabel(cityList, lodging.cityId)} · ${LODGING_KIND_LABEL[lodging.kind]}`}
          testID={`ops-lodging-${lodging.id}`}
          title={lodging.name}
          trailing={
            <View style={styles.badges}>
              {lodging.isFixture ? <Text style={styles.badge}>{FIXTURE_BADGE}</Text> : null}
              {lodging.doNotCall ? <Text style={styles.badge}>{DO_NOT_CALL_BADGE}</Text> : null}
            </View>
          }
        >
          <Text style={styles.meta}>{lodging.address ?? NO_ADDRESS}</Text>
          <Text style={styles.meta}>{`${phone} · ${secretStatus(lodging.secretIssuedAt)}`}</Text>
          <Text style={styles.meta}>{LODGING_SECRET_HINT}</Text>

          <SecretControls
            busy={secretBusyId === lodging.id}
            confirming={confirming}
            issued={lodging.secretIssuedAt !== null}
            onIssue={issue}
            onKeep={() => setReissueFor(null)}
            onStartReissue={() => setReissueFor(lodging.id)}
            testID={`ops-lodging-secret-${lodging.id}`}
          />
        </Card>
      </View>
    );
  }

  /** One city's price-job row: its two jobs, and the answer to whichever ran last. */
  function renderPriceJob(city: CityDto): ReactElement {
    const status = jobStatus[city.id];

    return (
      <View key={city.id} style={wide ? styles.slot : null}>
        <Card
          subtitle={`${city.timezone} · ${city.currency}`}
          testID={`ops-price-${city.id}`}
          title={city.name}
        >
          <View style={styles.actions}>
            <Button
              busy={jobBusy === city.id}
              label={MENU_JOB_LABEL}
              onPress={() => void runPriceJob(city.id, 'menus')}
              testID={`ops-price-menus-${city.id}`}
            />
            <Button
              busy={jobBusy === city.id}
              label={CALL_JOB_LABEL}
              onPress={() => void runPriceJob(city.id, 'calls')}
              testID={`ops-price-calls-${city.id}`}
              variant="secondary"
            />
          </View>
          {status === undefined ? null : (
            <Text aria-live="polite" style={styles.meta} testID={`ops-price-status-${city.id}`}>
              {status}
            </Text>
          )}
        </Card>
      </View>
    );
  }

  /** The new-venue form: the city, the four text fields and the partner flag. */
  function renderVenueForm(): ReactElement {
    return (
      <Card testID="ops-venue-form" title={NEW_VENUE_LABEL}>
        <CityChips
          cities={cityList}
          includeAll={false}
          label={CITY_LABEL}
          onSelect={(cityId) => setVenueDraft((draft) => ({ ...draft, cityId: cityId ?? '' }))}
          selected={venueDraft.cityId === '' ? null : venueDraft.cityId}
          testIDPrefix="ops-venue-new-city"
        />
        {VENUE_FIELDS.map((field) => (
          <TextField
            error={venueErrors[field.key]}
            inputMode={isNumericField(field.key) ? 'decimal' : 'text'}
            key={field.key}
            label={field.label}
            onChangeText={(value) => patchVenueDraft(field.key, value)}
            testID={`ops-venue-new-${field.key}`}
            value={venueDraft[field.key]}
          />
        ))}
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{ACTIVE_PARTNER_LABEL}</Text>
          <Switch
            accessibilityLabel={ACTIVE_PARTNER_LABEL}
            ios_backgroundColor={colors.border}
            onValueChange={(isActivePartner) =>
              setVenueDraft((draft) => ({ ...draft, isActivePartner }))
            }
            testID="ops-venue-new-active"
            thumbColor={colors.onPrimary}
            trackColor={TRACK_COLOR}
            value={venueDraft.isActivePartner}
            {...switchProps(venueDraft.isActivePartner, false)}
          />
        </View>
        <View style={styles.actions}>
          <Button
            busy={createVenue.isPending}
            label={CREATE_VENUE_LABEL}
            onPress={submitVenue}
            testID="ops-venue-create"
          />
        </View>
      </Card>
    );
  }

  /** The new-lodging form: a manual entry, stored with `phoneSource = operator` (AAP 0.5.6). */
  function renderLodgingForm(): ReactElement {
    return (
      <Card testID="ops-lodging-form" title={NEW_LODGING_LABEL}>
        <CityChips
          cities={cityList}
          includeAll={false}
          label={CITY_LABEL}
          onSelect={(cityId) => setLodgingDraft((draft) => ({ ...draft, cityId: cityId ?? '' }))}
          selected={lodgingDraft.cityId === '' ? null : lodgingDraft.cityId}
          testIDPrefix="ops-lodging-new-city"
        />
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
        {LODGING_FIELDS.map((field) => (
          <TextField
            error={lodgingErrors[field.key]}
            hint={field.key === 'phone' ? PHONE_HINT : undefined}
            inputMode={
              field.key === 'phone' ? 'tel' : isNumericField(field.key) ? 'decimal' : 'text'
            }
            key={field.key}
            label={field.label}
            onChangeText={(value) => patchLodgingDraft(field.key, value)}
            testID={`ops-lodging-new-${field.key}`}
            value={lodgingDraft[field.key]}
          />
        ))}
        <View style={styles.actions}>
          <Button
            busy={createLodging.isPending}
            label={CREATE_LODGING_LABEL}
            onPress={submitLodging}
            testID="ops-lodging-create"
          />
        </View>
      </Card>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen testID="ops-registry" title={SCREEN_TITLE}>
        {reveal === null ? null : <SecretCard onDone={() => setReveal(null)} reveal={reveal} />}
        {secretError === null ? null : (
          <Banner message={secretError} testID="ops-secret-error" tone="error" />
        )}
        {notice === null ? null : <Banner message={notice} testID="ops-notice" tone="success" />}
        <ReadState
          error={cities.error}
          pending={cities.isPending}
          retry={() => void cities.refetch()}
          testID="ops-cities"
        />

        <View style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.sectionTitle}>
            {VENUES_HEADING}
          </Text>
          <CityChips
            cities={cityList}
            includeAll
            label={`${VENUES_HEADING} city filter`}
            onSelect={setVenueFilter}
            selected={venueFilter}
            testIDPrefix="ops-venue-city"
          />
          <ReadState
            error={venues.error}
            pending={venues.isPending}
            retry={() => void venues.refetch()}
            testID="ops-venues"
          />
          {venueFailureMessage === null ? null : (
            <Banner message={venueFailureMessage} testID="ops-venues-failure" tone="error" />
          )}
          <View style={[styles.cards, wide ? styles.cardsRow : null]}>
            {visibleVenues.map(renderVenue)}
          </View>
          {venuesSettled && visibleVenues.length === 0 ? (
            <Text style={styles.meta}>{VENUES_EMPTY}</Text>
          ) : null}
          {renderVenueForm()}
        </View>

        <View style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.sectionTitle}>
            {LODGINGS_HEADING}
          </Text>
          <CityChips
            cities={cityList}
            includeAll
            label={`${LODGINGS_HEADING} city filter`}
            onSelect={setLodgingFilter}
            selected={lodgingFilter}
            testIDPrefix="ops-lodging-city"
          />
          <ReadState
            error={lodgings.error}
            pending={lodgings.isPending}
            retry={() => void lodgings.refetch()}
            testID="ops-lodgings"
          />
          {lodgingFailureMessage === null ? null : (
            <Banner message={lodgingFailureMessage} testID="ops-lodgings-failure" tone="error" />
          )}
          <View style={[styles.cards, wide ? styles.cardsRow : null]}>
            {visibleLodgings.map(renderLodging)}
          </View>
          {lodgingsSettled && visibleLodgings.length === 0 ? (
            <Text style={styles.meta}>{LODGINGS_EMPTY}</Text>
          ) : null}
          {renderLodgingForm()}
        </View>

        <View style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.sectionTitle}>
            {PRICE_JOBS_HEADING}
          </Text>
          <View style={[styles.cards, wide ? styles.cardsRow : null]}>
            {cityList.map(renderPriceJob)}
          </View>
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
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
  // The wide layout only: in the column layout these slots would size their height, not their width.
  cardsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chipFocused: { borderColor: colors.focusRing },
  chipLabel: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  chipLabelSelected: { color: colors.onPrimary },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  meta: { ...typography.body, color: colors.textMuted },
  section: { gap: spacing.lg },
  sectionTitle: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  slot: { flexBasis: CARD_MIN_WIDTH, flexGrow: 1 },
  switchLabel: {
    ...typography.label,
    color: colors.text,
    flexShrink: 1,
    fontWeight: fontWeights.medium,
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
  },
});
