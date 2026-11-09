/**
 * Proof validity and the shared proof reads: the one answer to whether this user holds a valid proof for this city
 * now — from two local days before arrival through the last instant of the departure day, in the arrival city's own
 * zone, as `ItineraryProof.validFrom`/`validTo` derived by {@link proofValidity} when the proof is stored.
 *
 * Read-only, and every instant is passed in by the caller. Validity gates *new* proposals and appearances only: an
 * expired proof does not affect an existing `proposed` or `locked` meetup. Account erasure deletes a user's proofs
 * while the `SpentNullifier` their booking produced survives, so a deleted account cannot free it for reuse.
 */

import { Prisma, type DbClient, type DbTx } from '@tablemate/db';
import { addLocalDays, endOfLocalDay, startOfLocalDay } from '@tablemate/server-core';
import { DAY_MS, PROOF_VALID_FROM_DAYS_BEFORE } from '@tablemate/shared';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An eight-digit `YYYYMMDD`, the form `lib/date_parse.circom` emits as a public signal. */
const SIGNAL_DATE_RE = /^\d{8}$/;

/** Whether a UTC instant really is that calendar date: the round-trip rejects an overflowing date, a month outside
 * 1-12 and a leading-zero year (`Date.UTC` reads `0050` as 1950). */
function isUtcDate(ms: number, year: number, month: number, day: number): boolean {
  const at = new Date(ms);
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

/** The UTC midnight of a `YYYY-MM-DD` date; `@throws RangeError` for a malformed or unreal calendar date. */
function utcMidnightMs(isoDate: string): number {
  const parts = ISO_DATE_RE.exec(isoDate);
  if (parts === null) {
    throw new RangeError(`Expected a calendar date as YYYY-MM-DD, received "${isoDate}"`);
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const ms = Date.UTC(year, month - 1, day);
  if (!isUtcDate(ms, year, month, day)) {
    throw new RangeError(`Expected a real calendar date, received "${isoDate}"`);
  }
  return ms;
}

/**
 * The instants a stay's proof is valid between: `PROOF_VALID_FROM_DAYS_BEFORE` local days before arrival, through the
 * last millisecond of the departure day *in the city's zone*. Both are stored on the row and never recomputed, so a
 * later change to a zone or to the constant cannot move an accepted proof's window. `@throws RangeError` for a zone
 * that is not IANA or an unreal date, which the route's Zod schema has already rejected.
 */
export function proofValidity(
  tz: string,
  arrivalDate: string,
  departureDate: string,
): { validFrom: Date; validTo: Date } {
  return {
    validFrom: startOfLocalDay(tz, addLocalDays(arrivalDate, -PROOF_VALID_FROM_DAYS_BEFORE)),
    validTo: endOfLocalDay(tz, departureDate),
  };
}

/**
 * The `YYYY-MM-DD` date a circuit date signal denotes, or `null` for a signal that is not a real calendar date
 * (`20260230`, `20250229`), which `verifier.ts` maps to `422 proof_invalid`.
 */
export function signalDateToIso(value: string | bigint): string | null {
  const text = value.toString();
  if (!SIGNAL_DATE_RE.test(text)) {
    return null;
  }
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  if (!isUtcDate(Date.UTC(year, month - 1, day), year, month, day)) {
    return null;
  }
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

/**
 * The whole days between two calendar dates, `departure - arrival`. `verifier.ts` requires
 * `STAY_MIN_DAYS <= stayDays <= STAY_MAX_DAYS`, so a same-day stay, a reversed pair and a stay longer than 120 days
 * all become `422 stay_out_of_range`. `@throws RangeError` for a date that is not a real calendar date, which each
 * signal has already been through {@link signalDateToIso} to rule out.
 */
export function stayDays(arrivalDate: string, departureDate: string): number {
  return (utcMidnightMs(departureDate) - utcMidnightMs(arrivalDate)) / DAY_MS;
}

/** Either database reader: the process's guarded client, or the client of the transaction a caller is already in;
 * these reads are safe inside a transaction. */
export type ProofReader = DbClient | DbTx;

/**
 * A stored proof as every caller sees it. `nullifier` and `registryRoot` are deliberately absent: neither is needed
 * outside `proofs/*`, and no response carries them.
 */
export interface ProofSummary {
  readonly id: string;
  readonly cityId: string;
  readonly arrivalDate: string;
  readonly departureDate: string;
  readonly issuerId: number;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly createdAt: Date;
}

/**
 * The columns of {@link ProofSummary}: the explicit `select` every read uses, so a query loads no column above what a
 * caller receives, and `satisfies` keeps the names checked against the model. Prisma returns the `@db.Date` columns
 * as `Date`s at UTC midnight and `issuer_id` as a `bigint`, which {@link toProofSummary} converts.
 */
const PROOF_SUMMARY_SELECT = {
  id: true,
  cityId: true,
  arrivalDate: true,
  departureDate: true,
  issuerId: true,
  validFrom: true,
  validTo: true,
  createdAt: true,
} as const satisfies Prisma.ItineraryProofSelect;

type ProofRow = Prisma.ItineraryProofGetPayload<{ select: typeof PROOF_SUMMARY_SELECT }>;

/**
 * Latest first, everywhere in this file: `createdAt`, then `id`, so "the latest proof" is one total order and two
 * proofs written in the same millisecond cannot make a read ambiguous.
 */
const LATEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

/** The validity predicate: `validFrom <= now <= validTo`, both bounds inclusive, stated once so "at the boundary"
 * means the same for every read. */
function validAt(now: Date): Prisma.ItineraryProofWhereInput {
  return { validFrom: { lte: now }, validTo: { gte: now } };
}

function isoDateColumn(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function toProofSummary(row: ProofRow): ProofSummary {
  return {
    id: row.id,
    cityId: row.cityId,
    arrivalDate: isoDateColumn(row.arrivalDate),
    departureDate: isoDateColumn(row.departureDate),
    issuerId: Number(row.issuerId),
    validFrom: row.validFrom,
    validTo: row.validTo,
    createdAt: row.createdAt,
  };
}

/**
 * The user's latest proof for one city that is valid at `now`, or `null`: the read discovery, the proposal guard for
 * both participants, lodging claims and the visibility toggle base `403 no_valid_proof` on.
 */
export async function activeProof(
  db: ProofReader,
  userId: string,
  cityId: string,
  now: Date,
): Promise<ProofSummary | null> {
  const row = await db.itineraryProof.findFirst({
    where: { userId, cityId, ...validAt(now) },
    orderBy: [...LATEST_FIRST],
    select: PROOF_SUMMARY_SELECT,
  });
  return row === null ? null : toProofSummary(row);
}

/** Whether the user holds a proof for this city that is valid at `now`: the yes/no form of {@link activeProof}, true
 * at both window boundaries and false a millisecond outside either. */
export async function hasValidProof(
  db: ProofReader,
  userId: string,
  cityId: string,
  now: Date,
): Promise<boolean> {
  return (await activeProof(db, userId, cityId, now)) !== null;
}

/**
 * The user's latest proof that is valid at `now` in any city, or `null`, for callers that do not fix the city first; a
 * user with overlapping valid proofs gets the more recently created one.
 */
export async function currentProof(
  db: ProofReader,
  userId: string,
  now: Date,
): Promise<ProofSummary | null> {
  const row = await db.itineraryProof.findFirst({
    where: { userId, ...validAt(now) },
    orderBy: [...LATEST_FIRST],
    select: PROOF_SUMMARY_SELECT,
  });
  return row === null ? null : toProofSummary(row);
}

/**
 * Every city the user holds a proof for that is valid at `now`, one entry per city, ascending: the entitlement set
 * `GET /me` publishes as `MeDto.validCityIds`. A traveler may hold overlapping valid proofs for several cities, so a
 * client naming a single city cannot tell which the caller may ask about and would show the unverified state for a
 * city they are entitled to; a user with two valid proofs for one city is named once, which is what `GROUP BY` does.
 * The window is {@link validAt}, both bounds inclusive, and the order is `city_id` ascending, so two reads of one
 * state give an identical payload.
 */
export async function validCityIdsFor(
  db: ProofReader,
  userId: string,
  now: Date,
): Promise<string[]> {
  const rows = await db.itineraryProof.groupBy({
    by: ['cityId'],
    where: { userId, ...validAt(now) },
    orderBy: { cityId: 'asc' },
  });
  return rows.map((row) => row.cityId);
}

/** One row of {@link PROOF_SUMMARY_SELECT}, with the owner {@link currentProofsFor} keys its map by. A raw read
 * delivers a `@db.Date` column and a `bigint` exactly as a typed one does. */
type ProofRowWithUser = ProofRow & { readonly userId: string };

/**
 * The current valid proof of every requested user, in one query: it batches the `currentCityId` and `proofDates` of a
 * whole page of `Tier0Profile`s, so twenty profiles cost one read rather than twenty. `DISTINCT ON (p."user_id")`
 * keeps each user's latest valid proof at the database, which Prisma's own `distinct` cannot: that option reaches
 * PostgreSQL as no `DISTINCT ON` at all, leaving every matching row to the client. The `ORDER BY` leads with
 * `user_id`, which `DISTINCT ON` requires of its expression, then {@link LATEST_FIRST}. A user with no valid proof is
 * absent from the map rather than mapped to `null`, and an empty request queries nothing.
 */
export async function currentProofsFor(
  db: ProofReader,
  userIds: readonly string[],
  now: Date,
): Promise<Map<string, ProofSummary>> {
  const proofs = new Map<string, ProofSummary>();
  const wanted = [...new Set(userIds)];
  if (wanted.length === 0) {
    return proofs;
  }
  // The column list is PROOF_SUMMARY_SELECT's own, aliased to the names ProofRow gives those
  // columns, and the ids bind as the one `uuid[]` the whole page needs.
  const rows = await db.$queryRaw<ProofRowWithUser[]>(Prisma.sql`
    SELECT DISTINCT ON (p."user_id")
           p."id" AS "id",
           p."user_id" AS "userId",
           p."city_id" AS "cityId",
           p."arrival_date" AS "arrivalDate",
           p."departure_date" AS "departureDate",
           p."issuer_id" AS "issuerId",
           p."valid_from" AS "validFrom",
           p."valid_to" AS "validTo",
           p."created_at" AS "createdAt"
      FROM "itinerary_proof" p
     WHERE p."user_id" = ANY(${wanted}::uuid[])
       AND p."valid_from" <= ${now}
       AND p."valid_to" >= ${now}
     ORDER BY p."user_id", p."created_at" DESC, p."id" DESC
  `);
  for (const row of rows) {
    if (!proofs.has(row.userId)) {
      proofs.set(row.userId, toProofSummary(row));
    }
  }
  return proofs;
}

/**
 * The user's most recent proof whatever its validity, or `null`. A profile reports proof status, including "expired",
 * and discovery shows an unverified user only to viewers who already met them, in the city of their most recent proof;
 * neither is a validity question, so the window is not applied.
 */
export async function latestProof(db: ProofReader, userId: string): Promise<ProofSummary | null> {
  const row = await db.itineraryProof.findFirst({
    where: { userId },
    orderBy: [...LATEST_FIRST],
    select: PROOF_SUMMARY_SELECT,
  });
  return row === null ? null : toProofSummary(row);
}
