/**
 * Crawl-domain review and override: the handlers of `GET /admin/crawl-domains` and
 * `PATCH /admin/crawl-domains/:domain` (AAP 0.5.4, 0.5.6).
 *
 * A domain the crawler meets for the first time is recorded `uncertain` / `awaiting_review` before
 * its first fetch and is never fetched while it stays there (AAP 0.5.6). This route is what
 * releases a site for the menu pipeline: an operator reads the site's terms and records `allowed`
 * or `prohibited`. Nothing reads terms pages automatically (AAP 0.7.2), and a decision is never
 * rechecked — the row an operator wrote stands until an operator writes another.
 *
 * The blocklist of `config/crawl-blocklist.json` outranks every row here: the workers'
 * `menus/blocklist.ts` and `menus/safe-fetch.ts` consult it before this policy, and
 * `menus/crawl-policy.ts` answers `prohibited` for a blocklisted host whatever its row says. An
 * `allowed` row therefore never unlocks an aggregator, delivery or review site — this route only
 * decides a domain the crawler would otherwise have left alone.
 *
 * The routes calling these two functions are `/admin/*` routes, so `role = operator` and `403
 * operator_only` are their guard's business, not this module's (AAP 0.5.4).
 *
 * @see AAP 0.5.4 for the two routes, their bodies and their `422 invalid_outcome`, 0.5.6 for the
 *   site-terms policy and the review queue, 0.5.2 for the `CrawlDomainPolicy` model, and 0.8.1 for
 *   this file.
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
 * How many domains one read of the review queue returns (AAP 0.5.4).
 *
 * The contract carries no cursor, so a queue longer than this is read from the database by hand;
 * the cap is what keeps a single operator page bounded.
 */
export const ADMIN_CRAWL_DOMAINS_LIMIT = 500;

/** What `CrawlDomainPolicy.reason` says of a decision an operator took (AAP 0.5.6). */
const REASON_OPERATOR_REVIEW = 'operator_review';

/** The one log line this module writes. */
const CRAWL_DOMAIN_DECIDED = 'crawl_domain_decided';

/**
 * What this module needs from the app's services (AAP 0.5.1): the guarded database client it reads,
 * the process logger it writes its one line through, and the injected clock and outbox dispatcher
 * that `transact` reads. The app container satisfies this shape structurally.
 *
 * Declared here rather than as `Pick<AppServices, …>`, the way `modules/admin/reports.ts` and
 * `modules/admin/price-jobs.ts` declare theirs beside it: the app's services type lives in
 * `apps/api/src/app.ts`, a file this module does not depend on. `clock` and `outbox` are taken from
 * `transact`'s own services type, so the transaction call is typed exactly as that call requires
 * them and no member of it is restated by hand.
 */
export interface CrawlDomainServices {
  /** The guarded Prisma client the transaction is opened on and `crawl_domain_policy` is read from. */
  readonly db: DbClient;
  /** The injected clock `transact` binds to the transaction (AAP 0.11.1). */
  readonly clock: TransactServices['clock'];
  /** The process logger, of which only `info` is written through. */
  readonly logger: Logger;
  /** The outbox dispatcher `transact` kicks after a commit that wrote an outbox row. */
  readonly outbox: TransactServices['outbox'];
}

/**
 * One policy row as {@link listCrawlDomains} reads it.
 *
 * Every field is aliased by name, so a column added to `CrawlDomainPolicy` cannot reach an operator
 * without a change here, and `overriddenBy` reaches the DTO only as a boolean.
 */
interface CrawlDomainRow {
  readonly domain: string;
  readonly decision: CrawlDecision;
  readonly reason: string;
  readonly checkedAt: Date;
  readonly overriddenBy: string | null;
}

/**
 * The crawl-policy review queue (AAP 0.5.4, 0.5.6): the domains awaiting review first, then the
 * most recently checked, capped at {@link ADMIN_CRAWL_DOMAINS_LIMIT}.
 *
 * The order is an expression over the decision rather than the decision alone, so the domains
 * nobody has read yet come first: ordering by the enum would put them on top only because
 * `uncertain` is its last member, and would sort the decided domains by decision instead of by
 * recency. Prisma's `orderBy` cannot carry that expression, so the statement is written out as a
 * tagged template (AAP 0.11.2). `domain` breaks a tie on `checked_at`, which the crawler writes
 * once for a whole run.
 *
 * @param services - The app's services, of which only `db` is read (see
 *   {@link CrawlDomainServices}).
 * @returns The queue mapped to {@link AdminCrawlDomainDto}; an empty `items` array on an empty
 *   table.
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
 * Records an operator's decision on one domain (AAP 0.5.4, 0.5.6), and answers `422
 * invalid_outcome` for anything but `allowed` or `prohibited`.
 *
 * `uncertain` is never accepted: it is where an unreviewed domain already sits, and it is the
 * crawler's value to write, not an operator's. The write is an upsert, so a domain the crawler has
 * not met yet can be decided ahead of its first fetch — the operator reads the site's terms
 * whichever order the two arrive in, and the crawler's own `insertUncertain` leaves an existing row
 * alone. `overriddenBy` records who decided, which is what marks the row as a human judgement for
 * the next reader, and `safe-fetch.ts` honours the decision from the next fetch on.
 *
 * The transaction carries the account-deletion write fence, so a decision cannot be committed for
 * an account whose deletion has begun (AAP 0.5.3).
 *
 * @param services - The app's services (see {@link CrawlDomainServices}).
 * @param operatorId - The operator taking the decision; `overriddenBy` records it and the fence is
 *   taken on it.
 * @param domain - The domain to decide, from the route's parsed `DomainParams.domain`.
 * @param body - The validated body. Its `decision` is checked against the lifecycle here, because
 *   no schema can tell `allowed` from an unknown value (AAP 0.5.4).
 * @param now - The instant recorded as `checkedAt`, from the request's received time (AAP 0.11.1).
 * @returns The stored decision as {@link AdminCrawlDomainDto}, whose `overridden` is true.
 * @throws {AppError} `invalid_outcome` for a decision that is neither `allowed` nor `prohibited`.
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
 * The decision a validated body asks for, or `invalid_outcome` (AAP 0.5.4).
 *
 * @param value - The body's `decision`, which the contract types as a free string.
 * @returns The decision, as the lifecycle enum's two operator-settable members.
 * @throws {AppError} `invalid_outcome` for any other value, `uncertain` included.
 */
function operatorDecision(value: string): 'allowed' | 'prohibited' {
  if (value === 'allowed' || value === 'prohibited') {
    return value;
  }

  throw new AppError('invalid_outcome');
}

/**
 * Maps one row to its DTO through an explicit allowlist (AAP 0.5.4).
 *
 * `overriddenBy` never leaves the server: it holds a user id, and an operator needs only the fact —
 * carried by `overridden` — that a decision was taken outside the crawler, by an operator or by the
 * seed for a fixture host.
 *
 * @param row - The row {@link listCrawlDomains} or {@link decideCrawlDomain} read.
 * @returns The operator-facing DTO.
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
