/**
 * Operator queues (`/ops/queues`): the five queues of the operator area over one shared list.
 *
 * Disputes and reports for safety (AAP 0.7.1 row 12), call tasks and crawl domains for the price
 * pipeline (row 14) and lodging claims (row 15), each under its own tab over one `QueueList`, so all
 * five load, fail, retry and empty the same way and only the tab on show runs a read. Leaving a tab
 * discards its read and its state, the audited booking details included.
 *
 * Nothing here decides what an operator may do: every `/v1/admin/*` route validates the outcome
 * against the lifecycles of AAP 0.5.3 and answers `422 invalid_outcome` for a transition it forbids,
 * `403 operator_only` to a caller whose role is not `operator` and `409 details_unavailable` once a
 * claim's details were erased. The actions below follow those same lifecycles, so a button is rarely
 * offered for an outcome the server would refuse, and a refusal that arrives anyway — from a second
 * operator's browser, or a queue read a minute ago — is shown as a sentence of this screen's own.
 *
 * The booking details are the app's one audited decryption (AAP 0.5.2, 0.5.4): read only when the
 * operator asks, never through React Query, and dropped as soon as the row loses focus. Nothing here
 * logs a booking name or reference, a handle, a report's text or any response body.
 *
 * Client-safe: `react`, `react-native`, `expo-router`, `@tanstack/react-query`, `@tablemate/shared`
 * and the app's own client modules, with no Node built-in, no DOM global and no effect at module load
 * beyond the one formatter built below.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CLAIM_EXPIRY_HOURS,
  DISPUTE_RESOLUTION_DAYS,
  ItemCategory,
  MIN_TOUCH_TARGET,
  PriceItemInput,
  TicketType,
  borderWidths,
  colors,
  fontWeights,
  interactionOpacity,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type {
  AdminCallTaskDto,
  AdminCrawlDomainDto,
  AdminDisputeDto,
  AdminLodgingClaimDto,
  AdminReportDto,
  BlockedReason,
  BookingDetailsDto,
  CallAttemptOutcome,
  CallTaskKind,
  CallTaskStatus,
  CheckInResult,
  CityDto,
  CrawlDecision,
  CrawlDomainDecisionUpdate,
  DisputeKind,
  DisputeOutcome,
  DisputeStatus,
  LodgingClaimStatus,
  OperatorCallTaskOutcome,
  OperatorClaimOutcome,
  ResolveCallTask,
  ResolveDispute,
  ResolveLodgingClaim,
} from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { queryClient, queryKeys } from '../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../src/ui';

/** The route's title: the page's only heading, and what the navigator records for it. */
const SCREEN_TITLE = 'Operator queues';

/** The name of the tablist, and the notice a successful action speaks on iOS and Android. */
const TABLIST_LABEL = 'Operator queues';
const SAVED_NOTICE = 'Saved.';

/** The copy a queue and a price entry show of their own. */
const LOADING_NOTICE = 'Loading…';
const RETRY_LABEL = 'Try again';
const CANCEL_LABEL = 'Cancel';
const CONFIRM_PREFIX = 'Confirm: ';
const OVERDUE_BADGE = 'Overdue';
const DELETED_ACCOUNT_TEXT = 'Deleted account';
const REMOVED_REASON_TEXT = 'Reason text removed';
const NO_CHECK_IN_TEXT = 'No check-in';
const DETAILS_NOTE = 'Access is logged. Use only for the verification call.';
const INVALID_PRICE_ROWS_NOTICE = 'Check the highlighted price rows.';
const ROW_CHECK_MESSAGE = 'Check this price row.';

/** The largest number of price rows one operator entry may carry (AAP 0.5.6). */
const MAX_PRICE_ROWS = 20;

/** How long the city list — and so each city's currency — stays fresh, in milliseconds. */
const CITIES_STALE_TIME_MS = 60 * 60 * 1000;

// --- The tabs (AAP 0.5.8) ----------------------------------------------------------------------

/** The five queues, in the order their tabs are rendered. */
type QueueTab = 'disputes' | 'reports' | 'call-tasks' | 'lodging-claims' | 'crawl-domains';

/**
 * The tabs, keyed by id: a `Record`, so a tab added to {@link QueueTab} without a label or a test id
 * here fails the type check. {@link QUEUE_TAB_ORDER} alone sets the order they appear in.
 */
const QUEUE_TABS: Record<QueueTab, { readonly label: string; readonly testID: string }> = {
  disputes: { label: 'Disputes', testID: 'ops-queue-tab-disputes' },
  reports: { label: 'Reports', testID: 'ops-queue-tab-reports' },
  'call-tasks': { label: 'Call tasks', testID: 'ops-queue-tab-call-tasks' },
  'lodging-claims': { label: 'Lodging claims', testID: 'ops-queue-tab-lodging-claims' },
  'crawl-domains': { label: 'Crawl domains', testID: 'ops-queue-tab-crawl-domains' },
};

/** The order the tabs appear in, read left to right. */
const QUEUE_TAB_ORDER: readonly QueueTab[] = [
  'disputes',
  'reports',
  'call-tasks',
  'lodging-claims',
  'crawl-domains',
];

/** True when a `?tab=` search parameter names one of the five queues. */
function isQueueTab(value: string | undefined): value is QueueTab {
  return value !== undefined && QUEUE_TAB_ORDER.some((tab) => tab === value);
}

/**
 * The words the queues' stored values are shown with. Each map is held to its enum by `satisfies`,
 * so a value added to a lifecycle cannot reach an operator as a blank line.
 */
const DISPUTE_KIND_LABEL = {
  venue_unavailable: "Venue couldn't witness",
  other: 'Other',
} as const satisfies Record<DisputeKind, string>;

const DISPUTE_STATUS_LABEL = {
  open: 'Open',
  resolved: 'Resolved',
} as const satisfies Record<DisputeStatus, string>;

const CHECK_IN_RESULT_LABEL = {
  pass: 'Checked in',
  fail: 'Check-in failed',
} as const satisfies Record<CheckInResult, string>;

const CALL_TASK_KIND_LABEL = {
  menu_prices: 'Menu prices',
  lodging_stay_verification: 'Stay verification',
} as const satisfies Record<CallTaskKind, string>;

const CALL_TASK_STATUS_LABEL = {
  queued: 'Queued',
  in_progress: 'Calling',
  completed: 'Completed',
  needs_review: 'Needs review',
  refused: 'Refused',
  do_not_call: 'Do not call',
  unreachable: 'Unreachable',
  cancelled: 'Cancelled',
} as const satisfies Record<CallTaskStatus, string>;

const BLOCKED_REASON_LABEL = {
  not_allowlisted: 'number not on the call allowlist',
  no_phone: 'no phone number',
  do_not_call: 'number asked not to be called',
  invalid_number: 'number is not valid',
  vendor_unavailable: 'calling provider unavailable',
  dispatch_unknown: 'dispatch unconfirmed',
  no_final_status: 'no final call status',
} as const satisfies Record<BlockedReason, string>;

const CALL_OUTCOME_LABEL = {
  completed: 'Completed',
  no_answer: 'No answer',
  refused: 'Refused',
  do_not_call: 'Do not call',
  unreachable: 'Unreachable',
  needs_review: 'Needs review',
} as const satisfies Record<CallAttemptOutcome, string>;

const CLAIM_STATUS_LABEL = {
  pending_call: 'Waiting for a call',
  calling: 'Call in progress',
  verified: 'Verified',
  rejected: 'Rejected',
  unreachable: 'Unreachable',
} as const satisfies Record<LodgingClaimStatus, string>;

