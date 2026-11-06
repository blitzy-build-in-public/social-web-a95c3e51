/**
 * Proof validity and the shared proof reads (AAP 0.5.2, 0.5.3, 0.5.5, 0.5.7).
 *
 * The one answer to "does this user hold a valid proof for this city now?", which discovery, the
 * proposal guard, lodging claims and visibility, disclosure and the profile all ask. A proof is
 * valid from two local days before its arrival through the last instant of its departure day, both
 * in the arrival city's own zone — `ItineraryProof.validFrom` and `validTo`, derived by
 * {@link proofValidity} once, when the proof is stored (AAP 0.5.2, 0.5.7).
 *
 * Read-only: nothing here mutates, opens a transaction, reads the clock or decides a rule. Every
 * function takes the instant it reasons about from the caller — `services.clock.now()`,
 * `request.receivedAt`, or a test clock — which is what lets the criterion tests cross a validity
 * boundary. Validity gates *new* proposals and appearances only: an expired proof does not affect an
 * existing `proposed` or `locked` meetup, and neither does deleting one (AAP 0.5.3), so a caller
 * wanting the stored proof regardless of validity asks {@link latestProof}. Callers exclude deleted
 * and deletion-requested users themselves; account erasure deletes a user's proofs while the
 * `SpentNullifier` their booking produced survives, so a deleted account cannot free it for reuse
 * (AAP 0.5.2).
 *
 * Leaf of the module graph: no file under `apps/api/src/modules/**` is imported, because
 * `users/disclosure/*`, `cities/*`, `lodgings/*`, `me/*` and `meetups/*` import this one.
 *
 * @see AAP 0.5.2 for the model, its `@db.Date` columns and the `(cityId, validTo)` index the city
 *   read uses, 0.5.5 for the circuit's `YYYYMMDD` date encoding and its 1-120 day stay bound,
 *   0.5.7 for the validity and discovery rules, and 0.11.1 for the injected clock.
 */

import { Prisma, type DbClient, type DbTx } from '@tablemate/db';
import { addLocalDays, endOfLocalDay, startOfLocalDay } from '@tablemate/server-core';
import { DAY_MS, PROOF_VALID_FROM_DAYS_BEFORE } from '@tablemate/shared';

// ---------------------------------------------------------------------------------------------
// Pure helpers: the validity window and the circuit's dates (AAP 0.5.5, 0.5.7)
// ---------------------------------------------------------------------------------------------

/** The one accepted spelling of a calendar date, and the source of its three parts. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An eight-digit `YYYYMMDD`, the form `lib/date_parse.circom` emits as a public signal. */
const SIGNAL_DATE_RE = /^\d{8}$/;

/**
 * Whether a UTC instant really is `day` of `month` of `year`: the round-trip that rejects an
 * overflowing date (`2026-02-30` lands on 2 March), a month outside 1-12 and a leading-zero year
 * (`0050` is read as 1950 by `Date.UTC`).
 */
