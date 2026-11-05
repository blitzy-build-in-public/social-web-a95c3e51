/**
 * Outbox payloads and job-data schemas — the one place a payload that crosses a process boundary is
 * written down (AAP 0.3.2, 0.5.2, 0.5.6).
 *
 * Two tables cover everything that arrives at a BullMQ processor:
 *   - `OUTBOX_PAYLOAD_SCHEMAS`, the `OutboxMessage.payload` of every `OutboxKind`. An outbox row
 *     carries ids only — no email address, name, booking field, coordinate, message body or phone
 *     number — because the notification job decrypts what it needs from the row it references, and
 *     because the outbox row is written in the same transaction as the domain change it describes
 *     (AAP 0.3.2, 0.5.2).
 *   - `JOB_DATA_SCHEMAS`, the data of every queue and job name declared in `names.ts`. Job data is
 *     stored in Redis, which is the same reason it carries ids only.
 *
 * Every payload is parsed at the boundary through `parseOutboxPayload` or `parseJobData`: the API
 * parses before it inserts a row (`apps/api/src/modules/outbox/write.ts`), and a processor parses
 * before it reads `job.data`, so no `any` reaches the code behind the boundary (AAP 0.11.1).
 *
 * Nothing here imports `@tablemate/db` or `bullmq`: the schemas are read by the API, the workers,
 * their tests and the seed, and none of them has to open a connection to do it.
 */

import { z } from 'zod';
import { CitySlug, NotificationKind, Uuid, type OutboxKind } from '@tablemate/shared';
import { JOB, QUEUE, outboxJobId, type JobName, type QueueName } from './names.ts';

/*
 * The error every parser in this module throws.
 */

/**
 * Thrown when a payload or a job's data does not satisfy its schema, or when a consumer asks for a
 * queue and job pair that has no schema at all.
 *
 * The message names the target and, for each failing issue, its path and its code — never the value
 * that failed, because a payload's values are ids at most and a log line is not the place for them
 * (AAP 0.11.1 redaction). The underlying `ZodError` is the `cause`, so a test can assert on the
 * issues and a caller need not parse the message.
 */
export class QueuePayloadError extends Error {
  /** The schema the payload was parsed against: `outbox:notification` or `settlement/settle`. */
  readonly target: string;

  constructor(target: string, cause?: z.ZodError) {
    super(
      `Invalid payload for ${target}: ${describeIssues(cause)}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'QueuePayloadError';
    this.target = target;
  }
}

/**
 * Summarises a `ZodError` as paths and codes. Empty when `error` is absent, which is the
 * unknown-queue-or-job case rather than a schema failure.
 */
function describeIssues(error: z.ZodError | undefined): string {
  if (error === undefined) {
    return 'no schema is registered for this queue and job';
  }

  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')} (${issue.code})`)
    .join(', ');
}

/**
 * The output type of a schema, read from zod's own internals.
 *
 * `z.output` is a conditional over the schema type, and TypeScript cannot resolve one through an
 * indexed access that is still generic — it falls to the conditional's `unknown` branch. Reading the
 * output through this alias instead keeps it deferred until the outbox kind, queue or job is known,
 * which is what lets `parseOutboxPayload` and `parseJobData` return the type of the schema they
 * looked up rather than a union of every schema in the table.
 */
type SchemaOutput<S> = S extends { _zod: { output: infer O } } ? O : never;

/** The output type of every schema in a table keyed by outbox kind, queue or job name. */
type OutputsOf<S> = { [K in keyof S]: SchemaOutput<S[K]> };

/**
 * Parses `data` against `schema` and returns it as `T`, the output type of the table entry the
 * caller looked the schema up in. The one parse of this module, and the one cast: zod's `safeParse`
 * is typed through its `this`, which a schema held as a plain `z.ZodType` defers to `unknown`, while
 * the value it returns is that schema's own output by construction.
 */
function parseSchema<T>(target: string, schema: z.ZodType, data: unknown): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    throw new QueuePayloadError(target, result.error);
  }

  return result.data as T;
}

