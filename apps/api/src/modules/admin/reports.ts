/**
 * The operator's report queue: the newest reports first, mapped field by field into {@link AdminReportDto} by a
 * read-only module that opens no transaction.
 *
 * Three fields are nullable, each for a reason of its own: either handle is null once that account has been erased,
 * `reason` is null once the 180-day purge has emptied the reporter's free text rather than nulling the NOT NULL
 * column, and `meetupId` is null for a report that concerns no meetup.
 *
 * No row is ever spread into an answer: every field is copied by name, so a column added to `Report` or to either
 * `User` can never reach an operator without a change here. The free text is never logged either.
 */

import type { AdminReportDto, AdminReportsResponse } from '@tablemate/shared';
import type { DbClient } from '@tablemate/db';

/**
 * The most reports one read of the queue returns (AAP 0.5.4): a cap rather than a page size, because the contract has
 * no cursor, so a queue longer than this one is read from the database by hand.
 */
export const ADMIN_REPORTS_LIMIT = 200;

/**
 * Narrowed on purpose: the dependency whitelist of this file admits `@tablemate/db` and `@tablemate/shared` only, so
 * the module states the single capability it uses rather than importing the app's services type, and a test can stand
 * a reader in for the database.
 */
export interface AdminReportQueueServices {
  readonly db: Pick<DbClient, 'report'>;
}

/**
 * Ordered by `createdAt` descending with `id` breaking a same-instant tie, so the queue is deterministic; ids are
 * UUIDv7 and therefore time-ordered, which keeps the tie-break newest-first. The two handles come from the `reporter`
 * and `reported` relations in the same query, one round trip and no N+1.
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
