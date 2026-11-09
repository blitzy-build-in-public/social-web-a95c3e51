/**
 * The crawl-policy review queue and one operator's decision on a domain: `GET /admin/crawl-domains` and
 * `PATCH /admin/crawl-domains/:domain`.
 *
 * A domain the crawler meets for the first time is recorded `uncertain` / `awaiting_review` before its first fetch
 * and is never fetched while it stays there. This route is what releases a site for the menu pipeline: an operator
 * reads the site's terms and records `allowed` or `prohibited`, and nothing reads terms pages automatically.
 *
 * The blocklist of `config/crawl-blocklist.json` outranks every row here, so an `allowed` row never unlocks an
 * aggregator, delivery or review site.
 */

import type { DbClient } from '@tablemate/db';
import type { Logger } from '@tablemate/server-core';
import type {
  AdminCrawlDomainDto,
  AdminCrawlDomainsResponse,
  CrawlDecision,
  CrawlDomainDecisionUpdate,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { transact, type TransactServices } from '../outbox/write.ts';

/**
 * How many domains one read of the review queue returns (AAP 0.5.4): the contract carries no cursor, so a queue longer
 * than this is read from the database by hand, and the cap is what keeps a single operator page bounded.
 */
export const ADMIN_CRAWL_DOMAINS_LIMIT = 500;

const REASON_OPERATOR_REVIEW = 'operator_review';

const CRAWL_DOMAIN_DECIDED = 'crawl_domain_decided';

/**
 * Declared here rather than as `Pick<AppServices, …>`: the app's services type lives in `apps/api/src/app.ts`, a file
 * this module does not depend on, and `clock` and `outbox` are taken from `transact`'s own services type, so the
 * transaction call is typed exactly as that call requires them.
 */
export interface CrawlDomainServices {
  readonly db: DbClient;
  /** The injected clock `transact` binds to the transaction (AAP 0.11.1). */
  readonly clock: TransactServices['clock'];
  readonly logger: Logger;
  readonly outbox: TransactServices['outbox'];
}

/**
 * One policy row as {@link listCrawlDomains} reads it: every field is aliased by name, so a column added to
 * `CrawlDomainPolicy` cannot reach an operator without a change here, and `overriddenBy` reaches the DTO only as a
 * boolean.
 */
interface CrawlDomainRow {
  readonly domain: string;
  readonly decision: CrawlDecision;
  readonly reason: string;
  readonly checkedAt: Date;
  readonly overriddenBy: string | null;
}

/**
 * The crawl-policy review queue (AAP 0.5.4, 0.5.6): the domains awaiting review first, then the most recently checked,
 * capped at {@link ADMIN_CRAWL_DOMAINS_LIMIT}.
 *
 * The order is an expression over the decision rather than the decision alone, so the domains nobody has read yet come
 * first: ordering by the enum would put them on top only because `uncertain` is its last member, and would sort the
 * decided domains by decision instead of by recency. Prisma's `orderBy` cannot carry that expression, so the statement
 * is written out as a tagged template (AAP 0.11.2). `domain` breaks a tie on `checked_at`, which the crawler writes
 * once for a whole run.
 */
export async function listCrawlDomains(
  services: CrawlDomainServices,
): Promise<AdminCrawlDomainsResponse> {
  const rows = await services.db.$queryRaw<CrawlDomainRow[]>`
    SELECT "domain",
           "decision",
           "reason",
           "checked_at" AS "checkedAt",
           "overridden_by" AS "overriddenBy"
      FROM "crawl_domain_policy"
     ORDER BY ("decision" = 'uncertain') DESC, "checked_at" DESC, "domain" ASC
     LIMIT ${ADMIN_CRAWL_DOMAINS_LIMIT}
  `;
  return { items: rows.map(toDto) };
}

/**
 * Records an operator's decision on one domain (AAP 0.5.4, 0.5.6), and answers `422 invalid_outcome` for anything but
 * `allowed` or `prohibited`.
 *
 * `uncertain` is never accepted: it is where an unreviewed domain already sits, and it is the crawler's value to write,
 * not an operator's. The write is an upsert, so a domain the crawler has not met yet can be decided ahead of its first
 * fetch — the operator reads the site's terms whichever order the two arrive in, and the crawler's own
 * `insertUncertain` leaves an existing row alone. `overriddenBy` records who decided, which is what marks the row as a
 * human judgement for the next reader, and `safe-fetch.ts` honours the decision from the next fetch on.
 *
 * The transaction carries the account-deletion write fence, so a decision cannot be committed for an account whose
 * deletion has begun (AAP 0.5.3).
 */
export async function decideCrawlDomain(
  services: CrawlDomainServices,
  operatorId: string,
  domain: string,
  body: CrawlDomainDecisionUpdate,
  now: Date,
): Promise<AdminCrawlDomainDto> {
  const decision = operatorDecision(body.decision);
  const row = await transact(
    services,
    async (tx) =>
      tx.crawlDomainPolicy.upsert({
        where: { domain },
        create: {
          domain,
          decision,
          reason: REASON_OPERATOR_REVIEW,
          checkedAt: now,
          overriddenBy: operatorId,
        },
        update: {
          decision,
          reason: REASON_OPERATOR_REVIEW,
          checkedAt: now,
          overriddenBy: operatorId,
        },
        select: {
          domain: true,
          decision: true,
          reason: true,
          checkedAt: true,
          overriddenBy: true,
        },
      }),
    { fenceUserId: operatorId },
  );
  services.logger.info({ event: CRAWL_DOMAIN_DECIDED, domain, decision });
  return toDto(row);
}

/**
 */
function operatorDecision(value: string): 'allowed' | 'prohibited' {
  if (value === 'allowed' || value === 'prohibited') {
    return value;
  }
  throw new AppError('invalid_outcome');
}

/**
 * Maps one row to its DTO through an explicit allowlist (AAP 0.5.4). `overriddenBy` never leaves the server: it holds a
 * user id, and an operator needs only the fact — carried by `overridden` — that a decision was taken outside the
 * crawler.
 */
function toDto(row: CrawlDomainRow): AdminCrawlDomainDto {
  return {
    domain: row.domain,
    decision: row.decision,
    reason: row.reason,
    checkedAt: row.checkedAt.toISOString(),
    overridden: row.overriddenBy !== null,
  };
}