/*
 * Outbox payloads, one per `OutboxMessage.kind` (AAP 0.3.2, 0.5.2).
 */

/** The one `NotificationKind` that carries a token instead of a user (AAP 0.3.2). */
const MAGIC_LINK_KIND: NotificationKind = 'magic_link';

/** The id fields a magic-link notification must not carry: the account may not exist yet. */
const MAGIC_LINK_FORBIDDEN_IDS = [
  'userId',
  'meetupId',
  'disputeId',
  'lodgingClaimId',
] as const satisfies readonly (keyof NotificationFields)[];

/**
 * Every field a `notification` outbox row may carry, all but `kind` optional because which ids a
 * kind needs is the refinement's business, not the shape's.
 *
 * Kept free of refinements: the notification job data is built by extending this shape and then
 * applying {@link refineNotificationFields} itself, so the rule is written once and `extend` only
 * ever receives a plain shape.
 */
export const NotificationOutboxPayloadBase = z.strictObject({
  kind: NotificationKind,
  userId: Uuid.optional(),
  meetupId: Uuid.optional(),
  disputeId: Uuid.optional(),
  lodgingClaimId: Uuid.optional(),
  magicLinkTokenId: Uuid.optional(),
});

/** The fields {@link NotificationOutboxPayloadBase} parses to. */
type NotificationFields = z.output<typeof NotificationOutboxPayloadBase>;

/**
 * What each kind of notification row must carry (AAP 0.3.2).
 *
 * A `magic_link` row carries the `MagicLinkToken` id and no other id: the token is what the worker
 * needs, and the account it will sign in may not exist yet. Every other kind carries the
 * recipient's `userId` and never a token id.
 *
 * Written once and applied both to the stored payload and to the job data built from it, because
 * the job repeats the payload and a rule stated twice could drift.
 */
function refineNotificationFields(value: NotificationFields, ctx: z.RefinementCtx): void {
  if (value.kind === MAGIC_LINK_KIND) {
    if (value.magicLinkTokenId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A magic-link notification carries magicLinkTokenId.',
        path: ['magicLinkTokenId'],
      });
    }

    for (const key of MAGIC_LINK_FORBIDDEN_IDS) {
      if (value[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `A magic-link notification carries no ${key}.`,
          path: [key],
        });
      }
    }

    return;
  }

  if (value.userId === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `${value.kind} carries the recipient's userId.`,
      path: ['userId'],
    });
  }

  if (value.magicLinkTokenId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'magicLinkTokenId belongs to a magic-link notification only.',
      path: ['magicLinkTokenId'],
    });
  }
}

/** The `payload` of a `notification` outbox row, delivered by the `notifications` queue. */
export const NotificationOutboxPayload =
  NotificationOutboxPayloadBase.superRefine(refineNotificationFields);

/**
 * The `payload` of an `apply_call_result` row: the attempt whose outcome the relay recorded on the
 * `CallAttempt`, which `call-results` then applies to its task and, for a lodging call, to its
 * claim (AAP 0.3.2, 0.5.3). The attempt id, never the result itself — the row it points at holds it.
 */
export const ApplyCallResultOutboxPayload = z.strictObject({ callAttemptId: Uuid });

/**
 * The `payload` of a `create_call_task` row: the lodging claim whose `lodging_stay_verification`
 * task `workers` creates, because the API owns the claim and the worker owns the call (AAP 0.3.2).
 */
export const CreateCallTaskOutboxPayload = z.strictObject({ lodgingClaimId: Uuid });

/**
 * The `payload` of an `account_erasure` row: the user whose data the erasure job deletes, written
 * by `DELETE /me` in the transaction that revokes the sessions (AAP 0.5.2, 0.5.3).
 */
export const AccountErasureOutboxPayload = z.strictObject({ userId: Uuid });

