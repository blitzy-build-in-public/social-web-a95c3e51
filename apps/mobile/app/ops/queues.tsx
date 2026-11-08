/**
 * Operator queues (`/ops/queues`): the five queues of the operator area over one shared list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
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
  AdminCallTasksQuery,
  AdminCrawlDomainDto,
  AdminDisputeDto,
  AdminLodgingClaimDto,
  AdminReportDto,
  BookingDetailsDto,
  CallTaskKind,
  CrawlDecision,
  CrawlDomainDecisionUpdate,
  LodgingClaimStatus,
  ResolveCallTask,
  ResolveDispute,
  ResolveLodgingClaim,
} from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import { queryClient, queryKeys } from '../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../src/ui';

const SCREEN_TITLE = 'Operator queues';
const SAVED_NOTICE = 'Saved.';
const LOADING_NOTICE = 'Loading…';
const CANCEL_LABEL = 'Cancel';
const CONFIRM_PREFIX = 'Confirm: ';
const OVERDUE_BADGE = 'Overdue';
const DELETED_ACCOUNT_TEXT = 'Deleted account';
const REMOVED_REASON_TEXT = 'Reason text removed';
const NO_CHECK_IN_TEXT = 'No check-in';
const DETAILS_NOTE = 'Access is logged. Use only for the verification call.';
const TAB_ORDER = ['disputes', 'reports', 'call-tasks', 'lodging-claims', 'crawl-domains'] as const;
type QueueTab = (typeof TAB_ORDER)[number];
const QUEUE_TABS: Record<QueueTab, { readonly label: string; readonly testID: string }> = {
  disputes: { label: 'Disputes', testID: 'ops-queue-tab-disputes' },
  reports: { label: 'Reports', testID: 'ops-queue-tab-reports' },
  'call-tasks': { label: 'Call tasks', testID: 'ops-queue-tab-call-tasks' },
  'lodging-claims': { label: 'Lodging claims', testID: 'ops-queue-tab-lodging-claims' },
  'crawl-domains': { label: 'Crawl domains', testID: 'ops-queue-tab-crawl-domains' },
};
const isQueueTab = (value: string | undefined): value is QueueTab =>
  value !== undefined && TAB_ORDER.some((tab) => tab === value);
const LABELS = {
  disputeKind: { venue_unavailable: "Venue couldn't witness", other: 'Other' },
  disputeStatus: { open: 'Open', resolved: 'Resolved' },
  checkInResult: { pass: 'Checked in', fail: 'Check-in failed' },
  callKind: { menu_prices: 'Menu prices', lodging_stay_verification: 'Stay verification' },
  callStatus: {
    queued: 'Queued',
    in_progress: 'Calling',
    completed: 'Completed',
    needs_review: 'Needs review',
    refused: 'Refused',
    do_not_call: 'Do not call',
    unreachable: 'Unreachable',
    cancelled: 'Cancelled',
  },
  blockedReason: {
    not_allowlisted: 'number not on the call allowlist',
    no_phone: 'no phone number',
    do_not_call: 'number asked not to be called',
    invalid_number: 'number is not valid',
    vendor_unavailable: 'calling provider unavailable',
    dispatch_unknown: 'dispatch unconfirmed',
    no_final_status: 'no final call status',
  },
  callOutcome: {
    completed: 'Completed',
    no_answer: 'No answer',
    refused: 'Refused',
    do_not_call: 'Do not call',
    unreachable: 'Unreachable',
    needs_review: 'Needs review',
  },
  claimStatus: {
    pending_call: 'Waiting for a call',
    calling: 'Call in progress',
    verified: 'Verified',
    rejected: 'Rejected',
    unreachable: 'Unreachable',
  },
  crawlDecision: { allowed: 'Allowed', prohibited: 'Prohibited', uncertain: 'Not yet reviewed' },
  crawlReason: {
    awaiting_review: 'Awaiting review',
    blocklist: 'On the blocklist',
  } as Record<string, string>,
  category: {
    main: 'Main',
    starter: 'Starter',
    dessert: 'Dessert',
    drink: 'Drink',
    ticket: 'Ticket',
  },
  ticketType: {
    standard: 'Regular adult admission',
    concession: 'Child, student or senior',
    group: 'Family or group',
  },
};

const MOMENT_PARTS = { year: 'numeric', month: 'short', day: 'numeric' } as const;
const MOMENT_FORMATS: readonly Intl.DateTimeFormatOptions[] = [
  { ...MOMENT_PARTS, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
  { ...MOMENT_PARTS, hour: 'numeric', minute: '2-digit' },
];
function createMomentFormatter(): Intl.DateTimeFormat | null {
  for (const options of MOMENT_FORMATS) {
    try {
      return new Intl.DateTimeFormat(undefined, options);
    } catch {}
  }
  return null;
}
const MOMENT_FORMATTER = createMomentFormatter();
function formatMoment(iso: string): string {
  try {
    return MOMENT_FORMATTER?.format(new Date(iso)) ?? iso;
  } catch {
    return iso;
  }
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
const codeOf = (error: unknown): ClientErrorCode =>
  isApiError(error) ? error.code : 'invalid_response';
const CODE_SENTENCES: readonly (readonly [string, string])[] = [
  ['operator_only', 'Operator access required.'],
  ['invalid_outcome', 'This item can no longer be resolved this way. Refresh the queue.'],
  [
    'details_unavailable',
    'Booking details are no longer available (the claim was resolved or its details were erased).',
  ],
  ['not_found', 'This item no longer exists.'],
  ['claim_not_found', 'This item no longer exists.'],
];
const sentenceFor = (code: ClientErrorCode): string =>
  CODE_SENTENCES.find(([known]) => known === code)?.[1] ?? userMessageFor(code);
const messageFor = (error: unknown): string => sentenceFor(codeOf(error));
interface QueueAction<TValues> {
  readonly run: (values: TValues) => Promise<unknown>;
  readonly keys: readonly (readonly unknown[])[];
  readonly onDone?: () => void;
}
interface QueueActionHandle<TValues> {
  readonly perform: (values: TValues) => void;
  readonly busy: boolean;
  readonly failureMessage: string | null;
}
function useQueueAction<TValues>(action: QueueAction<TValues>): QueueActionHandle<TValues> {
  const [failure, setFailure] = useState<ClientErrorCode | null>(null);
  const mutation = useMutation({
    mutationFn: (values: TValues) => action.run(values),
    onSuccess: () => {
      setFailure(null);
      announce(SAVED_NOTICE);
      for (const key of action.keys) void queryClient.invalidateQueries({ queryKey: key });
      action.onDone?.();
    },
    onError: (error: unknown) => {
      setFailure(codeOf(error));
      announce(messageFor(error));
    },
  });
  const failureMessage = failure === null ? null : sentenceFor(failure);
  return { perform: (values) => mutation.mutate(values), busy: mutation.isPending, failureMessage };
}
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;
type KeyEvent = Readonly<{ key?: string; repeat?: boolean; preventDefault?: () => void }>;
function spaceActivates(activate: () => void): { onKeyDown?: (event: KeyEvent) => void } {
  if (Platform.OS !== 'web') return {};
  const onKeyDown = (event: KeyEvent): void => {
    if (event.repeat === true || (event.key !== ' ' && event.key !== 'Spacebar')) return;
    event.preventDefault?.();
    activate();
  };
  return { onKeyDown };
}

type ConfirmSpec = Readonly<{ hint: string; label: string; variant?: 'primary' | 'secondary' }>;
type ChipProps = { label: string; onSelect: () => void; selected: boolean; testID: string };
function Chip({ label, selected, testID, onSelect }: ChipProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const labelStyle = [styles.controlLabel, selected ? styles.controlLabelSelected : null];
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
      style={controlStyle(selected, focused, false, false)}
    >
      <Text style={labelStyle}>{label}</Text>
    </Pressable>
  );
}
interface ChoiceGroupProps<V extends string> {
  readonly groupLabel: string;
  readonly options: readonly { readonly value: V; readonly label: string }[];
  readonly value: V | null;
  readonly testIDPrefix: string;
  readonly onSelect: (value: V) => void;
}
function ChoiceGroup<V extends string>(props: ChoiceGroupProps<V>): ReactElement {
  const { groupLabel, options, value, testIDPrefix, onSelect } = props;
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
            onSelect={() => onSelect(option.value)}
          />
        ))}
      </View>
    </View>
  );
}
interface BooleanGroupProps {
  readonly groupLabel: string;
  readonly trueLabel: string;
  readonly falseLabel: string;
  readonly value: boolean | null;
  readonly testIDPrefix: string;
  readonly onSelect: (value: boolean) => void;
}
function BooleanGroup(props: BooleanGroupProps): ReactElement {
  const { groupLabel, trueLabel, falseLabel, value, testIDPrefix, onSelect } = props;
  return (
    <ChoiceGroup
      groupLabel={groupLabel}
      options={[
        { value: 'yes', label: trueLabel },
        { value: 'no', label: falseLabel },
      ]}
      value={value === null ? null : value ? 'yes' : 'no'}
      testIDPrefix={testIDPrefix}
      onSelect={(answer) => onSelect(answer === 'yes')}
    />
  );
}
type InlineConfirmProps = ConfirmSpec & { busy: boolean; onConfirm: () => void; testID: string };
function InlineConfirm(props: InlineConfirmProps): ReactElement {
  const { label, variant = 'secondary', hint, busy, testID, onConfirm } = props;
  const [armed, setArmed] = useState(false);
  const idleProps = { label, variant, busy, testID, hint, onPress: () => setArmed(true) };
  if (!armed) {
    return <Button {...idleProps} />;
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
        onPress={() => setArmed(false)}
      />
    </>
  );
}
function Facts({ children }: { readonly children: ReactNode }): ReactElement {
  return <Text style={styles.facts}>{children}</Text>;
}
interface RowViewProps {
  readonly title: string;
  readonly facts: readonly (string | null)[];
  readonly error?: string | null;
  readonly testID?: string;
  readonly children?: ReactNode;
}
function RowView({ title, facts, error = null, testID, children }: RowViewProps): ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{title}</Text>
      {facts.map((fact, index) => (fact === null ? null : <Facts key={index}>{fact}</Facts>))}
      {error !== null && testID !== undefined ? (
        <Banner tone="error" message={error} testID={`${testID}-error`} />
      ) : null}
      {children}
    </View>
  );
}
interface QueueSpec<T> {
  readonly queryKey: readonly unknown[];
  readonly queryFn: () => Promise<{ readonly items: readonly T[] }>;
  readonly keyOf: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  readonly emptyText: string;
  readonly header?: (items: readonly T[]) => ReactNode;
}
function QueuePanel<T>({ spec }: { readonly spec: QueueSpec<T> }): ReactElement {
  const query: UseQueryResult<{ readonly items: readonly T[] }, Error> = useQuery(spec);
  const items = query.data?.items ?? [];
  const errorMessage = query.isError ? messageFor(query.error) : null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (errorMessage !== null && announced.current !== errorMessage) announce(errorMessage);
    announced.current = errorMessage;
  }, [errorMessage]);
  const showLoading = items.length === 0 && errorMessage === null && query.isPending;
  const showEmpty = items.length === 0 && errorMessage === null && !query.isPending;
  const retry = { ...RETRY_ACTION, onPress: () => void query.refetch() };
  return (
    <>
      {spec.header?.(items) ?? null}
      {errorMessage === null ? null : (
        <Banner tone="error" message={errorMessage} testID="ops-queue-error" action={retry} />
      )}
      {showLoading ? <Facts>{LOADING_NOTICE}</Facts> : null}
      {showEmpty ? <Facts>{spec.emptyText}</Facts> : null}
      {items.map((item) => (
        <Card key={spec.keyOf(item)}>{spec.renderItem(item)}</Card>
      ))}
    </>
  );
}

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
type RowFailures = Partial<Record<PriceField, string>>;
function isPriceField(value: unknown): value is PriceField {
  return typeof value === 'string' && value in PRICE_FIELD_MESSAGE;
}
const CATEGORIES = ItemCategory.options.map((value) => ({ value, label: LABELS.category[value] }));
const TICKETS = TicketType.options.map((value) => ({ value, label: LABELS.ticketType[value] }));
interface PriceRowState {
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
/** Chip answers are checked here: Zod skips refinements on already-failed values (AAP 0.5.7). */
function validateRow(row: PriceRowState): { item: PriceItemInput | null; failures: RowFailures } {
  const failures: RowFailures = {};
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
    if (Object.keys(failures).length === 0) failures.name = 'Check this price row.';
  }
  const message = PRICE_FIELD_MESSAGE;
  if (row.name.trim() === '') failures.name ??= message.name;
  if (row.priceText.trim() === '') failures.priceText ??= message.priceText;
  if (row.category === 'drink' && row.alcoholic === null) failures.alcoholic ??= message.alcoholic;
  if (row.category === 'ticket') {
    if (row.perPerson === null) failures.perPerson ??= message.perPerson;
    if (row.ticketType === null) failures.ticketType ??= message.ticketType;
  }
  const valid = Object.keys(failures).length === 0;
  return { item: parsed.success && valid ? parsed.data : null, failures };
}
const QUOTED_AS = { label: 'Price as quoted', hint: 'Verbatim, for example ฿120 or 45K' };
const CURRENCY = { hint: 'Three letters, as the guest pays at the venue', label: 'Currency' };
const CURRENCY_INPUT = { autoCapitalize: 'characters', autoCorrect: false, maxLength: 3 } as const;
const CURRENCY_FIELD = { ...CURRENCY, ...CURRENCY_INPUT } as const;
const AMOUNT = {
  label: 'Amount in minor units',
  hint: 'The smallest unit: 12050 is 120.50',
  inputMode: 'numeric',
  keyboardType: 'number-pad',
} as const;
const PRICE_TEXT_FIELDS = [
  { extra: QUOTED_AS, field: 'priceText', state: 'priceText', suffix: 'price-text' },
  { extra: CURRENCY_FIELD, field: 'currency', state: 'currency', suffix: 'currency' },
  { extra: AMOUNT, field: 'localAmountMinor', state: 'amountText', suffix: 'amount' },
] as const;
const REMOVE_PRICE = { label: 'Remove this price', variant: 'secondary' } as const;
const ADD_PRICE = { label: 'Add another price', variant: 'secondary' } as const;
const SAVE_PRICES = { label: 'Save the prices' } as const;
const CANCEL_PRICE = { label: CANCEL_LABEL, variant: 'secondary' } as const;
const DRINK = { groupLabel: 'Alcoholic', trueLabel: 'Alcoholic', falseLabel: 'Non-alcoholic' };
interface PriceEntryFormProps {
  readonly defaultCurrency: string;
  readonly busy: boolean;
  readonly prefix: string;
  readonly onCancel: () => void;
  readonly onSubmit: (prices: PriceItemInput[]) => void;
}
function PriceEntryForm(props: PriceEntryFormProps): ReactElement {
  const { defaultCurrency, busy, prefix, onCancel, onSubmit } = props;
  const [rows, setRows] = useState(() => [newPriceRow(0, defaultCurrency)]);
  const [failures, setFailures] = useState<Readonly<Record<number, RowFailures>>>({});
  const nextKey = useRef(1);
  const update = (key: number, patch: Partial<PriceRowState>): void => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };
  const addRow = (): void => {
    const key = nextKey.current++;
    setRows((current) => [...current, newPriceRow(key, defaultCurrency)]);
  };
  const removeRow = (key: number): void => {
    if (rows.length > 1) setRows((current) => current.filter((row) => row.key !== key));
    setFailures(({ [key]: _removed, ...rest }) => rest);
  };
  const submit = (): void => {
    const raised: Record<number, RowFailures> = {};
    const prices: PriceItemInput[] = [];
    for (const row of rows) {
      const checked = validateRow(row);
      if (checked.item === null) raised[row.key] = checked.failures;
      else prices.push(checked.item);
    }
    setFailures(raised);
    if (Object.keys(raised).length > 0) announce('Check the highlighted price rows.');
    else onSubmit(prices);
  };
  const full = rows.length >= 20;
  return (
    <>
      <Text style={styles.facts}>
        Enter each price exactly as it was quoted. A price is stored only if it is complete.
      </Text>
      {rows.map((row, index) => {
        const flagged = failures[row.key] ?? {};
        const id = (suffix: string): string => `${prefix}-row-${index}-${suffix}`;
        const set = (patch: Partial<PriceRowState>): void => update(row.key, patch);
        const remove = (): void => removeRow(row.key);
        const single = rows.length === 1;
        return (
          <View key={row.key} style={styles.priceRow}>
            <Text style={styles.groupLabel}>{`Price ${index + 1}`}</Text>
            <TextField
              label="Item name"
              value={row.name}
              onChangeText={(name) => set({ name })}
              error={flagged.name ?? null}
              testID={id('name')}
            />
            <ChoiceGroup
              groupLabel="Category"
              options={CATEGORIES}
              value={row.category}
              testIDPrefix={id('category')}
              onSelect={(category) => set({ category })}
            />
            {PRICE_TEXT_FIELDS.map((field) => (
              <TextField
                key={field.state}
                {...field.extra}
                error={flagged[field.field] ?? null}
                onChangeText={(text) => set({ [field.state]: text })}
                testID={id(field.suffix)}
                value={row[field.state]}
              />
            ))}
            {row.category === 'drink' ? (
              <BooleanGroup
                {...DRINK}
                value={row.alcoholic}
                testIDPrefix={id('alcoholic')}
                onSelect={(alcoholic) => set({ alcoholic })}
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
                  onSelect={(perPerson) => set({ perPerson })}
                />
                <ChoiceGroup
                  groupLabel="Ticket type"
                  options={TICKETS}
                  value={row.ticketType}
                  testIDPrefix={id('ticket-type')}
                  onSelect={(ticketType) => set({ ticketType })}
                />
              </>
            ) : null}
            {(['alcoholic', 'perPerson', 'ticketType'] as const).map((field) =>
              flagged[field] === undefined ? null : (
                <Text key={field} style={styles.fieldError}>{`Error: ${flagged[field]}`}</Text>
              ),
            )}
            <Button {...REMOVE_PRICE} disabled={single} testID={id('remove')} onPress={remove} />
          </View>
        );
      })}
      <View style={styles.actions}>
        <Button {...ADD_PRICE} disabled={full} testID={`${prefix}-add`} onPress={addRow} />
        <Button {...SAVE_PRICES} busy={busy} testID={`${prefix}-submit`} onPress={submit} />
        <Button {...CANCEL_PRICE} disabled={busy} testID={`${prefix}-cancel`} onPress={onCancel} />
      </View>
    </>
  );
}
function crawlBody(decision: Exclude<CrawlDecision, 'uncertain'>): CrawlDomainDecisionUpdate {
  return { decision };
}
const RESOLVABLE_CALL_STATUSES = ['queued', 'in_progress', 'needs_review', 'unreachable'] as const;
const RESOLVABLE_CLAIM_STATUSES: readonly LodgingClaimStatus[] = ['pending_call', 'calling'];
const SETTLE_HINT = `A resolution before the start plus ${CHECK_IN_CLOSES_AFTER_MINUTES} minutes only closes the dispute; the outcome then waits for the check-in window.`;
const RETRY_ACTION = { label: 'Try again', testID: 'ops-queue-retry' };
const SETTLE: ConfirmSpec = { label: 'Settle by check-ins', hint: SETTLE_HINT };
const NO_FAULT: ConfirmSpec = {
  label: 'No fault — release holds',
  hint: 'Releases both card holds, and neither attendee carries a no-show.',
};