const CRAWL_DECISION_LABEL = {
  allowed: 'Allowed',
  prohibited: 'Prohibited',
  uncertain: 'Not yet reviewed',
} as const satisfies Record<CrawlDecision, string>;

const ITEM_CATEGORY_LABEL = {
  main: 'Main',
  starter: 'Starter',
  dessert: 'Dessert',
  drink: 'Drink',
  ticket: 'Ticket',
} as const satisfies Record<ItemCategory, string>;

const TICKET_TYPE_LABEL = {
  standard: 'Regular adult admission',
  concession: 'Child, student or senior',
  group: 'Family or group',
} as const satisfies Record<TicketType, string>;

// --- Times -------------------------------------------------------------------------------------

/**
 * The reading one instant is shown with: a medium date, a short time and its zone.
 *
 * `dateStyle: 'medium'` beside `timeStyle: 'short'` is that reading, but ECMA-402 forbids combining
 * either with a component option and rejects `timeZoneName` with them as a `TypeError` ("Invalid
 * option : option"), so the same reading is assembled from the components they stand for —
 * `Nov 4, 2026, 10:30 AM UTC`. A runtime that takes neither form leaves the value as it arrived.
 */
const MOMENT_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

/** The same reading without the zone, for a runtime that rejects `timeZoneName`. */
const MOMENT_FORMAT_WITHOUT_ZONE: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/** Builds the formatter once, at module load, so nothing is rebuilt during a render. */
function createMomentFormatter(): Intl.DateTimeFormat | null {
  for (const options of [MOMENT_FORMAT, MOMENT_FORMAT_WITHOUT_ZONE]) {
    try {
      return new Intl.DateTimeFormat(undefined, options);
    } catch {
      // This runtime refused the form; the next is tried, and the search ends in `null`.
    }
  }
  return null;
}

const MOMENT_FORMATTER = createMomentFormatter();

/** An instant as a queue row shows it, or the value as it arrived when nothing can format it. */
function formatMoment(iso: string): string {
  if (MOMENT_FORMATTER === null) return iso;
  try {
    return MOMENT_FORMATTER.format(new Date(iso));
  } catch {
    return iso;
  }
}

// --- Errors ------------------------------------------------------------------------------------

/**
 * The code a failure carries: the API's own when the client raised one, and `invalid_response` for
 * anything else, which is what the client raises for an answer it could not read.
 */
function codeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'invalid_response';
}

/**
 * The sentence a code is shown with.
 *
 * The four codes an operator meets most get their own wording, because the generic sentence for each
 * would tell an operator less than the queue already does. Every other code keeps the client's own,
 * and no part of the server's message is ever shown (AAP 0.11.1).
 */
function sentenceFor(code: ClientErrorCode): string {
  switch (code) {
    case 'operator_only':
      return 'Operator access required.';
    case 'invalid_outcome':
      return 'This item can no longer be resolved this way. Refresh the queue.';
    case 'details_unavailable':
      return 'Booking details are no longer available (the claim was resolved or its details were erased).';
    case 'not_found':
    case 'claim_not_found':
      return 'This item no longer exists.';
    default:
      return userMessageFor(code);
  }
}

/** The sentence a failure is shown with, from the error the caller holds. */
function messageFor(error: unknown): string {
  return sentenceFor(codeOf(error));
}

// --- The one resolve pattern every action runs -------------------------------------------------

/** What one queue action does, and what it refreshes after it. */
interface QueueAction<TValues> {
  /**
   * Sends the request. Rejects with an `ApiError` the screen maps to a sentence, and its own answer
   * is not read: the queue is re-read instead, so a row always shows what the API last answered.
   */
  readonly run: (values: TValues) => Promise<unknown>;
  /** The keys the action's effect reaches, invalidated once it succeeded. */
  readonly keys: readonly (readonly unknown[])[];
  /** Runs after a successful request, for state a row holds itself. */
  readonly onDone?: () => void;
  /** Runs on a failure, with the code, for a recovery the code itself asks for. */
  readonly onFailed?: (code: ClientErrorCode) => void;
}

/** What {@link useQueueAction} hands a row. */
interface QueueActionHandle<TValues> {
  /** Sends the action. A button is busy meanwhile, so one press sends one request. */
  readonly perform: (values: TValues) => void;
  readonly busy: boolean;
  /** The sentence to show for the last failure, or `null` while none stands. */
  readonly failureMessage: string | null;
}

/**
 * The one mutation every queue action of this screen runs: one request per press, a busy button
 * meanwhile. A success clears the standing failure, invalidates every queue the action reached —
 * the queue's own re-read is what confirms the action to the operator — and speaks `Saved.` on
 * iOS and Android only, `announce` being a no-op on web. A failure is shown in the row's banner
 * and announced with it: the banner's live region speaks it on web, `announce` on iOS and Android.
 */