/**
 * The payload schema of every `OutboxMessage.kind` (AAP 0.3.2), keyed by the kind itself: a kind
 * added to the enum fails to compile until its schema is written here.
 */
export const OUTBOX_PAYLOAD_SCHEMAS = {
  notification: NotificationOutboxPayload,
  apply_call_result: ApplyCallResultOutboxPayload,
  create_call_task: CreateCallTaskOutboxPayload,
  account_erasure: AccountErasureOutboxPayload,
} satisfies Record<OutboxKind, z.ZodType>;

/** The parsed payload of one outbox kind. */
export type OutboxPayloadByKind = OutputsOf<typeof OUTBOX_PAYLOAD_SCHEMAS>;

/**
 * Parses an `OutboxMessage.payload` against the schema of its kind, throwing
 * {@link QueuePayloadError} for a payload that does not match.
 *
 * `apps/api/src/modules/outbox/write.ts` calls this inside the domain transaction, before the
 * insert, so a malformed outbox row can never be committed and a consumer never has to decide what
 * to do with one.
 *
 * The schema table is a type parameter with the real table as its default, so a caller writes
 * `parseOutboxPayload(kind, payload)` and still gets that kind's own payload type back; nothing ever
 * passes it explicitly.
 */
export function parseOutboxPayload<
  K extends OutboxKind,
  S extends Record<OutboxKind, z.ZodType> = typeof OUTBOX_PAYLOAD_SCHEMAS,
>(kind: K, json: unknown): SchemaOutput<S[K]> {
  return parseSchema<SchemaOutput<S[K]>>(`outbox:${kind}`, OUTBOX_PAYLOAD_SCHEMAS[kind], json);
}

/*
 * Outbox routing (AAP 0.3.2, 0.5.6).
 */

/** A queue and one of the job names that queue accepts. */
interface OutboxTarget {
  readonly queue: QueueName;
  readonly job: JobName<QueueName>;
}

/**
 * Pairs a queue with one of its own job names, so a target naming a job its queue does not accept
 * fails to compile here rather than being ignored by every worker of that queue.
 */
function outboxTarget<Q extends QueueName, J extends JobName<Q>>(
  queue: Q,
  job: J,
): { readonly queue: Q; readonly job: J } {
  return { queue, job };
}

/**
 * The queue and job each outbox kind is delivered through (AAP 0.3.2, 0.5.6): a notification goes
 * to the mailer and push sender, a call result to the job that applies it to its task, a call-task
 * request to the dispatcher that dials, and an erasure to the job that deletes the data.
 *
 * The table is exhaustive by construction: a kind without a target fails to compile, so no row can
 * be committed with nowhere to go.
 */
export const OUTBOX_TARGET = {
  notification: outboxTarget(QUEUE.notifications, JOB[QUEUE.notifications].deliver),
  apply_call_result: outboxTarget(QUEUE.callResults, JOB[QUEUE.callResults].apply),
  create_call_task: outboxTarget(QUEUE.callDispatch, JOB[QUEUE.callDispatch].createTask),
  account_erasure: outboxTarget(QUEUE.accountErasure, JOB[QUEUE.accountErasure].erase),
} satisfies Record<OutboxKind, OutboxTarget>;

/**
 * The `OutboxMessage` columns the dispatcher selects and hands to {@link toOutboxJob}.
 */
export interface OutboxMessageRow {
  /** The row's UUIDv7 primary key, which becomes the job id and `outboxId`. */
  readonly id: string;
  readonly kind: OutboxKind;
  /** The row's `jsonb` payload, unparsed until it reaches {@link toOutboxJob}. */
  readonly payload: unknown;
}

/**
 * What an outbox-sourced job carries: the row id under its own key, plus the row's payload fields.
 *
 * The id is what makes a consumer idempotent (AAP 0.3.2): a job is dispatched once per row, but a
 * row whose `outbox-<id>` job completed and was later trimmed by `removeOnComplete` is dispatched
 * again, and a consumer that has already applied the row must do nothing the second time.
 */