function DisputeRow({ dispute }: { readonly dispute: AdminDisputeDto }): ReactElement {
  const action = useQueueAction<ResolveDispute>({
    run: (body) => apiClient.admin.resolveDispute(dispute.id, body),
    keys: [queryKeys.adminDisputes],
  });
  const { busy, perform, failureMessage } = action;
  const testID = `ops-dispute-${dispute.id}`;
  const who = `${dispute.venueName} · ${dispute.cityId}`;
  const headline = `${LABELS.disputeKind[dispute.kind]} · ${LABELS.disputeStatus[dispute.status]}${dispute.overdue ? ` · ${OVERDUE_BADGE}` : ''}`;
  const settle = { ...SETTLE, busy, onConfirm: () => perform({ outcome: 'settle_by_checkins' }) };
  const noFault = { ...NO_FAULT, busy, onConfirm: () => perform({ outcome: 'no_fault' }) };
  const facts = [
    headline,
    dispute.reason ?? REMOVED_REASON_TEXT,
    `Opened ${formatMoment(dispute.openedAt)}`,
    `Resolve by ${formatMoment(dispute.deadlineAt)}`,
    ...dispute.checkIns.map(
      (entry) =>
        `${entry.handle ?? DELETED_ACCOUNT_TEXT}: ${entry.result === null ? NO_CHECK_IN_TEXT : LABELS.checkInResult[entry.result]}`,
    ),
    `Meetup ${dispute.meetupId}`,
  ];
  return (
    <RowView title={who} facts={facts} error={failureMessage} testID={testID}>
      {dispute.status === 'open' ? (
        <View style={styles.actions}>
          <InlineConfirm {...settle} testID={`${testID}-settle`} />
          <InlineConfirm {...noFault} testID={`${testID}-no-fault`} />
        </View>
      ) : null}
    </RowView>
  );
}