function useQueueAction<TValues>(action: QueueAction<TValues>): QueueActionHandle<TValues> {
  const [failure, setFailure] = useState<ClientErrorCode | null>(null);

  const mutation = useMutation({
    mutationFn: (values: TValues) => action.run(values),
    onSuccess: () => {
      setFailure(null);
      announce(SAVED_NOTICE);
      for (const key of action.keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      action.onDone?.();
    },
    onError: (error: unknown) => {
      const code = codeOf(error);
      setFailure(code);
      announce(messageFor(error));
      action.onFailed?.(code);
    },
  });

  return {
    perform: (values) => {
      mutation.mutate(values);
    },
    busy: mutation.isPending,
    failureMessage: failure === null ? null : sentenceFor(failure),
  };
}

// --- Controls ----------------------------------------------------------------------------------

/**
 * Keeps the browser's own focus outline off a focused control on web, where it would be painted over
 * the border the control reserves and the ring a keyboard user sees would be the browser's default
 * rather than `colors.focusRing` (WCAG 2.4.7). Empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

/** The three fields of a `keydown` event this screen reads; React Native declares no key event. */
interface WebKeyEvent {
  readonly key?: string;
  readonly repeat?: boolean;
  readonly preventDefault?: () => void;
}

/**
 * Takes Space as an activation the press responder does not: react-native-web's responder answers
 * Enter for any element but Space only for a native `button` or a `role="button"`, and both a tab and
 * a radio chip carry another role. Enter is left to the responder, which would otherwise fire twice.
 */
function spaceActivates(activate: () => void): { onKeyDown?: (event: WebKeyEvent) => void } {
  if (Platform.OS !== 'web') return {};
  return {
    onKeyDown: (event) => {
      if (event.repeat === true) return;
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      // Space would otherwise scroll the page behind the control.
      event.preventDefault?.();
      activate();
    },
  };
}

/** One chip of a radio group. */
interface ChipProps {
  readonly label: string;
  readonly selected: boolean;
  readonly testID: string;
  readonly onSelect: () => void;
}

/**
 * A radio that reports its own checked state, and marks the chosen one by its border colour and its
 * label weight together, so the selection never rests on colour alone (WCAG 1.4.1). The border is
 * painted in every state — `border` at rest, `primary` while chosen, `focusRing` while focused, each
 * a recorded pair — so choosing or focusing a chip moves nothing.
 */
function Chip({ label, selected, testID, onSelect }: ChipProps): ReactElement {
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      {...spaceActivates(onSelect)}
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onPress={onSelect}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      testID={testID}
      style={[
        styles.control,
        selected ? styles.controlSelected : null,
        focused ? styles.controlFocused : null,
        webFocusRingReset,
      ]}
    >
      <Text style={[styles.controlLabel, selected ? styles.controlLabelSelected : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Props of {@link ChoiceGroup}: a labelled radio group over a closed set of string values. */
interface ChoiceGroupProps<V extends string> {
  /** The group's visible label, which is also the group's accessible name. */
  readonly groupLabel: string;
  readonly options: readonly { readonly value: V; readonly label: string }[];
  /** The chosen value, or `null` while none is chosen. */
  readonly value: V | null;
  /** Prefix of each chip's test id: `<prefix>-<value>`. */
  readonly testIDPrefix: string;
  readonly onSelect: (value: V) => void;
}

/** One group with one name: a screen reader reads the question before either choice. */
function ChoiceGroup<V extends string>({
  groupLabel,
  options,
  value,
  testIDPrefix,
  onSelect,
}: ChoiceGroupProps<V>): ReactElement {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{groupLabel}</Text>
      <View role="radiogroup" aria-label={groupLabel} style={styles.choices}>
        {options.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={value === option.value}
            testID={`${testIDPrefix}-${option.value}`}
            onSelect={() => {
              onSelect(option.value);
            }}
          />
        ))}
      </View>
    </View>
  );
}

/** Props of {@link BooleanGroup}: a labelled yes-or-no question with no default. */
interface BooleanGroupProps {
  readonly groupLabel: string;
  readonly trueLabel: string;
  readonly falseLabel: string;
  readonly value: boolean | null;
  /** Prefix of each chip's test id: `<prefix>-yes` and `<prefix>-no`. */
  readonly testIDPrefix: string;
  readonly onSelect: (value: boolean) => void;
}

/**
 * `alcoholic` on a drink and `perPerson` on a ticket both decide what the cost estimate reads
 * (AAP 0.5.7), so neither is guessed: an unchosen chip is a validation failure, not a default. The
 * question is answered by the one radio group above, over the two answers rather than two controls.
 */
function BooleanGroup({
  groupLabel,
  trueLabel,
  falseLabel,
  value,
  testIDPrefix,
  onSelect,
}: BooleanGroupProps): ReactElement {
  return (
    <ChoiceGroup
      groupLabel={groupLabel}
      options={[
        { value: 'yes', label: trueLabel },
        { value: 'no', label: falseLabel },
      ]}
      value={value === null ? null : value ? 'yes' : 'no'}
      testIDPrefix={testIDPrefix}
      onSelect={(answer) => {
        onSelect(answer === 'yes');
      }}
    />
  );
}

/** Props of {@link InlineConfirm}. */
interface InlineConfirmProps {
  /** The action's label, which the confirm step prefixes rather than replaces. */
  readonly label: string;
  readonly variant?: 'primary' | 'secondary';
  /** The sentence the action's own meaning needs, as a native hint and as visible guidance. */
  readonly hint?: string;
  readonly busy?: boolean;
  /** Stable test id; the confirm and cancel steps append `-confirm` and `-cancel`. */
  readonly testID: string;
  readonly onConfirm: () => void;
}

/**
 * An action that asks once before it acts.
 *
 * React Native Web's `Alert` is not usable, so the first press arms the action in place: the button
 * becomes `Confirm: <label>` in the danger variant beside a Cancel. Every action that moves money or
 * removes a result is behind this one — a dispute resolution, a claim's outcome, a do-not-call, a
 * price entry — while a read-only queue offers no action at all.
 */
function InlineConfirm({
  label,
  variant = 'secondary',
  hint,
  busy = false,
  testID,
  onConfirm,
}: InlineConfirmProps): ReactElement {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <Button
        label={label}
        variant={variant}
        busy={busy}
        testID={testID}
        {...(hint === undefined ? {} : { hint })}
        onPress={() => {
          setArmed(true);
        }}
      />
    );
  }

  return (
    <>
      <Button
        label={`${CONFIRM_PREFIX}${label}`}
        variant="danger"
        busy={busy}
        testID={`${testID}-confirm`}
        onPress={onConfirm}
      />
      <Button
        label={CANCEL_LABEL}
        variant="secondary"
        disabled={busy}
        testID={`${testID}-cancel`}
        onPress={() => {
          setArmed(false);
        }}
      />
    </>
  );
}

/** Props of {@link QueueList}. */
interface QueueListProps<T> {
  /** The queue's read: one `/admin` list route, whose body is `{ items }`. */
  readonly query: UseQueryResult<{ items: T[] }, Error>;
  /** The stable identity of one item, which is also its React key. */
  readonly keyOf: (item: T) => string;
  /** One item's content, rendered inside that item's card. */
  readonly renderItem: (item: T) => ReactNode;
  /** What the queue says while it holds nothing. */
  readonly emptyText: string;
  /** Content above the list in every state, such as the overdue-dispute warning. */
  readonly header?: ReactNode;
}

/**
 * The one list all five queues render: a header, the read's failure with a retry, its loading and
 * empty states, and one card per item.
 *
 * The failure is announced once per distinct sentence as well as shown, because iOS has no live
 * region to speak a banner with (AAP 0.5.8); the retry reads the queue again, so a row always shows
 * what the API last answered.
 */
function QueueList<T>({
  query,
  keyOf,
  renderItem,
  emptyText,
  header,
}: QueueListProps<T>): ReactElement {
  const items = query.data?.items ?? [];
  const errorMessage = query.isError ? messageFor(query.error) : null;

  // A read failure is the one failure an effect can announce exactly once: a re-render over the same
  // failed read would otherwise repeat the sentence. An action's failure is announced where it
  // happens instead, because pressing again can produce the same sentence.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (errorMessage === null) {
      announced.current = null;
      return;
    }
    if (announced.current === errorMessage) return;
    announced.current = errorMessage;
    announce(errorMessage);
  }, [errorMessage]);

  const showLoading = items.length === 0 && errorMessage === null && query.isPending;
  const showEmpty = items.length === 0 && errorMessage === null && !query.isPending;

  return (
    <>
      {header ?? null}

      {errorMessage === null ? null : (
        <Banner
          tone="error"
          message={errorMessage}
          testID="ops-queue-error"
          action={{
            label: RETRY_LABEL,
            testID: 'ops-queue-retry',
            onPress: () => {
              void query.refetch();
            },
          }}
        />
      )}

      {showLoading ? <Text style={styles.facts}>{LOADING_NOTICE}</Text> : null}
      {showEmpty ? <Text style={styles.facts}>{emptyText}</Text> : null}

      {items.map((item) => (
        <Card key={keyOf(item)}>{renderItem(item)}</Card>
      ))}
    </>
  );
}

// --- Operator price entry (AAP 0.5.6) ----------------------------------------------------------

/**
 * The sentence each field of a price row is flagged with, keyed by the `PriceItemInput` property its
 * issue names, so an unlisted field fails to compile rather than reaching the operator as a bare
 * validation message.
 */
const PRICE_FIELD_MESSAGE = {
  name: 'Enter the item name.',
  priceText: 'Enter the price exactly as quoted.',
  currency: 'Use a three-letter currency code, such as EUR.',
  localAmountMinor: 'Enter the amount in minor units, digits only.',
  alcoholic: 'Choose non-alcoholic or alcoholic.',
  perPerson: 'Choose whether the price admits one person.',
  ticketType: 'Choose the ticket type.',
} as const;

type PriceField = keyof typeof PRICE_FIELD_MESSAGE;
type PriceRowFailures = Partial<Record<PriceField, string>>;

