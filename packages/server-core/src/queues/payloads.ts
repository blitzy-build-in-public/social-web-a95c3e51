import { z } from 'zod';
import { CitySlug, NotificationKind, Uuid, type OutboxKind } from '@tablemate/shared';
import { JOB, QUEUE, outboxJobId, type JobName, type QueueName } from './names.ts';

/** The error every parser in this module throws. */

/**
 * Thrown when a payload or a job's data does not satisfy its schema, or when a consumer asks for a
 * queue and job pair that has no schema at all.
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

function describeIssues(error: z.ZodError | undefined): string {
  if (error === undefined) {
    return 'no schema is registered for this queue and job';
  }
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')} (${issue.code})`)
    .join(', ');
}

type SchemaOutput<S> = S extends { _zod: { output: infer O } } ? O : never;

type OutputsOf<S> = { [K in keyof S]: SchemaOutput<S[K]> };

function parseSchema<T>(target: string, schema: z.ZodType, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new QueuePayloadError(target, result.error);
  }
  return result.data as T;
}

const MAGIC_LINK_KIND: NotificationKind = 'magic_link';

const MAGIC_LINK_FORBIDDEN_IDS = [
  'userId',
  'meetupId',
  'disputeId',
  'lodgingClaimId',
] as const satisfies readonly (keyof NotificationFields)[];

/**
 * Every field a `notification` outbox row may carry, all but `kind` optional because which ids a
 * kind needs is the refinement's business, not the shape's.
 */
export const NotificationOutboxPayloadBase = z.strictObject({
  kind: NotificationKind,
  userId: Uuid.optional(),
  meetupId: Uuid.optional(),
  disputeId: Uuid.optional(),
  lodgingClaimId: Uuid.optional(),
  magicLinkTokenId: Uuid.optional(),
});

type NotificationFields = z.output<typeof NotificationOutboxPayloadBase>;

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
 * claim (AAP 0.3.2, 0.5.3).
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
 * Parses an `OutboxMessage.payload` against the schema of its kind, throwing {@link
 * QueuePayloadError} for a payload that does not match.
 */
export function parseOutboxPayload<
  K extends OutboxKind,
  S extends Record<OutboxKind, z.ZodType> = typeof OUTBOX_PAYLOAD_SCHEMAS,
>(kind: K, json: unknown): SchemaOutput<S[K]> {
  return parseSchema<SchemaOutput<S[K]>>(`outbox:${kind}`, OUTBOX_PAYLOAD_SCHEMAS[kind], json);
}

interface OutboxTarget {
  readonly queue: QueueName;
  readonly job: JobName<QueueName>;
}

function outboxTarget<Q extends QueueName, J extends JobName<Q>>(
  queue: Q,
  job: J,
): { readonly queue: Q; readonly job: J } {
  return { queue, job };
}

/**
 * The queue and job each outbox kind is delivered through (AAP 0.3.2, 0.5.6): a notification to the
 * mailer, a call result to the job that applies it, a call-task request to the dispatcher that
 * dials, and an erasure to the job that deletes the data.
 */
export const OUTBOX_TARGET = {
  notification: outboxTarget(QUEUE.notifications, JOB[QUEUE.notifications].deliver),
  apply_call_result: outboxTarget(QUEUE.callResults, JOB[QUEUE.callResults].apply),
  create_call_task: outboxTarget(QUEUE.callDispatch, JOB[QUEUE.callDispatch].createTask),
  account_erasure: outboxTarget(QUEUE.accountErasure, JOB[QUEUE.accountErasure].erase),
} satisfies Record<OutboxKind, OutboxTarget>;

/** The `OutboxMessage` columns the dispatcher selects and hands to {@link toOutboxJob}. */
export interface OutboxMessageRow {
  /** The row's UUIDv7 primary key, which becomes the job id and `outboxId`. */
  readonly id: string;
  readonly kind: OutboxKind;
  /** The row's `jsonb` payload, unparsed until it reaches {@link toOutboxJob}. */
  readonly payload: unknown;
}

/**
 * What an outbox-sourced job carries: the row id under its own key, plus the row's payload fields.
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

// The single-id schemas the timers, the fan-outs and the call-task request share: a job names the
// row it concerns and nothing else.
const MeetupJobData = z.strictObject({ meetupId: Uuid });
const DisputeJobData = z.strictObject({ disputeId: Uuid });
const CityJobData = z.strictObject({ cityId: CitySlug });
const PlaceJobData = z.strictObject({ placeId: Uuid });
const ClaimJobData = z.strictObject({ claimId: Uuid });

const NoJobData = z.strictObject({});

/** The data of a `notifications` / `deliver` job: the row's payload plus the row id (AAP 0.3.2). */
export const NotificationJobData = NotificationOutboxPayloadBase.extend({
  outboxId: Uuid,
}).superRefine(refineNotificationFields);

/**
 * The data of a `call-results` / `apply` job: the attempt to apply, plus the row id (AAP 0.3.2).
 */
export const ApplyCallResultJobData = ApplyCallResultOutboxPayload.extend({ outboxId: Uuid });

/** The data of a `call-dispatch` / `create-task` job: the claim to open, plus the row id. */
export const CreateCallTaskJobData = CreateCallTaskOutboxPayload.extend({ outboxId: Uuid });

/** The data of an `account-erasure` / `erase` job: the user to erase, plus the row id. */
export const AccountErasureJobData = AccountErasureOutboxPayload.extend({ outboxId: Uuid });

/** The data schema of every queue and job name (AAP 0.5.3, 0.5.6), nested queue then job. */
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

type JobDataSchemaTable = typeof JOB_DATA_SCHEMAS;

/** The parsed data of one job, keyed by queue and then by the job names that queue accepts. */
export type JobDataByQueueAndName = {
  [Q in keyof JobDataSchemaTable]: OutputsOf<JobDataSchemaTable[Q]>;
};

function jobDataSchema(queue: string, job: string): z.ZodType | undefined {
  const byJob: Record<string, z.ZodType> | undefined = JOB_DATA_SCHEMAS[queue as QueueName];
  return byJob?.[job];
}

/**
 * Parses a processor's `job.data` against the schema of its queue and job, throwing {@link
 * QueuePayloadError} naming `<queue>/<job>` when the pair has no schema or the data does not match
 * it (AAP 0.11.1).
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