const APPROVE_CALL: ConfirmSpec = {
  label: "Approve the call's quoted prices",
  hint: "Stores the prices the call quoted as the operator's own entry.",
};
const REFUSED_CALL: ConfirmSpec = { label: 'Refused', hint: 'The business asked not to continue.' };
const NO_CALL: ConfirmSpec = {
  label: 'Do not call',
  hint: 'Also marks the place do-not-call and cancels its other tasks.',
};
const UNREACHABLE = { label: 'Unreachable', hint: 'You could not obtain the prices either.' };
const RECORD_PRICES = { label: 'Record prices from the call' } as const;
type CallTaskRowProps = { readonly task: AdminCallTaskDto; readonly currency: string };
function CallTaskRow({ task, currency }: CallTaskRowProps): ReactElement {
  const [entryOpen, setEntryOpen] = useState(false);
  const action = useQueueAction<ResolveCallTask>({
    run: (body) => apiClient.admin.resolveCallTask(task.id, body),
    keys: [queryKeys.adminCallTasks],
    onDone: () => setEntryOpen(false),
  });
  const { busy, perform, failureMessage } = action;
  const isMenuTask = task.kind === 'menu_prices';
  const resolvable = RESOLVABLE_CALL_STATUSES.some((status) => status === task.status);
  const extracted = task.extractedFields;
  const testID = `ops-call-task-${task.id}`;
  const attempts = `${task.attempts} ${task.attempts === 1 ? 'attempt' : 'attempts'}`;
  const headline = `${task.cityId} · ${LABELS.callKind[task.kind]} · ${LABELS.callStatus[task.status]} · ${attempts}`;
  const blocked =
    task.blockedReason === null
      ? null
      : `Blocked: ${LABELS.blockedReason[task.blockedReason]}${task.blockedReason === 'dispatch_unknown' ? '. The provider listings are candidates only; confirm before resolving.' : '.'}`;
  const openEntry = (): void => setEntryOpen(true);
  const closeEntry = (): void => setEntryOpen(false);
  const approve = { ...APPROVE_CALL, busy, onConfirm: () => perform({ outcome: 'completed' }) };
  const refuse = { ...REFUSED_CALL, busy, onConfirm: () => perform({ outcome: 'refused' }) };
  const noCall = { ...NO_CALL, busy, onConfirm: () => perform({ outcome: 'do_not_call' }) };
  const unreachable = {
    ...UNREACHABLE,
    busy,
    onConfirm: () => perform({ outcome: 'unreachable' }),
  };
  const facts = [
    headline,
    task.nextAttemptAt === null ? null : `Next attempt ${formatMoment(task.nextAttemptAt)}`,
    blocked,
    task.lastOutcome === null ? null : `Last outcome ${LABELS.callOutcome[task.lastOutcome]}`,
    task.lastSummary,
  ];
  return (
    <RowView title={task.targetName} facts={facts} error={failureMessage} testID={testID}>
      {isMenuTask && extracted !== null ? (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>What the call extracted</Text>
          {Object.entries(extracted).map(([field, value]) => (
            <Facts key={field}>{`${field}: ${value === null ? '—' : String(value)}`}</Facts>
          ))}
        </View>
      ) : null}
      {!isMenuTask ? (
        <Facts>Resolved through its lodging claim.</Facts>
      ) : entryOpen ? (
        <PriceEntryForm
          defaultCurrency={currency}
          busy={busy}
          prefix={`${testID}-prices`}
          onCancel={closeEntry}
          onSubmit={(prices) => perform({ outcome: 'completed', prices: [...prices] })}
        />
      ) : resolvable ? (
        <View style={styles.actions}>
          <Button {...RECORD_PRICES} testID={`${testID}-entry`} onPress={openEntry} />
          {extracted === null ? null : <InlineConfirm {...approve} testID={`${testID}-approve`} />}
          <InlineConfirm {...refuse} testID={`${testID}-refused`} />
          <InlineConfirm {...noCall} testID={`${testID}-do-not-call`} />
          <InlineConfirm {...unreachable} testID={`${testID}-unreachable`} />
        </View>
      ) : null}
    </RowView>
  );
}
const VERIFIED = { label: 'Verified', hint: 'Reception confirmed the guest is staying.' };
const REJECTED = { label: 'Rejected', hint: 'Reception said no such guest is staying.' };
const UNREACHED: ConfirmSpec = {
  label: 'Unreachable',
  hint: 'The lodging could not confirm the stay and the claim has run out of options.',
};
const SHOW_DETAILS = {
  label: 'Show booking details',
  variant: 'secondary',
  hint: 'Reads the booking name and reference for the verification call. The read is logged.',
} as const;
const HIDE_DETAILS = { label: 'Hide booking details', variant: 'secondary' } as const;
function LodgingClaimRow({ claim }: { readonly claim: AdminLodgingClaimDto }): ReactElement {
  const [details, setDetails] = useState<BookingDetailsDto | null>(null);
  const [detailsFailure, setDetailsFailure] = useState<ClientErrorCode | null>(null);
  const [readingDetails, setReadingDetails] = useState(false);
  const detailsInFlight = useRef(false);
  const action = useQueueAction<ResolveLodgingClaim>({
    run: (body) => apiClient.admin.resolveLodgingClaim(claim.id, body),
    keys: [queryKeys.adminLodgingClaims, queryKeys.adminCallTasks],
    onDone: () => {
      setDetails(null);
      setDetailsFailure(null);
    },
  });
  const { busy, perform } = action;
  useFocusEffect(
    useCallback(() => {
      return () => setDetails(null);
    }, []),
  );
  const readDetails = async (): Promise<void> => {
    if (detailsInFlight.current) return;
    detailsInFlight.current = true;
    setReadingDetails(true);
    setDetailsFailure(null);
    try {
      setDetails(await apiClient.admin.getBookingDetails(claim.id));
    } catch (error) {
      const code = codeOf(error);
      setDetailsFailure(code);
      announce(messageFor(error));
      if (code === 'details_unavailable')
        await queryClient.invalidateQueries({ queryKey: queryKeys.adminLodgingClaims });
    } finally {
      detailsInFlight.current = false;
      setReadingDetails(false);
    }
  };
  const testID = `ops-claim-${claim.id}`;
  const failure = detailsFailure === null ? action.failureMessage : sentenceFor(detailsFailure);
  const showDetails = { ...SHOW_DETAILS, busy: readingDetails, onPress: () => void readDetails() };
  const closeDetails = (): void => setDetails(null);
  const hideDetails = { ...HIDE_DETAILS, onPress: closeDetails };
  const verified = { ...VERIFIED, busy, onConfirm: () => perform({ outcome: 'verified' }) };
  const rejected = { ...REJECTED, busy, onConfirm: () => perform({ outcome: 'rejected' }) };
  const unreachable = { ...UNREACHED, busy, onConfirm: () => perform({ outcome: 'unreachable' }) };
  const facts = [
    claim.lodgingPhone === null ? 'No phone number on file' : `Phone ${claim.lodgingPhone}`,
    `${claim.cityId} · ${LABELS.claimStatus[claim.status]}`,
    `Stay ${claim.stayFrom} to ${claim.stayTo}`,
    `Opened ${formatMoment(claim.createdAt)}`,
    `Expires ${formatMoment(claim.expiresAt)} — unresolved claims expire after ${CLAIM_EXPIRY_HOURS} hours without penalty.`,
    claim.detailsAvailable ? 'Booking details available' : 'Booking details erased',
  ];
  return (
    <RowView title={claim.lodgingName} facts={facts} error={failure} testID={testID}>
      {details === null && claim.detailsAvailable ? (
        <Button {...showDetails} testID={`${testID}-details`} />
      ) : null}
      {details === null ? null : (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>Booking details</Text>
          <Text selectable style={styles.rowTitle}>{`${details.bookingName}`}</Text>
          {details.bookingReference === null ? null : (
            <Text selectable style={styles.facts}>{`${details.bookingReference}`}</Text>
          )}
          <Text style={styles.facts}>{DETAILS_NOTE}</Text>
          <Button {...hideDetails} testID={`${testID}-hide-details`} />
        </View>
      )}
      {RESOLVABLE_CLAIM_STATUSES.some((status) => status === claim.status) ? (
        <View style={styles.actions}>
          <InlineConfirm {...verified} testID={`${testID}-verified`} />
          <InlineConfirm {...rejected} testID={`${testID}-rejected`} />
          <InlineConfirm {...unreachable} testID={`${testID}-unreachable`} />
        </View>
      ) : null}
    </RowView>
  );
}

