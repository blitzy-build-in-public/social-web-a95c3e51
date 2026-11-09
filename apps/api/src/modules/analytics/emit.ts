/**
 * Pseudonymous analytics recording, written inside the domain transaction that causes its event.
 *
 * Every call takes the `tx` of the transaction that performs the transition it describes, so the `AnalyticsEvent` row and the
 * state change commit together and a rolled-back transition leaves none. Nothing here opens a transaction, touches Redis or
 * calls an external service.
 *
 * An `AnalyticsEvent` has no foreign key to `User`: `actorHash` is an HMAC-SHA256 of the actor's id under `ANALYTICS_SALT`,
 * pseudonymous rather than anonymous, and `account-erasure` strips it and the ids later. A funnel event also carries its
 * actor's stored `ExperimentAssignment` in the `variant` and `assignmentId` columns and in `props`, which is what criterion 7
 * checks.
 */
import type { DbTx, Prisma } from '@tablemate/db';
import { actorHash } from '@tablemate/server-core';
import { AnalyticsEventName, AnalyticsProps } from '@tablemate/shared';
import type { Variant } from '@tablemate/shared';

import type { AppServices } from '../../app.ts';

/**
 * The six deposit-funnel stages, in order, each written by the transaction that sets the meetup timestamp it counts. The stage
 * counts come from those timestamps; these names carry the stage's variant attribution and are the set the experiment-integrity
 * check reads.
 */
export const FUNNEL_EVENTS = [
  'proposal_sent',
  'proposal_viewed',
  'proposal_accepted',
  'deposit_locked',
  'meetup_locked',
  'both_checked_in',
] as const satisfies readonly AnalyticsEventName[];

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

const FUNNEL_EVENT_SET: ReadonlySet<string> = new Set<string>(FUNNEL_EVENTS);

/** True when `name` is one of the six deposit-funnel stages, the condition for reading the actor's stored experiment
 * assignment. */
export function isFunnelEvent(name: AnalyticsEventName): name is FunnelEvent {
  return FUNNEL_EVENT_SET.has(name);
}

/**
 * The services an emit call needs: the validated configuration (for `ANALYTICS_SALT`), the injected clock and the process
 * logger. Narrow on purpose, so a test wires these three fields alone.
 */
export type AnalyticsServices = Pick<AppServices, 'env' | 'clock' | 'logger'>;

/**
 * The optional columns of an event. Under `exactOptionalPropertyTypes` an absent field is omitted, never passed as
 * `undefined`; `props` holds ids, enums and measures only, never a personal field and never a raw user id.
 */
export interface EmitFields {
  cityId?: string;
  meetupId?: string;
  /** The measure payload, checked against the shared strict `AnalyticsProps` schema. */
  props?: AnalyticsProps;
}

export interface EmitInput {
  name: AnalyticsEventName;
  /** The acting user, or `null` for an event with no actor. */
  actorUserId: string | null;
  /** The optional columns; omit the field rather than passing `undefined`. */
  fields?: EmitFields;
}

/**
 * Record one event inside the transaction that causes it.
 *
 * The name is validated against {@link AnalyticsEventName} and the props against the shared strict {@link AnalyticsProps}, so a
 * widened name or an unknown props key throws and rolls the transaction back instead of reaching the table. The actor's raw id
 * reaches no column and no prop — only its HMAC under `ANALYTICS_SALT` does. For a funnel event the actor's stored, immutable
 * assignment supplies the `variant`/`assignmentId` columns and props and overrides whatever the caller passed; callers pass
 * `variantPairing` and `depositCents`, and this file computes neither.
 */
export async function emit(
  tx: DbTx,
  services: AnalyticsServices,
  name: AnalyticsEventName,
  actorUserId: string | null,
  fields?: EmitFields,
): Promise<void> {
  const event = prepare(name, actorUserId, fields);
  const assignments = await assignmentsFor(tx, services, [event]);
  await tx.analyticsEvent.create({
    data: buildRow(services, event, assignmentOf(assignments, event)),
  });
}

/**
 * Record several events in the caller's transaction, with one assignment lookup and one insert. Used where one transition
 * produces more than one event: `meetup_locked` once per participant plus `deposit_locked` for the recipient, or
 * `cancelled_late` plus `no_show`. An empty batch is a no-op, and every event is validated before any row is written.
 */