export type OutboxJobData = {
  [K in OutboxKind]: { readonly outboxId: Uuid } & OutboxPayloadByKind[K];
}[OutboxKind];

/** One dispatchable outbox row, as {@link toOutboxJob} resolves it. */
export interface OutboxJob {
  readonly queue: QueueName;
  readonly name: JobName<QueueName>;
  readonly data: OutboxJobData;
  /** `outbox-<id>` (see `names.ts`), which suppresses a duplicate enqueue of the same row. */
  readonly jobId: string;
}

/**
 * Maps one undispatched `OutboxMessage` to the job that carries it (AAP 0.3.2), parsing its payload
 * on the way so an invalid row throws instead of being published.
 *
 * This is the only producer-side mapping: `apps/api/src/modules/outbox/dispatcher.ts` calls it and
 * adds the result with `jobOptionsFor(queue, { jobId })`, so the target of a kind and the job id
 * scheme are decided in one place.
 */
export function toOutboxJob(row: OutboxMessageRow): OutboxJob {
  const target = OUTBOX_TARGET[row.kind];

  return {
    queue: target.queue,
    name: target.job,
    data: { outboxId: row.id, ...parseOutboxPayload(row.kind, row.payload) },
    jobId: outboxJobId(row.id),
  };
}

/*
 * Job data, one schema per queue and job name (AAP 0.5.3 timers, 0.5.6 job table).
 */

// The single-id schemas the timers, the fan-outs and the call-task request share: a job names the
// row it concerns and nothing else.
const MeetupJobData = z.strictObject({ meetupId: Uuid });
const DisputeJobData = z.strictObject({ disputeId: Uuid });
const CityJobData = z.strictObject({ cityId: CitySlug });
const PlaceJobData = z.strictObject({ placeId: Uuid });
const ClaimJobData = z.strictObject({ claimId: Uuid });

/** A job a scheduler template adds with no data of its own: `data: {}` is the whole payload. */
const NoJobData = z.strictObject({});

/** The data of a `notifications` / `deliver` job: the row's payload plus the row id (AAP 0.3.2). */
export const NotificationJobData = NotificationOutboxPayloadBase.extend({
  outboxId: Uuid,
}).superRefine(refineNotificationFields);

/** The data of a `call-results` / `apply` job: the attempt to apply, plus the row id (AAP 0.3.2). */
export const ApplyCallResultJobData = ApplyCallResultOutboxPayload.extend({ outboxId: Uuid });

/** The data of a `call-dispatch` / `create-task` job: the claim to open, plus the row id. */
export const CreateCallTaskJobData = CreateCallTaskOutboxPayload.extend({ outboxId: Uuid });

/** The data of an `account-erasure` / `erase` job: the user to erase, plus the row id. */
export const AccountErasureJobData = AccountErasureOutboxPayload.extend({ outboxId: Uuid });

/**
 * The data schema of every queue and job name (AAP 0.5.3, 0.5.6), nested queue then job.
 *
 * The `satisfies` makes it exhaustive in both directions: a queue or job name added to `names.ts`
 * fails to compile until its data is described here, and a name not in `names.ts` is refused.
 * Timers carry the id their job id was built from, a city job carries the slug whose local time the
 * worker schedules in, and the expiry jobs carry their own step so the data always matches the job
 * it arrived as.
 */