const ALLOW_DOMAIN: ConfirmSpec = {
  label: 'Allow',
  hint: "Allow only after reading the site's terms.",
  variant: 'primary',
};
const PROHIBIT_DOMAIN = { label: 'Prohibit', hint: 'Its places then take the phone fallback.' };

function CrawlDomainRow({ entry }: { readonly entry: AdminCrawlDomainDto }): ReactElement {
  const action = useQueueAction<CrawlDomainDecisionUpdate>({
    run: (body) => apiClient.admin.setCrawlDomainDecision(entry.domain, body),
    keys: [queryKeys.adminCrawlDomains],
  });
  const { busy, perform, failureMessage } = action;
  const blocklisted = entry.reason === 'blocklist';
  const known = entry.reason === 'awaiting_review' || entry.reason === 'blocklist';
  const reason = known
    ? LABELS.crawlReason[entry.reason]
    : `Recorded by an operator: ${entry.reason}`;
  const testID = `ops-crawl-domain-${entry.domain}`;
  const headline = `${LABELS.crawlDecision[entry.decision]} · ${reason} · ${entry.overridden ? 'Operator decision' : 'Automatic'}`;
  const allow = { ...ALLOW_DOMAIN, busy, onConfirm: () => perform(crawlBody('allowed')) };
  const prohibit = { ...PROHIBIT_DOMAIN, busy, onConfirm: () => perform(crawlBody('prohibited')) };
  const facts = [headline, `Checked ${formatMoment(entry.checkedAt)}`];
  return (
    <RowView title={entry.domain} facts={facts} error={failureMessage} testID={testID}>
      {blocklisted ? (
        <Facts>
          On the blocklist: the workers never fetch this domain, whatever is recorded here.
        </Facts>
      ) : null}
      <View style={styles.actions}>
        {entry.decision === 'allowed' ? null : (
          <InlineConfirm {...allow} testID={`${testID}-allow`} />
        )}
        {entry.decision === 'prohibited' ? null : (
          <InlineConfirm {...prohibit} testID={`${testID}-prohibit`} />
        )}
      </View>
    </RowView>
  );
}

