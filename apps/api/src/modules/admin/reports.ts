/**
 * The user-report queue of `GET /admin/reports` (AAP 0.5.4, request item 12): the reports travelers
 * have filed, newest first, for an operator to read.
 *
 * A report is written once by the safety route that files it and never changes, so this module is
 * one read-only mapping from `Report` rows to {@link AdminReportDto} and opens no transaction. The
 * route it serves is an `/admin/*` route, so `role = operator` and `403 operator_only` are the
 * route guard's business (AAP 0.5.4), not this file's.
 *
 * Three fields are nullable, each for a reason of its own (AAP 0.5.2):
 *   - either handle is null once that account has been erased, because erasure leaves a tombstone
 *     holding only the id and `deletedAt`, and `User.handle` is written null;
 *   - `reason` is null once the 180-day purge has taken the reporter's free text, which is kept
 *     that long for safety and payment-dispute handling and no longer. `Report.reason` is NOT
 *     NULL, so the `data-expiry` job empties the text to an empty string rather than nulling it;
 *     this queue reports an emptied reason as null, which is what the nullable DTO field means;
 *   - `meetupId` is null for a report that concerns no meetup.
 *
 * No row is ever spread into an answer: every field is copied by name, so a column added to
 * `Report` or to either `User` can never reach an operator without a change here. The free text is
 * never logged either (AAP 0.11.1).
 *
 * The contract carries no cursor, so the queue reads the newest {@link ADMIN_REPORTS_LIMIT}
 * reports and stops; an operator who needs an older one reads the row in the database. The cap is
 * what keeps a single operator page bounded.
 *
 * @see AAP 0.5.4 for the route, its DTO and its guard, 0.5.2 for what erasure and the 180-day
 *   purge leave behind, and 0.5.6 for the `data-expiry` job that purges the text.
 */

import type { AdminReportDto, AdminReportsResponse } from '@tablemate/shared';
import type { DbClient } from '@tablemate/db';

/**
 * The most reports one read of the queue returns (AAP 0.5.4).
 *
 * A cap rather than a page size: the contract has no cursor, so a queue longer than this one is
 * read from the database by hand.
 */
export const ADMIN_REPORTS_LIMIT = 200;

/**
 * What {@link listReports} needs from its caller: the API's services, narrowed to the one delegate
 * this module reads.
 *
 * Narrowed on purpose. The composition root declares the services type, and the dependency
 * whitelist of this file admits `@tablemate/db` and `@tablemate/shared` only, so the module states
 * the single capability it uses rather than importing the app's type; the app's services object
 * satisfies this structurally, and a test can stand a reader in for the database.
 */
export interface AdminReportQueueServices {
  /** The guarded Prisma client, of which only the `report` delegate is read. */
  readonly db: Pick<DbClient, 'report'>;
}

/**
 * The report queue, newest first, capped at {@link ADMIN_REPORTS_LIMIT} (AAP 0.5.4).
 *
 * Ordered by `createdAt` descending with `id` breaking a same-instant tie, so the queue is
 * deterministic; ids are UUIDv7 and therefore time-ordered, which keeps the tie-break newest-first.
 * The two handles come from the `reporter` and `reported` relations in the same query, one round
 * trip and no N+1.
 *
 * @param services - The app's services, from which `db.report` is read (see
 *   {@link AdminReportQueueServices}).
 * @returns The mapped queue; an empty `items` array when nothing has been reported.
 */
export async function listReports(
  services: AdminReportQueueServices,
): Promise<AdminReportsResponse> {
  const rows = await services.db.report.findMany({
    // Selected, never included whole: an unwritten column cannot leak into the answer.
    select: {
      id: true,
      reason: true,
      meetupId: true,
      createdAt: true,
      reporter: { select: { handle: true } },
      reported: { select: { handle: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: ADMIN_REPORTS_LIMIT,
  });

  return {
    items: rows.map((row): AdminReportDto => ({
      id: row.id,
      reporterHandle: row.reporter.handle,
      reportedHandle: row.reported.handle,
      reason: row.reason === '' ? null : row.reason,
      meetupId: row.meetupId,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
