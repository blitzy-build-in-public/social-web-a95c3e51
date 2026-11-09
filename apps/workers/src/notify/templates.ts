/**
 * Notification rendering: a notification's kind and the data its job gathered become the push
 * title and body, the plain-text email subject and body, and the app route the message opens
 * (AAP 0.1.1, 0.8.1). Pure -- no database, no clock, no logger, no environment -- so the copy a
 * recipient reads is testable on its own.
 *
 * The copy is data: {@link COPY} holds every mandated sentence of AAP 0.5.8, so it can be read
 * against the specification line by line, and {@link renderNotification} is the one renderer that
 * validates the data, fills the placeholders, appends the framing sentence and lays out the email.
 *
 * Two invariants hold here. A message that concerns a hold is framed in the recipient's own
 * experiment variant (AAP 0.1.1, 0.5.7): the framing sentence is appended verbatim, and data
 * without the variant or the deposit is refused rather than sent unframed. And the data carries
 * ids, a public venue or lodging name, a handle and a start time the job already formatted in city
 * time -- never an email address, real name, booking detail, phone number or coordinate
 * (AAP 0.5.2, 0.11.1).
 */

import {
  CHECK_IN_OPENS_BEFORE_MINUTES,
  DISPUTE_FILING_WINDOW_HOURS,
  DISPUTE_RESOLUTION_DAYS,
  LATE_CANCEL_WINDOW_HOURS,
  LOCK_LOST_COPY,
  MAGIC_LINK_TTL_MINUTES,
  depositCopy,
  formatUsdWhole,
  isDepositLevel,
} from '@tablemate/shared';
import type { DepositCents, NotificationKind, Variant } from '@tablemate/shared';

/**
 * One rendered notification: `title` and `body` feed the push, `emailSubject` and `emailText` the
 * email, and `path` is the app route the message opens.
 */
export type RenderedNotification = {
  title: string;
  body: string;
  emailSubject: string;
  emailText: string;
  path: string;
};

/**
 * The outcome each kind that reports a money result may carry (AAP 0.5.3, 0.5.7), and the sentence
 * it selects. The job derives the outcome from the recipient's own perspective:
 *
 * - `meetup_cancelled` -- `released` (a free cancel, a block or a deletion), `credit_granted` (the
 *   counterpart cancelled inside the late-cancel window and the recipient was credited) or
 *   `deposit_captured` (the recipient is the late canceller).
 * - `meetup_settled` -- `completed`, `unattended`, `credit_granted` (the recipient attended and the
 *   absent party's hold was captured for them) or `deposit_captured` (the absent recipient).
 * - `lock_lost` -- `release` (the recipient's own hold was never captured) or `refund` (a captured
 *   deposit is being reversed by the no-forfeit compensation of AAP 0.3.2).
 * - `dispute_resolved` -- the operator's `settle_by_checkins` or `no_fault` (AAP 0.5.3).
 * - `lodging_claim_resolved` -- the claim's own terminal outcome (AAP 0.5.3).
 */
export const NOTIFICATION_OUTCOMES = {
  meetup_cancelled: ['released', 'credit_granted', 'deposit_captured'],
  meetup_settled: ['completed', 'unattended', 'credit_granted', 'deposit_captured'],
  lock_lost: ['release', 'refund'],
  dispute_resolved: ['settle_by_checkins', 'no_fault'],
  lodging_claim_resolved: ['verified', 'rejected', 'unreachable'],
} as const;

/** One outcome value of any kind. */
export type NotificationOutcome =
  (typeof NOTIFICATION_OUTCOMES)[keyof typeof NOTIFICATION_OUTCOMES][number];
/** The outcomes one kind allows; every kind not listed reports no outcome (AAP 0.5.3). */
const OUTCOMES_BY_KIND: Readonly<
  Partial<Record<NotificationKind, readonly NotificationOutcome[]>>
> = NOTIFICATION_OUTCOMES;

/**
 * Every kind whose message concerns a hold, so rendered in the recipient's framing variant
 * (AAP 0.1.1, 0.5.7). The job loads that recipient's `ExperimentAssignment.variant` and the
 * meetup's `depositCents` before rendering one of these.
 */
export const DEPOSIT_NOTIFICATION_KINDS = [
  'proposal_received',
  'proposal_declined',
  'proposal_lapsed',
  'meetup_locked',
  'meetup_cancelled',
  'meetup_reminder',
  'meetup_settled',
  'lock_lost',
] as const satisfies readonly NotificationKind[];