export const JOB_DATA_SCHEMAS = {
  [QUEUE.settlement]: {
    [JOB[QUEUE.settlement].settle]: MeetupJobData,
    [JOB[QUEUE.settlement].lapse]: MeetupJobData,
    [JOB[QUEUE.settlement].remind]: MeetupJobData,
    [JOB[QUEUE.settlement].disputeEscalate]: DisputeJobData,
  },
  [QUEUE.notifications]: {
    [JOB[QUEUE.notifications].deliver]: NotificationJobData,
  },
  [QUEUE.placeRefresh]: {
    [JOB[QUEUE.placeRefresh].refresh]: CityJobData,
  },
  [QUEUE.menuIngest]: {
    [JOB[QUEUE.menuIngest].ingest]: PlaceJobData,
    [JOB[QUEUE.menuIngest].ingestCity]: CityJobData,
  },
  [QUEUE.priceFreshness]: {
    [JOB[QUEUE.priceFreshness].check]: CityJobData,
  },
  [QUEUE.fxRefresh]: {
    [JOB[QUEUE.fxRefresh].refresh]: NoJobData,
  },
  [QUEUE.callDispatch]: {
    [JOB[QUEUE.callDispatch].dispatchCity]: CityJobData,
    [JOB[QUEUE.callDispatch].createTask]: CreateCallTaskJobData,
  },
  [QUEUE.callResults]: {
    [JOB[QUEUE.callResults].apply]: ApplyCallResultJobData,
  },
  [QUEUE.lodgingClaims]: {
    [JOB[QUEUE.lodgingClaims].claimExpire]: ClaimJobData,
    [JOB[QUEUE.lodgingClaims].stayExpiry]: CityJobData,
  },
  [QUEUE.dataExpiry]: {
    [JOB[QUEUE.dataExpiry].hourly]: z.strictObject({ step: z.literal('hourly') }),
    [JOB[QUEUE.dataExpiry].daily]: z.strictObject({ step: z.literal('daily') }),
  },
  [QUEUE.accountErasure]: {
    [JOB[QUEUE.accountErasure].erase]: AccountErasureJobData,
    [JOB[QUEUE.accountErasure].sweep]: NoJobData,
  },
} satisfies { [Q in QueueName]: Record<JobName<Q>, z.ZodType> };

/** The literal type of the table above, so the derived map below is keyed by the table's own keys. */
type JobDataSchemaTable = typeof JOB_DATA_SCHEMAS;

/** The parsed data of one job, keyed by queue and then by the job names that queue accepts. */
export type JobDataByQueueAndName = {
  [Q in keyof JobDataSchemaTable]: OutputsOf<JobDataSchemaTable[Q]>;
};

/**
 * The schema of one queue and job pair, or `undefined` when no such pair exists.
 *
 * The lookup is deliberately untyped: a processor is handed a `job.name` that BullMQ types as a
 * plain string, and the miss has to become a {@link QueuePayloadError} rather than a `job.data`
 * read without a schema.
 */
function jobDataSchema(queue: string, job: string): z.ZodType | undefined {
  const byJob: Record<string, z.ZodType> | undefined = JOB_DATA_SCHEMAS[queue as QueueName];

  return byJob?.[job];
}

/**
 * Parses a processor's `job.data` against the schema of its queue and job, throwing
 * {@link QueuePayloadError} naming `<queue>/<job>` when the pair has no schema or the data does not
 * match it (AAP 0.11.1).
 *
 * A processor narrows `job.name` with `isJobName` from `names.ts` before calling this, which is why
 * an unknown pair is an ordinary unknown-key failure here.
 *
 * The schema table is a type parameter with the real table as its default, and the queue and job
 * keys are constrained by that table rather than by `JobName`: TypeScript computes `keyof` of a
 * generic indexed access over a union of queues as `never`, so constraining the job name that way
 * would make every call unreachable. Callers write the same call either way — `parseJobData(queue,
 * job, data)` — and get that job's own data type back.
 */
export function parseJobData<
  S extends Record<string, Record<string, z.ZodType>> = JobDataSchemaTable,
  Q extends keyof S = keyof S,
  J extends keyof S[Q] = keyof S[Q],
>(queue: Q, job: J, data: unknown): SchemaOutput<S[Q][J]> {
  const target = `${String(queue)}/${String(job)}`;
  const schema = jobDataSchema(String(queue), String(job));

  if (schema === undefined) {
    throw new QueuePayloadError(target);
  }

  return parseSchema<SchemaOutput<S[Q][J]>>(target, schema, data);
}