const DISPUTES_QUEUE: QueueSpec<AdminDisputeDto> = {
  queryKey: queryKeys.adminDisputes,
  queryFn: () => apiClient.admin.listDisputes(),
  keyOf: (dispute) => dispute.id,
  emptyText: 'No disputes are waiting.',
  renderItem: (dispute) => <DisputeRow dispute={dispute} />,
  header: (items) => {
    const overdue = items.filter((dispute) => dispute.overdue).length;
    const notice = `${overdue} ${overdue === 1 ? 'dispute is' : 'disputes are'} past the ${DISPUTE_RESOLUTION_DAYS}-day resolution deadline.`;
    return overdue === 0 ? null : (
      <Banner tone="warning" message={notice} testID="ops-disputes-overdue" />
    );
  },
};
const REPORTS_QUEUE: QueueSpec<AdminReportDto> = {
  queryKey: queryKeys.adminReports,
  queryFn: () => apiClient.admin.listReports(),
  keyOf: (report) => report.id,
  emptyText: 'No reports are waiting.',
  renderItem: (report: AdminReportDto) => {
    const who = `${report.reporterHandle ?? DELETED_ACCOUNT_TEXT} reported ${report.reportedHandle ?? DELETED_ACCOUNT_TEXT}`;
    const facts = [
      report.reason ?? REMOVED_REASON_TEXT,
      report.meetupId === null ? null : `Meetup ${report.meetupId}`,
      `Reported ${formatMoment(report.createdAt)}`,
    ];
    return <RowView title={who} facts={facts} />;
  },
};