/**
 * Everything a copy line may read (AAP 0.5.2, 0.11.1). The job formats `startsAtLocal` in the venue
 * city's time zone and passes the recipient's own variant, because the framing copy is the
 * recipient's variable (AAP 0.5.7). A field is absent rather than empty, and nothing personal
 * appears here: no email address, real name, booking name or reference, phone number, message body
 * or coordinate.
 */
export interface NotificationRenderData {
  /** Origin of the web client, used for links; a trailing slash is ignored. */
  webOrigin: string;
  /** The recipient's framing variant; required by every {@link DEPOSIT_NOTIFICATION_KINDS} kind. */
  variant?: Variant;
  /** The meetup's deposit; required by every {@link DEPOSIT_NOTIFICATION_KINDS} kind. */
  depositCents?: DepositCents;
  /** The partner venue's public name. */
  venueName?: string;
  /** The start, already formatted in the venue city's time zone. */
  startsAtLocal?: string;
  /** The counterpart's handle; once they are erased the copy falls back to a generic phrase. */
  counterpartHandle?: string;
  /** The lodging's public name. */
  lodgingName?: string;
  /** The outcome sentence to select, for a kind that reports one. */
  outcome?: NotificationOutcome;
  /** The meetup's id, used only to build the route the message opens. */
  meetupId?: string;
  /** The raw magic-link token; never rendered into a push body. */
  magicLinkToken?: string;
}

/**
 * Thrown when the data cannot produce the message a kind requires: a field is missing or empty, an
 * outcome the kind does not allow, or a deposit notification without its variant or its deposit.
 * The message names the kind and the field, never a value (AAP 0.11.1).
 */
export class NotificationRenderError extends Error {
  readonly kind: NotificationKind;
  readonly field: string;
  constructor(kind: NotificationKind, field: string) {
    super(`Cannot render a ${kind} notification without a valid ${field}`);
    this.name = 'NotificationRenderError';
    this.kind = kind;
    this.field = field;
  }
}

/**
 * What Table Credit is, wherever a grant is announced (AAP 0.5.8): a record with no cash value,
 * because payouts to users or venues are out of scope (AAP 0.7.2).
 */
export const TABLE_CREDIT_NOTE =
  'Table Credit is in USD, redeemable at partner venues, and has no cash value.';
/**
 * The sign-in link the `magic_link` email carries (AAP 0.3.2): the route and query parameter
 * `apps/mobile/app/auth/verify.tsx` parses and the end-to-end mail readers follow.
 */
export function magicLinkUrl(webOrigin: string, token: string): string {
  return `${appOrigin(webOrigin)}/auth/verify?token=${encodeURIComponent(token)}`;
}

/**
 * Renders the notification of `kind` from `data` (AAP 0.1.1, 0.5.8), throwing
 * {@link NotificationRenderError} when the data cannot produce it.
 *
 * The framing sentence, required of every deposit kind, is appended verbatim: as the body's last
 * sentence, and as its own email paragraph after the outcome sentence, which states the actual
 * money result first. Every email but the magic link -- which carries its own link -- then names the
 * route, and all of them the closing line.
 */
export function renderNotification(
  kind: NotificationKind,
  data: NotificationRenderData,
): RenderedNotification {
  const copy: Copy = COPY[kind];
  const framing = framingOf(kind, data);
  const lines = 'outcomes' in copy ? outcomeLead(kind, data, copy.outcomes) : copy.lead;
  const lead = lines.map((line) => fill(kind, data, line)).join(' ');
  const paragraphs = [lead, ...(copy.extra ?? []).map((line) => fill(kind, data, line))];
  if (framing !== undefined) paragraphs.push(framing);
  const path = copy.path ?? meetupPath(data);
  if (kind !== 'magic_link') {
    const origin = appOrigin(need(kind, data, 'webOrigin'));
    paragraphs.push(`Open Tablemate: ${origin}${path}`);
  }
  paragraphs.push(CLOSING_LINE);
  return {
    title: copy.title,
    body: framing === undefined ? lead : `${lead} ${framing}`,
    emailSubject: copy.title,
    emailText: paragraphs.join('\n\n'),
    path,
  };
}

/** The closing line of every email. */
const CLOSING_LINE = "You're receiving this because you have a Tablemate account.";

/** The variants, keyed by the shared enum so one added there fails to compile here (AAP 0.5.7). */
const VARIANTS = { social: true, punitive: true } as const satisfies Record<Variant, true>;

/** A brace-wrapped placeholder; a copy line carrying an unknown one is refused (see {@link fill}). */
const PLACEHOLDER_PATTERN = /\{[a-z]+\}/g;