/** True when a validation issue names one of the fields a price row shows. */
function isPriceField(value: unknown): value is PriceField {
  return typeof value === 'string' && value in PRICE_FIELD_MESSAGE;
}

/** The categories a price row may carry, and the three ticket kinds, in chip order. */
const ITEM_CATEGORY_OPTIONS = ItemCategory.options.map((value) => ({
  value,
  label: ITEM_CATEGORY_LABEL[value],
}));

const TICKET_TYPE_OPTIONS = TicketType.options.map((value) => ({
  value,
  label: TICKET_TYPE_LABEL[value],
}));

/** One row of the price entry, before it is validated into a `PriceItemInput`. */
interface PriceRowState {
  /** Stable identity, which is also the React key: rows are added and removed. */
  readonly key: number;
  readonly name: string;
  readonly category: ItemCategory;
  readonly priceText: string;
  readonly currency: string;
  readonly amountText: string;
  readonly alcoholic: boolean | null;
  readonly perPerson: boolean | null;
  readonly ticketType: TicketType | null;
}

/** A fresh row: a main course in the city's own currency, with nothing else chosen yet. */
function newPriceRow(key: number, currency: string): PriceRowState {
  return {
    key,
    name: '',
    category: 'main',
    priceText: '',
    currency,
    amountText: '',
    alcoholic: null,
    perPerson: null,
    ticketType: null,
  };
}

/**
 * Validates one row and names the field to correct.
 *
 * `PriceItemInput.safeParse` is the authority on what `POST /admin/call-tasks/:id/resolve` accepts,
 * so a price is only sent as the parsed value of the schema that will also store it. `perPerson` and
 * `ticketType` travel as `null` — never absent — off a ticket, because the schema is strict and its
 * ticket rule refuses a non-null pair on any other category; `alcoholic` is checked here, because the
 * schema admits a null one on a drink while the estimate needs it to leave alcohol out (AAP 0.5.7).
 */
function validateRow(row: PriceRowState): {
  item: PriceItemInput | null;
  failures: PriceRowFailures;
} {
  const failures: PriceRowFailures = {};
  const amountText = row.amountText.trim();

  const parsed = PriceItemInput.safeParse({
    name: row.name.trim(),
    category: row.category,
    priceText: row.priceText.trim(),
    currency: row.currency.trim().toUpperCase(),
    alcoholic: row.category === 'drink' ? row.alcoholic : null,
    perPerson: row.category === 'ticket' ? row.perPerson : null,
    ticketType: row.category === 'ticket' ? row.ticketType : null,
    localAmountMinor: /^\d+$/.test(amountText) ? Number.parseInt(amountText, 10) : Number.NaN,
  });

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field: unknown = issue.path[0];
      if (!isPriceField(field)) continue;
      failures[field] ??= PRICE_FIELD_MESSAGE[field];
    }
    // A row the schema refused without naming a field still has to be corrected by hand.
    if (Object.keys(failures).length === 0) failures.name = ROW_CHECK_MESSAGE;
  }

  // The fields the schema itself admits empty or unset are checked here. A name of spaces is a valid
  // `z.string()` but an unusable price record, and the three chip answers are checked because the
  // schema's ticket rule is a refinement: Zod does not run one over a value its own object checks
  // already failed, so a ticket row missing its name would be flagged on the name alone and hide what
  // else it needs. The refinement remains the authority on what the API accepts.
  if (row.name.trim() === '') failures.name ??= PRICE_FIELD_MESSAGE.name;
  if (row.priceText.trim() === '') failures.priceText ??= PRICE_FIELD_MESSAGE.priceText;

  if (row.category === 'drink' && row.alcoholic === null) {
    failures.alcoholic ??= PRICE_FIELD_MESSAGE.alcoholic;
  }
  if (row.category === 'ticket') {
    if (row.perPerson === null) failures.perPerson ??= PRICE_FIELD_MESSAGE.perPerson;
    if (row.ticketType === null) failures.ticketType ??= PRICE_FIELD_MESSAGE.ticketType;
  }

  return {
    item: parsed.success && Object.keys(failures).length === 0 ? parsed.data : null,
    failures,
  };
}

/** Props of {@link PriceEntryForm}. */
interface PriceEntryFormProps {
  /** The city's currency, which every new row starts in. */
  readonly defaultCurrency: string;
  readonly busy: boolean;
  /** Prefix of every test id of the form. */
  readonly testIDPrefix: string;
  readonly onCancel: () => void;
  readonly onSubmit: (prices: PriceItemInput[]) => void;
}

/**
 * The prices one `menu_prices` call quoted, entered row by row (AAP 0.5.6).
 *
 * A ticket row states whether the price admits one person and which admission it is, because the
 * estimate reads only standard per-person tickets; a drink row states whether it is alcoholic,
 * because only non-alcoholic drinks count toward a day cost (AAP 0.5.7). The API stores what is sent
 * as `operator_entry` and converts it with the capture date's FX rate.
 */