/**
 * The Call tasks tab's own controls and copy (AAP 0.5.4, 0.5.8), with `LABELS` for the chip wording so
 * one status or kind reads the same here as it does on a row.
 */
const CALL_TASKS_EMPTY_TEXT = 'No call tasks are waiting.';
const CALL_TASKS_SEARCH_LABEL = 'Search by name';
const CALL_TASKS_STATUS_LABEL = 'Status';
const CALL_TASKS_KIND_LABEL = 'Kind';
/** The page one read of the queue asks for, inside the contract's own 1 to 500 bound (AAP 0.5.4). */
const CALL_TASKS_PAGE_SIZE = 100;
/** How long typing pauses before the search term is applied, in milliseconds. */
const CALL_TASKS_SEARCH_DEBOUNCE_MS = 300;
const CALL_TASKS_MORE = { label: 'Load more call tasks', variant: 'secondary' } as const;
type CallTaskStatusFilter = 'all' | 'needs_review' | 'unreachable';
type CallTaskKindFilter = 'all' | CallTaskKind;
const CALL_TASKS_STATUS_FILTERS: readonly {
  readonly value: CallTaskStatusFilter;
  readonly label: string;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'needs_review', label: LABELS.callStatus.needs_review },
  { value: 'unreachable', label: LABELS.callStatus.unreachable },
];
const CALL_TASKS_KIND_FILTERS: readonly {
  readonly value: CallTaskKindFilter;
  readonly label: string;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'menu_prices', label: LABELS.callKind.menu_prices },
  { value: 'lodging_stay_verification', label: LABELS.callKind.lodging_stay_verification },
];