/** One sentence set per outcome a kind allows. */
type OutcomeSentences = Partial<Record<NotificationOutcome, readonly string[]>>;

/**
 * One kind's copy (AAP 0.5.8): its title, any email-only paragraphs, and the route the message
 * opens. A kind that reports a money result carries one sentence set per outcome instead of a
 * single lead.
 */
type Copy = {
  readonly title: string;
  /** Email-only paragraphs after the lead, such as the magic link itself. */
  readonly extra?: readonly string[];
  /** The route the message opens; the meetup's own screen when a kind does not name one. */
  readonly path?: string;
} & ({ readonly lead: readonly string[] } | { readonly outcomes: OutcomeSentences });

/** The fields a copy line reads as text, and so the ones a missing or empty value is refused for. */
type TextField = 'webOrigin' | 'venueName' | 'startsAtLocal' | 'lodgingName' | 'magicLinkToken';

/** Every placeholder a copy line may carry, and how it is filled from the kind's own data. */
const PLACEHOLDERS: Readonly<
  Record<string, (kind: NotificationKind, data: NotificationRenderData) => string>
> = {
  '{handle}': (_kind, data) => handleOf(data),
  '{venue}': (kind, data) => need(kind, data, 'venueName'),
  '{time}': (kind, data) => need(kind, data, 'startsAtLocal'),
  '{lodging}': (kind, data) => need(kind, data, 'lodgingName'),
  '{amount}': (kind, data) => formatUsdWhole(needDeposit(kind, data)),
  '{link}': (kind, data) =>
    magicLinkUrl(need(kind, data, 'webOrigin'), need(kind, data, 'magicLinkToken')),
};

/** A required text field's value, or a refusal naming it; an empty string counts as absent. */
function need(kind: NotificationKind, data: NotificationRenderData, field: TextField): string {
  const value = data[field];
  if (value === undefined || value === '') {
    throw new NotificationRenderError(kind, field);
  }
  return value;
}

/** Fills one copy line, refusing an unknown placeholder rather than printing braces in a message. */
function fill(kind: NotificationKind, data: NotificationRenderData, line: string): string {
  return line.replace(PLACEHOLDER_PATTERN, (placeholder) => {
    const value = PLACEHOLDERS[placeholder];
    if (value === undefined) {
      throw new NotificationRenderError(kind, placeholder);
    }
    return value(kind, data);
  });
}

/** The sentences for the outcome the data carries, refused unless its kind allows that outcome. */
function outcomeLead(
  kind: NotificationKind,
  data: NotificationRenderData,
  sentences: OutcomeSentences,
): readonly string[] {
  const outcome = data.outcome;
  const allowed = OUTCOMES_BY_KIND[kind];
  if (outcome === undefined || allowed === undefined || !allowed.includes(outcome)) {
    throw new NotificationRenderError(kind, 'outcome');
  }
  const lead = sentences[outcome];
  if (lead === undefined) {
    throw new NotificationRenderError(kind, 'outcome');
  }
  return lead;
}

/** The framing sentence every deposit notification appends, or undefined for a kind with no hold. */
function framingOf(kind: NotificationKind, data: NotificationRenderData): string | undefined {
  if (!DEPOSIT_NOTIFICATION_KINDS.some((deposit) => deposit === kind)) return undefined;
  return depositCopy(needVariant(kind, data), needDeposit(kind, data));
}

/** The recipient's own variant, or a refusal: deposit copy is never sent unframed (AAP 0.5.7). */
function needVariant(kind: NotificationKind, data: NotificationRenderData): Variant {
  const variant = data.variant;
  if (variant === undefined || !Object.hasOwn(VARIANTS, variant)) {
    throw new NotificationRenderError(kind, 'variant');
  }
  return variant;
}

/** The meetup's deposit, or a refusal: the framing sentence prints the amount (AAP 0.5.7). */
function needDeposit(kind: NotificationKind, data: NotificationRenderData): DepositCents {
  const cents: number | undefined = data.depositCents;
  if (cents === undefined || !isDepositLevel(cents)) {
    throw new NotificationRenderError(kind, 'depositCents');
  }
  return cents;
}

/** The counterpart's handle, or a generic phrase once they have been erased (AAP 0.5.2). */
function handleOf(data: NotificationRenderData): string {
  const handle = data.counterpartHandle;
  return handle === undefined || handle === '' ? 'the other traveler' : handle;
}