function PriceEntryForm({
  defaultCurrency,
  busy,
  testIDPrefix,
  onCancel,
  onSubmit,
}: PriceEntryFormProps): ReactElement {
  const [rows, setRows] = useState<readonly PriceRowState[]>(() => [
    newPriceRow(0, defaultCurrency),
  ]);
  const [failures, setFailures] = useState<Readonly<Record<number, PriceRowFailures>>>({});
  const nextKey = useRef(1);

  const update = (key: number, patch: Partial<PriceRowState>): void => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    const key = nextKey.current;
    nextKey.current += 1;
    setRows((current) => [...current, newPriceRow(key, defaultCurrency)]);
  };

  // The form keeps one row at all times, so removing the last one is refused rather than leaving an
  // entry with nothing to send.
  const removeRow = (key: number): void => {
    setRows((current) =>
      current.length === 1 ? current : current.filter((row) => row.key !== key),
    );
    setFailures(({ [key]: _removed, ...rest }) => rest);
  };

  const submit = (): void => {
    const raised: Record<number, PriceRowFailures> = {};
    const prices: PriceItemInput[] = [];

    for (const row of rows) {
      const checked = validateRow(row);
      if (checked.item === null) {
        raised[row.key] = checked.failures;
        continue;
      }
      prices.push(checked.item);
    }

    setFailures(raised);
    if (Object.keys(raised).length > 0) {
      announce(INVALID_PRICE_ROWS_NOTICE);
      return;
    }
    onSubmit(prices);
  };

  return (
    <>
      <Text style={styles.facts}>
        Enter each price exactly as it was quoted. A price is stored only if it is complete.
      </Text>

      {rows.map((row, index) => {
        const flagged = failures[row.key] ?? {};
        const id = (suffix: string): string => `${testIDPrefix}-row-${index}-${suffix}`;

        return (
          <View key={row.key} style={styles.priceRow}>
            <Text style={styles.groupLabel}>{`Price ${index + 1}`}</Text>

            <TextField
              label="Item name"
              value={row.name}
              onChangeText={(name) => {
                update(row.key, { name });
              }}
              error={flagged.name ?? null}
              testID={id('name')}
            />

            <ChoiceGroup
              groupLabel="Category"
              options={ITEM_CATEGORY_OPTIONS}
              value={row.category}
              testIDPrefix={id('category')}
              onSelect={(category) => {
                update(row.key, { category });
              }}
            />

            <TextField
              label="Price as quoted"
              hint="Verbatim, for example ฿120 or 45K"
              value={row.priceText}
              onChangeText={(priceText) => {
                update(row.key, { priceText });
              }}
              error={flagged.priceText ?? null}
              testID={id('price-text')}
            />

            <TextField
              label="Currency"
              hint="Three letters, as the guest pays at the venue"
              value={row.currency}
              maxLength={3}
              autoCapitalize="characters"
              autoCorrect={false}
              onChangeText={(currency) => {
                update(row.key, { currency });
              }}
              error={flagged.currency ?? null}
              testID={id('currency')}
            />

            <TextField
              label="Amount in minor units"
              hint="The smallest unit: 12050 is 120.50"
              inputMode="numeric"
              keyboardType="number-pad"
              value={row.amountText}
              onChangeText={(amountText) => {
                update(row.key, { amountText });
              }}
              error={flagged.localAmountMinor ?? null}
              testID={id('amount')}
            />

            {row.category === 'drink' ? (
              <BooleanGroup
                groupLabel="Alcoholic"
                trueLabel="Alcoholic"
                falseLabel="Non-alcoholic"
                value={row.alcoholic}
                testIDPrefix={id('alcoholic')}
                onSelect={(alcoholic) => {
                  update(row.key, { alcoholic });
                }}
              />
            ) : null}

            {row.category === 'ticket' ? (
              <>
                <BooleanGroup
                  groupLabel="Per person"
                  trueLabel="One person"
                  falseLabel="More than one person"
                  value={row.perPerson}
                  testIDPrefix={id('per-person')}
                  onSelect={(perPerson) => {
                    update(row.key, { perPerson });
                  }}
                />
                <ChoiceGroup
                  groupLabel="Ticket type"
                  options={TICKET_TYPE_OPTIONS}
                  value={row.ticketType}
                  testIDPrefix={id('ticket-type')}
                  onSelect={(ticketType) => {
                    update(row.key, { ticketType });
                  }}
                />
              </>
            ) : null}

            {/* The chip groups carry no field of their own to show an error under, so the sentences
                raised for them are painted beside them. */}
            {(['alcoholic', 'perPerson', 'ticketType'] as const).map((field) =>
              flagged[field] === undefined ? null : (
                <Text key={field} style={styles.fieldError}>{`Error: ${flagged[field]}`}</Text>
              ),
            )}

            <Button
              label="Remove this price"
              variant="secondary"
              disabled={rows.length === 1}
              testID={id('remove')}
              onPress={() => {
                removeRow(row.key);
              }}
            />
          </View>
        );
      })}

      <View style={styles.actions}>
        <Button
          label="Add another price"
          variant="secondary"
          disabled={rows.length >= MAX_PRICE_ROWS}
          testID={`${testIDPrefix}-add`}
          onPress={addRow}
        />
        <Button
          label="Save the prices"
          busy={busy}
          testID={`${testIDPrefix}-submit`}
          onPress={submit}
        />
        <Button
          label={CANCEL_LABEL}
          variant="secondary"
          disabled={busy}
          testID={`${testIDPrefix}-cancel`}
          onPress={onCancel}
        />
      </View>
    </>
  );
}

// --- The resolve bodies (AAP 0.5.4) ------------------------------------------------------------

/**
 * The body of one resolve route, typed by the shared enum rather than by a string literal, so a
 * misspelt outcome fails to compile instead of reaching a handler that must refuse it.
 */
function disputeBody(outcome: DisputeOutcome): ResolveDispute {
  return { outcome };
}

/** `prices` is present only when the operator recorded the call's own quotes (AAP 0.5.6). */
function callTaskBody(
  outcome: OperatorCallTaskOutcome,
  prices?: readonly PriceItemInput[],
): ResolveCallTask {
  return prices === undefined ? { outcome } : { outcome, prices: [...prices] };
}

function claimBody(outcome: OperatorClaimOutcome): ResolveLodgingClaim {
  return { outcome };
}

/** The two decisions an operator may record; `uncertain` is where an unreviewed domain already sits. */
function crawlBody(decision: Exclude<CrawlDecision, 'uncertain'>): CrawlDomainDecisionUpdate {
  return { decision };
}

// --- The call-task queue (AAP 0.5.3, 0.5.4, 0.5.6) ---------------------------------------------

/** The statuses a `menu_prices` task may still be resolved from: every non-terminal one. */
const RESOLVABLE_CALL_STATUSES: readonly CallTaskStatus[] = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
];

/** Each city's currency, which a new price row starts in. */
function useCityCurrencies(): ReadonlyMap<string, string> {
  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: CITIES_STALE_TIME_MS,
  });

  return useMemo(() => {
    const currencies = new Map<string, string>();
    const items: readonly CityDto[] = cities.data?.items ?? [];
    for (const city of items) {
      currencies.set(city.id, city.currency);
    }
    return currencies;
  }, [cities.data]);
}

/**
 * One call task: what it is, where it stands, what the call produced, and the outcomes an operator
 * may record.
 *
 * A `lodging_stay_verification` task shows no resolve controls at all — it is resolved through its
 * claim, and the API answers `422 invalid_outcome` for any outcome recorded here — and neither does a
 * `menu_prices` task whose status no longer admits one (AAP 0.5.3).
 */