/**
 * The queue's query string: only the filters that are actually set, because the route validates the
 * query with a strict schema and answers `400 invalid_field` for a value it cannot read, and because
 * `exactOptionalPropertyTypes` forbids handing it an empty one.
 */
function callTasksQuery(
  status: CallTaskStatusFilter,
  kind: CallTaskKindFilter,
  term: string,
): AdminCallTasksQuery {
  const query: AdminCallTasksQuery = { limit: CALL_TASKS_PAGE_SIZE };

  if (status !== 'all') query.status = status;
  if (kind !== 'all') query.kind = kind;
  if (term !== '') query.q = term;

  return query;
}

/**
 * The Call tasks tab (AAP 0.5.4, 0.5.8): the queue's own filters over one page at a time.
 *
 * The search term is applied from the change handler after a pause in typing, so one search reads one
 * page rather than one per keystroke, and never from an effect. Every filter change moves the read to
 * a new query key — the key stays under the one `queryKeys.adminCallTasks` prefix a resolution
 * invalidates — so a new filter starts a fresh page and drops the pages before it. The count line
 * says how many of the tasks the filters match are on screen, and the control below the rows loads
 * the next page while the answer still carries a cursor. The rows themselves, with their resolve
 * controls, are the ones the other queues render.
 */
function CallTasksPanel(): ReactElement {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [status, setStatus] = useState<CallTaskStatusFilter>('all');
  const [kind, setKind] = useState<CallTaskKindFilter>('all');
  const pendingSearch = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (pendingSearch.current !== null) clearTimeout(pendingSearch.current);
    },
    [],
  );

  const cities = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: 60 * 60 * 1000,
  });
  const currencies = useMemo(
    () => new Map((cities.data?.items ?? []).map((city) => [city.id, city.currency] as const)),
    [cities.data],
  );

  const filters = useMemo(() => callTasksQuery(status, kind, term), [status, kind, term]);
  const queue = useInfiniteQuery({
    queryKey: [...queryKeys.adminCallTasks, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.admin.listCallTasks(
        pageParam === undefined ? filters : { ...filters, cursor: pageParam },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const pages = queue.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.items);
  const total = pages[0]?.total ?? 0;
  const errorMessage = queue.isError ? messageFor(queue.error) : null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (errorMessage !== null && announced.current !== errorMessage) announce(errorMessage);
    announced.current = errorMessage;
  }, [errorMessage]);

  const changeSearch = (text: string): void => {
    setSearch(text);
    if (pendingSearch.current !== null) clearTimeout(pendingSearch.current);
    pendingSearch.current = setTimeout(() => {
      pendingSearch.current = null;
      setTerm(text.trim());
    }, CALL_TASKS_SEARCH_DEBOUNCE_MS);
  };

  const showLoading = rows.length === 0 && errorMessage === null && queue.isPending;
  const showEmpty = rows.length === 0 && errorMessage === null && !queue.isPending;
  const retry = { ...RETRY_ACTION, onPress: () => void queue.refetch() };
  const more = {
    ...CALL_TASKS_MORE,
    busy: queue.isFetchingNextPage,
    onPress: () => void queue.fetchNextPage(),
  };
  // No count when the filters match a single task: it is on screen already, and the line would report
  // one of one.
  const countLine =
    total <= 1 ? null : (
      <Text style={styles.facts} testID="ops-call-tasks-count">
        {`Showing ${formatCount(rows.length)} of ${formatCount(total)} call tasks`}
      </Text>
    );

  return (
    <>
      <TextField
        label={CALL_TASKS_SEARCH_LABEL}
        value={search}
        onChangeText={changeSearch}
        testID="ops-call-tasks-search"
      />
      <ChoiceGroup
        groupLabel={CALL_TASKS_STATUS_LABEL}
        options={CALL_TASKS_STATUS_FILTERS}
        value={status}
        testIDPrefix="ops-call-tasks-status"
        onSelect={setStatus}
      />
      <ChoiceGroup
        groupLabel={CALL_TASKS_KIND_LABEL}
        options={CALL_TASKS_KIND_FILTERS}
        value={kind}
        testIDPrefix="ops-call-tasks-kind"
        onSelect={setKind}
      />
      {countLine}
      {errorMessage === null ? null : (
        <Banner tone="error" message={errorMessage} testID="ops-queue-error" action={retry} />
      )}
      {showLoading ? <Facts>{LOADING_NOTICE}</Facts> : null}
      {showEmpty ? <Facts>{CALL_TASKS_EMPTY_TEXT}</Facts> : null}
      {rows.map((task) => (
        <Card key={task.id}>
          <CallTaskRow task={task} currency={currencies.get(task.cityId) ?? ''} />
        </Card>
      ))}
      {queue.hasNextPage ? <Button {...more} testID="ops-call-tasks-more" /> : null}
    </>
  );
}