/** The meetup route a notification opens, or the meetup list when no id was carried (AAP 0.5.8). */
function meetupPath(data: NotificationRenderData): string {
  const id = data.meetupId;
  return id === undefined || id === '' ? '/meetups' : `/meetups/${id}`;
}

/** An origin without trailing slashes, so one trailing slash never doubles in a link. */
function appOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * The copy of every kind (AAP 0.5.8), exhaustive by construction: a kind added to
 * `NotificationKind` fails to compile until its copy is written here.
 */
const COPY = {
  magic_link: {
    title: 'Your Tablemate sign-in link',
    lead: ['Sign in to Tablemate with the link below.'],
    extra: [
      '{link}',
      `This link is valid for ${MAGIC_LINK_TTL_MINUTES} minutes and works once.`,
      "If you didn't ask to sign in, you can ignore this email.",
    ],
    path: '/auth/verify',
  },
  proposal_received: {
    title: 'New meetup proposal',
    lead: ['{handle} proposed meeting at {venue} on {time}.'],
  },
  proposal_declined: {
    title: 'Your proposal was declined',
    lead: ['{handle} declined your meetup at {venue}. Your hold is being released.'],
  },
  proposal_lapsed: {
    title: 'Your proposal expired',
    lead: [
      'Your proposal for {venue} expired before it was accepted. Your hold is being released.',
    ],
  },
  meetup_locked: {
    title: 'Meetup locked',
    lead: ['You and {handle} both held a seat at {venue} on {time}. You can chat now.'],
  },
  meetup_cancelled: {
    title: 'Meetup cancelled',
    outcomes: {
      released: ['Your meetup at {venue} was cancelled. Any hold on your card is being released.'],
      credit_granted: [
        `{handle} cancelled less than ${LATE_CANCEL_WINDOW_HOURS} hours before the start. You received {amount} in Table Credit.`,
        TABLE_CREDIT_NOTE,
      ],
      deposit_captured: [
        `You cancelled less than ${LATE_CANCEL_WINDOW_HOURS} hours before the start, so your {amount} deposit was charged.`,
      ],
    },
  },
  meetup_reminder: {
    title: 'Meetup starts soon',
    lead: [
      `Your meetup with {handle} at {venue} starts at {time}. Check in with the venue's code from ${CHECK_IN_OPENS_BEFORE_MINUTES} minutes before the start.`,
    ],
  },
  counterpart_checked_in: {
    title: 'Your meetup partner checked in',
    lead: ['{handle} checked in at {venue}.'],
  },
  meetup_settled: {
    title: 'Meetup settled',
    outcomes: {
      completed: ['You both showed up at {venue}. Your hold is being released.'],
      unattended: ['Neither of you checked in at {venue}. Your hold is being released.'],
      credit_granted: [
        "{handle} didn't check in at {venue}. You received {amount} in Table Credit.",
        TABLE_CREDIT_NOTE,
      ],
      deposit_captured: [
        `You didn't check in at {venue}, so your {amount} deposit was charged. If something went wrong, report a problem within ${DISPUTE_FILING_WINDOW_HOURS} hours of the start.`,
      ],
    },
  },
  lock_lost: {
    title: 'A card hold ended',
    // The outcome names the money movement (`release`/`refund`) while LOCK_LOST_COPY names its own
    // sentences (`released`/`refunded`), so the two spellings meet here (AAP 0.5.8, 0.3.2).
    outcomes: {
      release: [LOCK_LOST_COPY.released],
      refund: [LOCK_LOST_COPY.refunded],
    },
  },
  dispute_opened: {
    title: 'A problem was reported',
    lead: [
      `A problem was reported for your meetup at {venue}. An operator will review it within ${DISPUTE_RESOLUTION_DAYS} days.`,
    ],
  },
  dispute_resolved: {
    title: 'Your dispute was resolved',
    outcomes: {
      settle_by_checkins: [
        'The reported problem for your meetup at {venue} was reviewed. The outcome follows your check-ins.',
      ],
      no_fault: [
        'The reported problem for your meetup at {venue} was resolved with no fault, so no deposit applies. Any hold or charge is being released or refunded.',
      ],
    },
  },
  lodging_claim_resolved: {
    title: 'Your stay verification',
    outcomes: {
      verified: [
        'Your stay at {lodging} is verified. You choose whether verified travelers can see it in Profile → My stay.',
      ],
      rejected: ["We couldn't confirm your stay at {lodging}."],
      unreachable: ["We couldn't reach {lodging} to confirm your stay. No penalty applies."],
    },
    path: '/profile/stay',
  },
} satisfies Record<NotificationKind, Copy>;