function isUtcDate(ms: number, year: number, month: number, day: number): boolean {
  const at = new Date(ms);
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

/**
 * The UTC midnight of a `YYYY-MM-DD` date, as epoch milliseconds.
 *
 * @throws RangeError when the date is malformed or is not a real calendar date.
 */
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
 * The instants a stay's proof is valid between, from the two calendar dates the circuit proved
 * (AAP 0.5.2, 0.5.7).
 *
 * `validFrom` is {@link PROOF_VALID_FROM_DAYS_BEFORE} local days before the arrival, so a traveler
 * can prove and propose shortly before getting there; `validTo` is the last millisecond of the
 * departure day *in the city's zone*, so a stay ending on a Lisbon evening is valid until Lisbon's
 * midnight rather than the prover's. The two are stored on the row and never recomputed, so a later
 * change to the zone or to the constant cannot move an accepted proof's window.
 *
 * @param tz - The city's IANA zone, from `config/cities.json` through `services.timezoneFor`.
 * @param arrivalDate - The proof's arrival date as `YYYY-MM-DD`.
 * @param departureDate - The proof's departure date as `YYYY-MM-DD`.
 * @returns The first and last instant the proof is valid, in UTC.
 * @throws RangeError for a zone that is not IANA or a date that is not a real calendar date
 *   (`2026-02-30`), which the route's Zod schema has already rejected; the check itself lives in
 *   `packages/server-core/src/time/city-time.ts`.
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
 * The `YYYY-MM-DD` date a circuit date signal denotes, or `null` when the signal is not a real
 * calendar date (AAP 0.5.5).
 *
 * The circuit proves the stay dates as the integers `YYYYMMDD` (`lib/date_parse.circom`), which
 * arrive as decimal strings from snarkjs and as `bigint`s in a unit test. Only a date whose month is
 * 1-12 and whose day exists in that month under the Gregorian leap rule converts: `20260230` and
 * `20250229` answer `null`, `20280229` answers `2028-02-29`. `verifier.ts` maps `null` to
 * `422 proof_invalid`, because a proof whose public signals are not dates proves no stay whatever
 * else verifies.
 *
 * @param value - The signal, as snarkjs delivers it or as a `bigint`.
 * @returns The date as `YYYY-MM-DD`, or `null` when the value is not a real calendar date.
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
 * The whole days between two calendar dates, `departure - arrival` (AAP 0.5.4, 0.5.5).
 *
 * `verifier.ts` requires `STAY_MIN_DAYS <= stayDays <= STAY_MAX_DAYS`, so a same-day stay (`0`), a
 * reversed pair (negative) and a stay longer than 120 days all become `422 stay_out_of_range`. The
 * difference of two UTC midnights carries no zone, no DST transition and no fractional day, so the
 * result is exactly the count of calendar days between the two dates.
 *
 * @param arrivalDate - The arrival date as `YYYY-MM-DD`.
 * @param departureDate - The departure date as `YYYY-MM-DD`.
 * @returns The stay in whole days, negative when the departure precedes the arrival.
 * @throws RangeError when either date is malformed or not a real calendar date. Both reach here
 *   already validated, because each signal went through {@link signalDateToIso} first.
 */
export function stayDays(arrivalDate: string, departureDate: string): number {
  return (utcMidnightMs(departureDate) - utcMidnightMs(arrivalDate)) / DAY_MS;
}

// ---------------------------------------------------------------------------------------------
// Reads over ItineraryProof (AAP 0.5.2, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * Either database reader: the process's guarded client, or the client of the transaction a caller is
 * already in. These reads are safe inside a transaction, which is what a caller deciding disclosure
 * or creating a proposal needs.
 */
export type ProofReader = DbClient | DbTx;

/**
 * A stored proof as every caller sees it (AAP 0.5.2).
 *
 * The two dates are the calendar dates the circuit proved; the two instants are the window
 * {@link proofValidity} derived from them. Deliberately absent: `nullifier` (the anti-reuse key,
 * compared through `SpentNullifier` rather than read) and `registryRoot` (the root the proof was
 * accepted against). Neither is needed outside `proofs/*`, and no response carries them
 * (AAP 0.5.4, 0.12.2).
 */
export interface ProofSummary {
  /** The `ItineraryProof` row's id. */
  readonly id: string;
  /** The city slug the proof is for, a `City.id`. */
  readonly cityId: string;
  /** The arrival date, `YYYY-MM-DD`. */
  readonly arrivalDate: string;
  /** The departure date, `YYYY-MM-DD`. */
  readonly departureDate: string;
  /** The allowlisted issuer's integer id, read out of the `BigInt` column. */
  readonly issuerId: number;
  /** The first instant the proof is valid, from {@link proofValidity}. */
  readonly validFrom: Date;
  /** The last instant the proof is valid, from {@link proofValidity}. */
  readonly validTo: Date;
  /** When the proof was stored; with the id, what makes "the latest proof" a total order. */
  readonly createdAt: Date;
}

/**
 * The columns of {@link ProofSummary}: the explicit `select` every read here uses, so a query loads
 * no column above what a caller receives.
 *
 * Prisma returns the `@db.Date` columns as `Date`s at UTC midnight and `issuer_id` as a `bigint`;
 * {@link toProofSummary} converts both. The `satisfies` keeps the names checked against the model,
 * so a renamed column fails the build instead of quietly dropping a field from a response.
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

/** The row {@link PROOF_SUMMARY_SELECT} loads. */
type ProofRow = Prisma.ItineraryProofGetPayload<{ select: typeof PROOF_SUMMARY_SELECT }>;

/**
 * Latest first, everywhere in this file (AAP 0.5.2): `createdAt`, then `id` as the tie-breaker, so a
 * user's latest proof is one total order and two proofs written in the same millisecond cannot make
 * a read ambiguous. Spread at each call site, because Prisma's `orderBy` takes a mutable array.
 */
const LATEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

/**
 * The validity predicate: `validFrom <= now <= validTo`, both bounds inclusive (AAP 0.5.7). Stated
 * once, so "at the boundary" means the same for every read.
 */
function validAt(now: Date): Prisma.ItineraryProofWhereInput {
  return { validFrom: { lte: now }, validTo: { gte: now } };
}

/** The `@db.Date` column as its `YYYY-MM-DD` date. */
function isoDateColumn(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** One row as the {@link ProofSummary} a caller receives. */
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
 * The user's latest proof for one city that is valid at `now`, or `null` (AAP 0.5.7).
 *
 * The read discovery, the proposal guard (for both participants), lodging claims and the visibility
 * toggle base `403 no_valid_proof` on, and the one served by the `(cityId, validTo)` index
 * (AAP 0.5.2). A user holding several proofs for a city gets the most recently created valid one.
 *
 * @param db - The guarded client, or the transaction's client.
 * @param userId - The traveler whose proof is wanted.
 * @param cityId - The city slug to look in.
 * @param now - The instant validity is judged at, from the caller's injected clock.
 * @returns The valid proof as a {@link ProofSummary}, or `null` when the user has none for the city.
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

/**
 * Whether the user holds a proof for this city that is valid at `now` (AAP 0.5.7).
 *
 * The yes/no form of {@link activeProof}, for the many callers that only gate on it. True at both
 * window boundaries and false a millisecond outside either.
 *
 * @param db - The guarded client, or the transaction's client.
 * @param userId - The traveler whose proof is asked about.
 * @param cityId - The city slug to look in.
 * @param now - The instant validity is judged at, from the caller's injected clock.
 * @returns True when a valid proof exists for that city and user.
 */
export async function hasValidProof(
  db: ProofReader,
  userId: string,
  cityId: string,
  now: Date,
): Promise<boolean> {
  return (await activeProof(db, userId, cityId, now)) !== null;
}

/**
 * The user's latest proof that is valid at `now` in any city, or `null` (AAP 0.5.7).
 *
 * For callers that do not fix the city first: a lodging claim resolves the city from the proof, and
 * a profile reports `currentCityId` and `proofDates` from it. A user travelling through two cities
 * with overlapping proofs gets the more recently created one, so the reported city is the one they
 * proved most recently, not the one that happens to sort first.
 *
 * @param db - The guarded client, or the transaction's client.
 * @param userId - The traveler whose current proof is wanted.
 * @param now - The instant validity is judged at, from the caller's injected clock.
 * @returns The user's current proof, or `null` when no proof of theirs is valid now.
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
 * One row of {@link PROOF_SUMMARY_SELECT}, with the owner {@link currentProofsFor} keys its map by.
 *
 * The statement there names its columns as this type spells them. Prisma delivers a `@db.Date`
 * column as a `Date` at UTC midnight and `issuer_id` as a `bigint` for a raw read exactly as it does
 * for a typed one, so {@link toProofSummary} reads this row as it reads a selected row.
 */
type ProofRowWithUser = ProofRow & { readonly userId: string };

/**
 * The current valid proof of every requested user, in one query (AAP 0.5.7).
 *
 * Batches the `currentCityId` and `proofDates` of a whole page of `Tier0Profile`s — discovery pages
 * and lodging guest lists — so building twenty profiles costs one read rather than twenty (AAP
 * 0.5.4, whose traveler page holds 20 profiles). The read is one row per requested user at the
 * database level: `DISTINCT ON (p."user_id")` keeps each user's latest valid proof and returns
 * nothing else, so a user with several valid overlapping stays no longer multiplies the rows the
 * database sends. It is the same statement `cities/discovery.ts` runs for its page of travelers,
 * and Prisma's own `distinct` cannot replace it: that option reaches PostgreSQL as no `DISTINCT ON`
 * at all — the database still returns every matching row and the client de-duplicates them — which
 * is exactly the unbounded read this read is here to avoid.
 *
 * The `ORDER BY` leads with `user_id`, which `DISTINCT ON` requires of its expression, and the rest
 * of it is {@link LATEST_FIRST}; each user's first row under that order is therefore still their
 * latest proof, which is what the map holds. The window is the two inclusive bounds of
 * {@link validAt}, written out because the read is a statement. Duplicate ids are collapsed, and an
 * empty request queries nothing.
 *
 * A user with no valid proof is absent from the map rather than mapped to `null`: callers render an
 * unverified traveler by omitting those fields.
 *
 * @param db - The guarded client, or the transaction's client.
 * @param userIds - The travelers whose proofs are wanted; duplicates are collapsed.
 * @param now - The instant validity is judged at, from the caller's injected clock.
 * @returns A map from user id to that user's current proof, holding only the users that have one.
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
 * The user's most recent proof whatever its validity, or `null` (AAP 0.5.7).
 *
 * Two callers need exactly that. A profile reports proof status, including "expired" for a traveler
 * whose stay has ended. And discovery shows an unverified user only to viewers who already completed
 * a meetup with them, in the city of their most recent proof — the only city such a pair can share,
 * and one that may well be in the past. Neither call site is a validity question, so the window is
 * not applied; a caller that does mean validity asks {@link activeProof} or {@link currentProof}.
 *
 * @param db - The guarded client, or the transaction's client.
 * @param userId - The traveler whose latest proof is wanted.
 * @returns The most recently created proof of that user, or `null` when they have none.
 */
export async function latestProof(db: ProofReader, userId: string): Promise<ProofSummary | null> {
  const row = await db.itineraryProof.findFirst({
    where: { userId },
    orderBy: [...LATEST_FIRST],
    select: PROOF_SUMMARY_SELECT,
  });

  return row === null ? null : toProofSummary(row);
}