const LODGING_CLAIMS_QUEUE: QueueSpec<AdminLodgingClaimDto> = {
  queryKey: queryKeys.adminLodgingClaims,
  queryFn: () => apiClient.admin.listLodgingClaims(),
  keyOf: (claim) => claim.id,
  emptyText: 'No lodging claims are waiting.',
  renderItem: (claim) => <LodgingClaimRow claim={claim} />,
};
const CRAWL_DOMAINS_QUEUE: QueueSpec<AdminCrawlDomainDto> = {
  queryKey: queryKeys.adminCrawlDomains,
  queryFn: () => apiClient.admin.listCrawlDomains(),
  keyOf: (entry) => entry.domain,
  emptyText: 'No domains are waiting for a site-terms decision.',
  renderItem: (entry) => <CrawlDomainRow entry={entry} />,
};
type TabButtonProps = { onSelect: (tab: QueueTab) => void; selected: boolean; tab: QueueTab };
function TabButton({ tab, selected, onSelect }: TabButtonProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const spec = QUEUE_TABS[tab];
  const activate = useCallback(() => onSelect(tab), [onSelect, tab]);
  const labelStyle = [styles.controlLabel, selected ? styles.tabLabelSelected : null];
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
      style={({ pressed }) => controlStyle(selected, focused, hovered, pressed)}
    >
      <Text style={labelStyle}>{spec.label}</Text>
    </Pressable>
  );
}

export default function OpsQueuesScreen(): ReactElement {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<QueueTab>(() =>
    isQueueTab(params.tab) ? params.tab : 'disputes',
  );
  const { label } = QUEUE_TABS[tab];
  const panelID = `ops-queue-panel-${tab}`;
  return (
    <Screen title={SCREEN_TITLE}>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <View role="tablist" aria-label={SCREEN_TITLE} style={styles.choices} testID="ops-queue-tabs">
        {TAB_ORDER.map((id) => (
          <TabButton key={id} tab={id} selected={id === tab} onSelect={setTab} />
        ))}
      </View>
      <View role="tabpanel" aria-label={label} style={styles.panel} testID={panelID}>
        {tab === 'disputes' ? <QueuePanel key={tab} spec={DISPUTES_QUEUE} /> : null}
        {tab === 'reports' ? <QueuePanel key={tab} spec={REPORTS_QUEUE} /> : null}
        {tab === 'call-tasks' ? <CallTasksPanel key={tab} /> : null}
        {tab === 'lodging-claims' ? <QueuePanel key={tab} spec={LODGING_CLAIMS_QUEUE} /> : null}
        {tab === 'crawl-domains' ? <QueuePanel key={tab} spec={CRAWL_DOMAINS_QUEUE} /> : null}
      </View>
    </Screen>
  );
}

function controlStyle(
  selected: boolean,
  focused: boolean,
  hovered: boolean,
  pressed: boolean,
): (ViewStyle | null)[] {
  return [
    styles.control,
    hovered && !selected ? styles.controlHovered : null,
    pressed ? styles.controlPressed : null,
    selected ? styles.controlSelected : null,
    focused ? styles.controlFocused : null,
    webFocusRingReset,
  ];
}
const BORDER = { borderColor: colors.border, borderRadius: radii.md } as const;
const SELECTED_LABEL = { color: colors.primary, fontWeight: fontWeights.bold } as const;

const styles = StyleSheet.create({
  control: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
    borderWidth: borderWidths.control,
    ...BORDER,
    backgroundColor: colors.background,
  },
  controlHovered: { backgroundColor: colors.surface },
  controlPressed: { opacity: interactionOpacity.pressed },
  controlSelected: { borderColor: colors.primary },
  controlFocused: { borderColor: colors.focusRing },
  controlLabel: { ...typography.label, color: colors.text },
  controlLabelSelected: { ...SELECTED_LABEL },
  tabLabelSelected: { ...SELECTED_LABEL, textDecorationLine: 'underline' },
  panel: { gap: spacing.md },
  row: { gap: spacing.sm },
  rowTitle: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  facts: { ...typography.body, color: colors.textMuted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  group: { gap: spacing.xs },
  groupLabel: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fieldError: { ...typography.caption, color: colors.danger, fontWeight: fontWeights.medium },
  priceRow: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: borderWidths.edge,
    ...BORDER,
    backgroundColor: colors.surface,
  },
});