export async function emitMany(
  tx: DbTx,
  services: AnalyticsServices,
  events: readonly EmitInput[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const prepared = events.map((event) => prepare(event.name, event.actorUserId, event.fields));
  const assignments = await assignmentsFor(tx, services, prepared);
  await tx.analyticsEvent.createMany({
    data: prepared.map((event) => buildRow(services, event, assignmentOf(assignments, event))),
  });
}

interface PreparedEvent {
  readonly name: AnalyticsEventName;
  readonly actorUserId: string | null;
  readonly cityId: string | null;
  readonly meetupId: string | null;
  readonly props: AnalyticsProps;
}

interface ActorAssignment {
  readonly variant: Variant;
  readonly assignmentId: string;
}

/**
 * Validate one call's name and props and settle its nullable columns. The validation is not decoration: a caller can pass a
 * value widened from `unknown`, and a name or prop key outside the contract must fail here rather than be written.
 */
function prepare(
  name: AnalyticsEventName,
  actorUserId: string | null,
  fields: EmitFields | undefined,
): PreparedEvent {
  return {
    name: AnalyticsEventName.parse(name),
    actorUserId,
    cityId: fields?.cityId ?? null,
    meetupId: fields?.meetupId ?? null,
    props: AnalyticsProps.parse(fields?.props ?? {}),
  };
}

/**
 * The stored assignments of the funnel events in `events`, keyed by actor id: one query per batch, over the same `tx` the rows
 * are written in, so it sees the assignment the account-creation transaction wrote. An assignment is immutable, so no caller's
 * props override it.
 *
 * A funnel actor without an assignment is logged once and still written with null experiment columns rather than throwing:
 * analytics must never roll back a money or meetup transition. The warning names the event and carries no user id.
 */
async function assignmentsFor(
  tx: DbTx,
  services: AnalyticsServices,
  events: readonly PreparedEvent[],
): Promise<Map<string, ActorAssignment>> {
  const actors = new Set<string>();
  for (const event of events) {
    if (isFunnelEvent(event.name) && event.actorUserId !== null) {
      actors.add(event.actorUserId);
    }
  }
  const assignments = new Map<string, ActorAssignment>();
  if (actors.size === 0) {
    return assignments;
  }
  const rows = await tx.experimentAssignment.findMany({
    where: { userId: { in: [...actors] } },
    select: { userId: true, variant: true, assignmentId: true },
  });
  for (const row of rows) {
    assignments.set(row.userId, { variant: row.variant, assignmentId: row.assignmentId });
  }
  const warned = new Set<string>();
  for (const event of events) {
    const actorUserId = event.actorUserId;
    if (
      isFunnelEvent(event.name) &&
      actorUserId !== null &&
      !assignments.has(actorUserId) &&
      !warned.has(actorUserId)
    ) {
      warned.add(actorUserId);
      services.logger.warn({ event: 'experiment_assignment_missing', analyticsEvent: event.name });
    }
  }
  return assignments;
}

function assignmentOf(
  assignments: ReadonlyMap<string, ActorAssignment>,
  event: PreparedEvent,
): ActorAssignment | null {
  if (!isFunnelEvent(event.name) || event.actorUserId === null) {
    return null;
  }
  return assignments.get(event.actorUserId) ?? null;
}

/**
 * The `props` column value: the validated props with absent keys dropped, so the stored JSON holds no null hole. The key list
 * mirrors `AnalyticsProps`, and the record is what `Prisma.InputJsonValue` accepts without a cast.
 */
function jsonProps(props: AnalyticsProps): Record<string, string | number> {
  const json: Record<string, string | number> = {};
  if (props.variant !== undefined) json['variant'] = props.variant;
  if (props.assignmentId !== undefined) json['assignmentId'] = props.assignmentId;
  if (props.variantPairing !== undefined) json['variantPairing'] = props.variantPairing;
  if (props.depositCents !== undefined) json['depositCents'] = props.depositCents;
  if (props.outcome !== undefined) json['outcome'] = props.outcome;
  if (props.resolveSeconds !== undefined) json['resolveSeconds'] = props.resolveSeconds;
  if (props.placeCategory !== undefined) json['placeCategory'] = props.placeCategory;
  if (props.placeId !== undefined) json['placeId'] = props.placeId;
  return json;
}

/** One `AnalyticsEvent` row: the validated fields, the actor's hash, the experiment columns of a funnel event and the instant
 * the injected clock reports. No column or prop holds the raw id. */
function buildRow(
  services: AnalyticsServices,
  event: PreparedEvent,
  assignment: ActorAssignment | null,
): Prisma.AnalyticsEventCreateManyInput {
  const json = jsonProps(event.props);
  if (assignment !== null) {
    json['variant'] = assignment.variant;
    json['assignmentId'] = assignment.assignmentId;
  }
  return {
    name: event.name,
    actorHash:
      event.actorUserId === null ? null : actorHash(services.env.ANALYTICS_SALT, event.actorUserId),
    cityId: event.cityId,
    variant: assignment?.variant ?? null,
    assignmentId: assignment?.assignmentId ?? null,
    meetupId: event.meetupId,
    props: json,
    occurredAt: services.clock.now(),
  };
}