function CallTaskRow({
  task,
  currency,
}: {
  readonly task: AdminCallTaskDto;
  readonly currency: string;
}): ReactElement {
  const [entryOpen, setEntryOpen] = useState(false);
  const action = useQueueAction<ResolveCallTask>({
    run: (body) => apiClient.admin.resolveCallTask(task.id, body),
    keys: [queryKeys.adminCallTasks],
    onDone: () => {
      setEntryOpen(false);
    },
  });

  const isMenuTask = task.kind === 'menu_prices';
  const resolvable = RESOLVABLE_CALL_STATUSES.some((status) => status === task.status);
  const testID = `ops-call-task-${task.id}`;
  const attempts = `${task.attempts} ${task.attempts === 1 ? 'attempt' : 'attempts'}`;

  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{task.targetName}</Text>
      <Text style={styles.facts}>
        {`${task.cityId} · ${CALL_TASK_KIND_LABEL[task.kind]} · ${
          CALL_TASK_STATUS_LABEL[task.status]
        } · ${attempts}`}
      </Text>
      {task.nextAttemptAt === null ? null : (
        <Text style={styles.facts}>{`Next attempt ${formatMoment(task.nextAttemptAt)}`}</Text>
      )}
      {task.blockedReason === null ? null : (
        <Text style={styles.facts}>
          {`Blocked: ${BLOCKED_REASON_LABEL[task.blockedReason]}`}
          {/* A provider listing cannot prove that no call was placed (AAP 0.3.2). */}
          {task.blockedReason === 'dispatch_unknown'
            ? '. The provider listings are candidates only; confirm before resolving.'
            : '.'}
        </Text>
      )}
      {task.lastOutcome === null ? null : (
        <Text style={styles.facts}>{`Last outcome ${CALL_OUTCOME_LABEL[task.lastOutcome]}`}</Text>
      )}
      {task.lastSummary === null ? null : <Text style={styles.facts}>{task.lastSummary}</Text>}

      {isMenuTask && task.extractedFields !== null ? (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>What the call extracted</Text>
          {Object.entries(task.extractedFields).map(([field, value]) => (
            <Text key={field} style={styles.facts}>
              {`${field}: ${value === null ? '—' : String(value)}`}
            </Text>
          ))}
        </View>
      ) : null}

      {action.failureMessage === null ? null : (
        <Banner tone="error" message={action.failureMessage} testID={`${testID}-error`} />
      )}

      {!isMenuTask ? (
        <Text style={styles.facts}>Resolved through its lodging claim.</Text>
      ) : entryOpen ? (
        <PriceEntryForm
          defaultCurrency={currency}
          busy={action.busy}
          testIDPrefix={`${testID}-prices`}
          onCancel={() => {
            setEntryOpen(false);
          }}
          onSubmit={(prices) => {
            action.perform(callTaskBody('completed', prices));
          }}
        />
      ) : resolvable ? (
        <View style={styles.actions}>
          <Button
            label="Record prices from the call"
            testID={`${testID}-entry`}
            onPress={() => {
              setEntryOpen(true);
            }}
          />
          {task.extractedFields === null ? null : (
            <InlineConfirm
              label="Approve the call's quoted prices"
              hint="Stores the prices the call quoted as the operator's own entry."
              busy={action.busy}
              testID={`${testID}-approve`}
              onConfirm={() => {
                action.perform(callTaskBody('completed'));
              }}
            />
          )}
          <InlineConfirm
            label="Refused"
            hint="The business asked not to continue."
            busy={action.busy}
            testID={`${testID}-refused`}
            onConfirm={() => {
              action.perform(callTaskBody('refused'));
            }}
          />
          <InlineConfirm
            label="Do not call"
            hint="Also marks the place do-not-call and cancels its other tasks."
            busy={action.busy}
            testID={`${testID}-do-not-call`}
            onConfirm={() => {
              action.perform(callTaskBody('do_not_call'));
            }}
          />
          <InlineConfirm
            label="Unreachable"
            hint="You could not obtain the prices either."
            busy={action.busy}
            testID={`${testID}-unreachable`}
            onConfirm={() => {
              action.perform(callTaskBody('unreachable'));
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The call queue: the dialing queue in its priority order. */
function CallTasksPanel(): ReactElement {
  const tasks = useQuery({
    queryKey: queryKeys.adminCallTasks,
    queryFn: () => apiClient.admin.listCallTasks(),
  });
  const currencies = useCityCurrencies();

  return (
    <QueueList
      query={tasks}
      keyOf={(task) => task.id}
      emptyText="No call tasks are waiting."
      renderItem={(task) => (
        <CallTaskRow task={task} currency={currencies.get(task.cityId) ?? ''} />
      )}
    />
  );
}

// --- The report queue (AAP 0.5.4) --------------------------------------------------------------

/**
 * The report queue, read only: who reported whom, why, and which meetup it concerns.
 *
 * Nothing is resolved here. A report records what a traveler told us, and the safety actions it may
 * lead to — a block, a deletion — belong to the traveler's own screens (AAP 0.7.2).
 */
function ReportsPanel(): ReactElement {
  const reports = useQuery({
    queryKey: queryKeys.adminReports,
    queryFn: () => apiClient.admin.listReports(),
  });

  return (
    <QueueList
      query={reports}
      keyOf={(report) => report.id}
      emptyText="No reports are waiting."
      renderItem={(report: AdminReportDto) => (
        <View style={styles.row}>
          <Text style={styles.rowTitle}>
            {`${report.reporterHandle ?? DELETED_ACCOUNT_TEXT} reported ${
              report.reportedHandle ?? DELETED_ACCOUNT_TEXT
            }`}
          </Text>
          <Text style={styles.facts}>{report.reason ?? REMOVED_REASON_TEXT}</Text>
          {report.meetupId === null ? null : (
            <Text style={styles.facts}>{`Meetup ${report.meetupId}`}</Text>
          )}
          <Text style={styles.facts}>{`Reported ${formatMoment(report.createdAt)}`}</Text>
        </View>
      )}
    />
  );
}

// --- The dispute queue (AAP 0.5.3, 0.5.4, 0.12.2) ---------------------------------------------

/**
 * How the settle-by-check-ins action explains itself: a resolution before the meetup's window closes
 * only ends the dispute, the meetup stays `locked`, check-in stays open, and the outcome is applied
 * when the window does — so a check-in made in between still counts (AAP 0.5.3).
 */
const SETTLE_HINT = `A resolution before the start plus ${CHECK_IN_CLOSES_AFTER_MINUTES} minutes only closes the dispute; the outcome then waits for the check-in window.`;

/**
 * One dispute: what it concerns, its participants' check-ins, and the two resolutions an operator may
 * record while it is open. A resolved dispute shows no controls, because the handler answers `422
 * invalid_outcome` for a second resolution.
 */
function DisputeRow({ dispute }: { readonly dispute: AdminDisputeDto }): ReactElement {
  const action = useQueueAction<ResolveDispute>({
    run: (body) => apiClient.admin.resolveDispute(dispute.id, body),
    keys: [queryKeys.adminDisputes],
  });
  const testID = `ops-dispute-${dispute.id}`;

  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{`${dispute.venueName} · ${dispute.cityId}`}</Text>
      <Text style={styles.facts}>
        {`${DISPUTE_KIND_LABEL[dispute.kind]} · ${DISPUTE_STATUS_LABEL[dispute.status]}${
          dispute.overdue ? ` · ${OVERDUE_BADGE}` : ''
        }`}
      </Text>
      <Text style={styles.facts}>{dispute.reason ?? REMOVED_REASON_TEXT}</Text>
      <Text style={styles.facts}>{`Opened ${formatMoment(dispute.openedAt)}`}</Text>
      <Text style={styles.facts}>{`Resolve by ${formatMoment(dispute.deadlineAt)}`}</Text>
      {dispute.checkIns.map((entry, index) => (
        <Text key={`${String(index)}-${entry.handle ?? ''}`} style={styles.facts}>
          {`${entry.handle ?? DELETED_ACCOUNT_TEXT}: ${
            entry.result === null ? NO_CHECK_IN_TEXT : CHECK_IN_RESULT_LABEL[entry.result]
          }`}
        </Text>
      ))}
      <Text style={styles.facts}>{`Meetup ${dispute.meetupId}`}</Text>

      {action.failureMessage === null ? null : (
        <Banner tone="error" message={action.failureMessage} testID={`${testID}-error`} />
      )}

      {dispute.status === 'open' ? (
        <View style={styles.actions}>
          <InlineConfirm
            label="Settle by check-ins"
            hint={SETTLE_HINT}
            busy={action.busy}
            testID={`${testID}-settle`}
            onConfirm={() => {
              action.perform(disputeBody('settle_by_checkins'));
            }}
          />
          <InlineConfirm
            label="No fault — release holds"
            hint="Releases both card holds, and neither attendee carries a no-show."
            busy={action.busy}
            testID={`${testID}-no-fault`}
            onConfirm={() => {
              action.perform(disputeBody('no_fault'));
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The dispute queue, nearest deadline first, with the deadline warning above it (AAP 0.12.2). */
function DisputesPanel(): ReactElement {
  const disputes = useQuery({
    queryKey: queryKeys.adminDisputes,
    queryFn: () => apiClient.admin.listDisputes(),
  });

  const overdue = (disputes.data?.items ?? []).filter((dispute) => dispute.overdue).length;

  return (
    <QueueList
      query={disputes}
      keyOf={(dispute) => dispute.id}
      emptyText="No disputes are waiting."
      header={
        overdue === 0 ? null : (
          <Banner
            tone="warning"
            message={`${overdue} ${
              overdue === 1 ? 'dispute is' : 'disputes are'
            } past the ${DISPUTE_RESOLUTION_DAYS}-day resolution deadline.`}
            testID="ops-disputes-overdue"
          />
        )
      }
      renderItem={(dispute) => <DisputeRow dispute={dispute} />}
    />
  );
}

// --- The lodging-claim queue (AAP 0.5.2, 0.5.3, 0.5.4) -----------------------------------------

/** The two statuses an operator may resolve a claim from (AAP 0.5.3). */
const RESOLVABLE_CLAIM_STATUSES: readonly LodgingClaimStatus[] = ['pending_call', 'calling'];

/**
 * One lodging claim: the lodging and the number to dial, the stay being verified, and the outcomes an
 * operator may record.
 *
 * The booking details are the app's one audited decryption: read only when the operator asks, never
 * through React Query — so a decrypted name reaches neither the cache nor a refetch — and dropped
 * when the row loses focus. The API logs the read itself and answers `409 details_unavailable` once
 * the claim is terminal or its details were erased, which also refreshes the queue because the row's
 * `detailsAvailable` has just changed.
 */
function LodgingClaimRow({ claim }: { readonly claim: AdminLodgingClaimDto }): ReactElement {
  const [details, setDetails] = useState<BookingDetailsDto | null>(null);
  const [detailsFailure, setDetailsFailure] = useState<ClientErrorCode | null>(null);
  const [readingDetails, setReadingDetails] = useState(false);
  const detailsInFlight = useRef(false);

  const action = useQueueAction<ResolveLodgingClaim>({
    run: (body) => apiClient.admin.resolveLodgingClaim(claim.id, body),
    // Resolving a claim cancels the verification work still outstanding for it, so the call queue is
    // refreshed beside this one (AAP 0.5.3).
    keys: [queryKeys.adminLodgingClaims, queryKeys.adminCallTasks],
    onDone: () => {
      setDetails(null);
      setDetailsFailure(null);
    },
  });

  // This cleanup runs when the screen loses focus and when the row unmounts, which is what takes the
  // decrypted name off the screen as soon as the operator looks elsewhere.
  useFocusEffect(
    useCallback(() => {
      return () => {
        setDetails(null);
      };
    }, []),
  );

  const readDetails = (): void => {
    if (detailsInFlight.current) return;
    detailsInFlight.current = true;
    setReadingDetails(true);
    setDetailsFailure(null);

    void (async () => {
      try {
        setDetails(await apiClient.admin.getBookingDetails(claim.id));
      } catch (error) {
        const code = codeOf(error);
        setDetailsFailure(code);
        announce(messageFor(error));
        if (code === 'details_unavailable') {
          await queryClient.invalidateQueries({ queryKey: queryKeys.adminLodgingClaims });
        }
      } finally {
        detailsInFlight.current = false;
        setReadingDetails(false);
      }
    })();
  };

  const testID = `ops-claim-${claim.id}`;
  const failureMessage =
    detailsFailure === null ? action.failureMessage : sentenceFor(detailsFailure);
  // The read is offered only while the API reports the details readable, and only when none are on
  // screen: once they are, the row offers Hide instead.
  const canReadDetails = details === null && claim.detailsAvailable;

  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{claim.lodgingName}</Text>
      <Text style={styles.facts}>
        {claim.lodgingPhone === null ? 'No phone number on file' : `Phone ${claim.lodgingPhone}`}
      </Text>
      <Text style={styles.facts}>{`${claim.cityId} · ${CLAIM_STATUS_LABEL[claim.status]}`}</Text>
      <Text style={styles.facts}>{`Stay ${claim.stayFrom} to ${claim.stayTo}`}</Text>
      <Text style={styles.facts}>{`Opened ${formatMoment(claim.createdAt)}`}</Text>
      <Text style={styles.facts}>
        {`Expires ${formatMoment(claim.expiresAt)} — unresolved claims expire after ${
          CLAIM_EXPIRY_HOURS
        } hours without penalty.`}
      </Text>
      <Text style={styles.facts}>
        {claim.detailsAvailable ? 'Booking details available' : 'Booking details erased'}
      </Text>

      {failureMessage === null ? null : (
        <Banner tone="error" message={failureMessage} testID={`${testID}-error`} />
      )}

      {canReadDetails ? (
        <Button
          label="Show booking details"
          variant="secondary"
          busy={readingDetails}
          hint="Reads the booking name and reference for the verification call. The read is logged."
          testID={`${testID}-details`}
          onPress={readDetails}
        />
      ) : null}

      {details === null ? null : (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>Booking details</Text>
          <Text selectable style={styles.rowTitle}>
            {details.bookingName}
          </Text>
          {details.bookingReference === null ? null : (
            <Text selectable style={styles.facts}>
              {details.bookingReference}
            </Text>
          )}
          <Text style={styles.facts}>{DETAILS_NOTE}</Text>
          <Button
            label="Hide booking details"
            variant="secondary"
            testID={`${testID}-hide-details`}
            onPress={() => {
              setDetails(null);
            }}
          />
        </View>
      )}

      {RESOLVABLE_CLAIM_STATUSES.some((status) => status === claim.status) ? (
        <View style={styles.actions}>
          <InlineConfirm
            label="Verified"
            hint="Reception confirmed the guest is staying."
            busy={action.busy}
            testID={`${testID}-verified`}
            onConfirm={() => {
              action.perform(claimBody('verified'));
            }}
          />
          <InlineConfirm
            label="Rejected"
            hint="Reception said no such guest is staying."
            busy={action.busy}
            testID={`${testID}-rejected`}
            onConfirm={() => {
              action.perform(claimBody('rejected'));
            }}
          />
          <InlineConfirm
            label="Unreachable"
            hint="The lodging could not confirm the stay and the claim has run out of options."
            busy={action.busy}
            testID={`${testID}-unreachable`}
            onConfirm={() => {
              action.perform(claimBody('unreachable'));
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The lodging-claim queue: each claim's stay, its resolution state and its booking-details state. */
function LodgingClaimsPanel(): ReactElement {
  const claims = useQuery({
    queryKey: queryKeys.adminLodgingClaims,
    queryFn: () => apiClient.admin.listLodgingClaims(),
  });

  return (
    <QueueList
      query={claims}
      keyOf={(claim) => claim.id}
      emptyText="No lodging claims are waiting."
      renderItem={(claim) => <LodgingClaimRow claim={claim} />}
    />
  );
}

// --- The crawl-domain queue (AAP 0.5.6) --------------------------------------------------------

/** Why a domain's decision was recorded; anything else is the operator's own note, shown as written. */
const CRAWL_REASON_LABEL = {
  awaiting_review: 'Awaiting review',
  blocklist: 'On the blocklist',
} as const satisfies Record<string, string>;

/**
 * One crawl domain: the decision recorded for it, and the two an operator may record.
 *
 * A domain is never fetched before an operator has read the site's own terms and recorded `allowed`
 * — nothing reads them automatically (AAP 0.5.6) — so the Allow action says as much. A blocklisted
 * domain is `prohibited` whatever is stored here, because the workers hold their own list, and the
 * row says so rather than letting an override read as a way past the blocklist. The client itself
 * encodes the domain in the path, so it is passed through as the queue read it.
 */
function CrawlDomainRow({ entry }: { readonly entry: AdminCrawlDomainDto }): ReactElement {
  const action = useQueueAction<CrawlDomainDecisionUpdate>({
    run: (body) => apiClient.admin.setCrawlDomainDecision(entry.domain, body),
    keys: [queryKeys.adminCrawlDomains],
  });

  const blocklisted = entry.reason === 'blocklist';
  const reason =
    entry.reason === 'awaiting_review' || entry.reason === 'blocklist'
      ? CRAWL_REASON_LABEL[entry.reason]
      : `Recorded by an operator: ${entry.reason}`;
  const testID = `ops-crawl-domain-${entry.domain}`;

  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{entry.domain}</Text>
      <Text style={styles.facts}>
        {`${CRAWL_DECISION_LABEL[entry.decision]} · ${reason} · ${
          entry.overridden ? 'Operator decision' : 'Automatic'
        }`}
      </Text>
      <Text style={styles.facts}>{`Checked ${formatMoment(entry.checkedAt)}`}</Text>
      {blocklisted ? (
        <Text style={styles.facts}>
          On the blocklist: the workers never fetch this domain, whatever is recorded here.
        </Text>
      ) : null}

      {action.failureMessage === null ? null : (
        <Banner tone="error" message={action.failureMessage} testID={`${testID}-error`} />
      )}

      <View style={styles.actions}>
        {entry.decision === 'allowed' ? null : (
          <InlineConfirm
            label="Allow"
            variant="primary"
            hint="Allow only after reading the site's terms."
            busy={action.busy}
            testID={`${testID}-allow`}
            onConfirm={() => {
              action.perform(crawlBody('allowed'));
            }}
          />
        )}
        {entry.decision === 'prohibited' ? null : (
          <InlineConfirm
            label="Prohibit"
            hint="Its places then take the phone fallback."
            busy={action.busy}
            testID={`${testID}-prohibit`}
            onConfirm={() => {
              action.perform(crawlBody('prohibited'));
            }}
          />
        )}
      </View>
    </View>
  );
}

/** The crawl-domain queue: the domains whose site terms an operator has yet to judge. */
function CrawlDomainsPanel(): ReactElement {
  const domains = useQuery({
    queryKey: queryKeys.adminCrawlDomains,
    queryFn: () => apiClient.admin.listCrawlDomains(),
  });

  return (
    <QueueList
      query={domains}
      keyOf={(entry) => entry.domain}
      emptyText="No domains are waiting for a site-terms decision."
      renderItem={(entry) => <CrawlDomainRow entry={entry} />}
    />
  );
}

// --- The screen -------------------------------------------------------------------------------

/**
 * One tab of the tablist.
 *
 * It carries `role="tab"` with `aria-selected`, and is not a `Button`: that primitive's role is
 * `button`, and a tab is not one. react-native-web 0.19 turns the pair into a `role="tab"` element
 * carrying `aria-selected` — it implements that ARIA alias, while it does not implement
 * `accessibilityState` at all — and React Native maps the same alias onto its own state on iOS and
 * Android. The chosen tab is marked three ways, so the selection never rests on colour alone.
 */
function TabButton({
  tab,
  selected,
  onSelect,
}: {
  readonly tab: QueueTab;
  readonly selected: boolean;
  readonly onSelect: (tab: QueueTab) => void;
}): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const spec = QUEUE_TABS[tab];

  const activate = useCallback(() => {
    onSelect(tab);
  }, [onSelect, tab]);

  return (
    <Pressable
      {...spaceActivates(activate)}
      role="tab"
      aria-selected={selected}
      aria-label={spec.label}
      onPress={activate}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={spec.testID}
      style={({ pressed }) => [
        styles.control,
        hovered && !selected ? styles.controlHovered : null,
        pressed ? styles.controlPressed : null,
        selected ? styles.controlSelected : null,
        focused ? styles.controlFocused : null,
        webFocusRingReset,
      ]}
    >
      <Text style={[styles.controlLabel, selected ? styles.tabLabelSelected : null]}>
        {spec.label}
      </Text>
    </Pressable>
  );
}

/**
 * The operator's five queues on one screen (AAP 0.5.8's `/ops/queues`).
 *
 * The selection is this screen's own state, seeded once from a valid `?tab=` search parameter so a
 * link that names a queue opens that queue. Only the tab on show is mounted, which is what keeps one
 * queue's read — and the audited booking details a claim row may hold — out of the next tab's.
 *
 * @returns The queue screen.
 */
export default function OpsQueuesScreen(): ReactElement {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<QueueTab>(() =>
    isQueueTab(params.tab) ? params.tab : 'disputes',
  );

  return (
    <Screen title={SCREEN_TITLE}>
      {/* The ops area's Stack mounts with `headerShown: false`, so no navigator header names this
          route: the Screen's own title is the page's only heading, which is what a web heading
          structure and a screen reader's outline read. This element records the route's title. */}
      <Stack.Screen options={{ title: SCREEN_TITLE }} />

      <View
        role="tablist"
        aria-label={TABLIST_LABEL}
        style={styles.choices}
        testID="ops-queue-tabs"
      >
        {QUEUE_TAB_ORDER.map((id) => (
          <TabButton key={id} tab={id} selected={id === tab} onSelect={setTab} />
        ))}
      </View>

      <View
        role="tabpanel"
        aria-label={QUEUE_TABS[tab].label}
        style={styles.panel}
        testID={`ops-queue-panel-${tab}`}
      >
        {tab === 'disputes' ? <DisputesPanel /> : null}
        {tab === 'reports' ? <ReportsPanel /> : null}
        {tab === 'call-tasks' ? <CallTasksPanel /> : null}
        {tab === 'lodging-claims' ? <LodgingClaimsPanel /> : null}
        {tab === 'crawl-domains' ? <CrawlDomainsPanel /> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // A tab and a chip are the same control: a bordered, keyboard-focusable surface whose border is
  // painted in every state, so choosing, hovering or focusing one moves nothing. `border` is the
  // resting edge (3.7:1 on the page), `primary` the chosen one and `focusRing` the focused one.
  control: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
    borderWidth: borderWidths.control,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  controlHovered: {
    backgroundColor: colors.surface,
  },
  // The whole control dims while pressed, the step the `/ops` bar's links paint, because the palette
  // holds no second fill for a control resting on the page's own background.
  controlPressed: {
    opacity: interactionOpacity.pressed,
  },
  controlSelected: {
    borderColor: colors.primary,
  },
  controlFocused: {
    borderColor: colors.focusRing,
  },
  controlLabel: {
    ...typography.label,
    color: colors.text,
  },
  // A chosen chip reads by colour and weight; a chosen tab adds the underline as well.
  controlLabelSelected: {
    color: colors.primary,
    fontWeight: fontWeights.bold,
  },
  tabLabelSelected: {
    color: colors.primary,
    fontWeight: fontWeights.bold,
    textDecorationLine: 'underline',
  },
  panel: {
    gap: spacing.md,
  },
  row: {
    gap: spacing.sm,
  },
  rowTitle: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  // A row's facts and a queue's own notices are secondary text: the muted pair on the page (7.07:1)
  // and on the `surface` a price row paints (6.38:1), both recorded.
  facts: {
    ...typography.body,
    color: colors.textMuted,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  group: {
    gap: spacing.xs,
  },
  groupLabel: {
    ...typography.label,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  // The tabs and the chips of one group both wrap rather than shrink, so a label stays legible at
  // any system font size.
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  // A field's error, painted as `TextField` paints its own: the danger colour is a recorded pair on
  // both the page (6.47:1) and the `surface` a price row sits on (5.83:1).
  fieldError: {
    ...typography.caption,
    color: colors.danger,
    fontWeight: fontWeights.medium,
  },
  // One price row is a group inside the task's card, so its fields stay together.
  priceRow: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: borderWidths.edge,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
});
