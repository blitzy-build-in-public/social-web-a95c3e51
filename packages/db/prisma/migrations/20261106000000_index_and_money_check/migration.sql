-- Why this is a new migration directory rather than an edit of 20261104000000_init: that migration is already
-- applied in every database of this run and `prisma migrate deploy` skips an applied migration by name, so a change
-- appended to it can never reach an existing database. Measured: with an index appended to the init file, deploy
-- answered "No pending migrations to apply." and the index stayed absent; from this directory the migration applies
-- and the index exists.
--
-- Two objects live here, both of which Prisma 6.19.3 cannot express in schema.prisma: single-column indexes the
-- retention predicates and the meetup metric range filter need, and a check constraint on the money columns.

-- CreateIndex: data-expiry purges expired sessions by expires_at, 24 h after expiry (AAP 0.5.2)
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex: every meetup metric range-filters starts_at alone; the composite (status, starts_at) has it trailing (AAP 0.5.7)
CREATE INDEX "meetup_starts_at_idx" ON "meetup"("starts_at");

-- CreateIndex: the financial purge tests whether a deposit still references a user by owner_id (AAP 0.5.2)
CREATE INDEX "deposit_owner_id_idx" ON "deposit"("owner_id");

-- CreateIndex: the 180-day reason-text clearance ranges over created_at (AAP 0.5.2)
CREATE INDEX "report_created_at_idx" ON "report"("created_at");

-- CreateIndex: the daily purge deletes stripe_event rows by received_at, the webhook dedupe clock (AAP 0.5.2)
CREATE INDEX "stripe_event_received_at_idx" ON "stripe_event"("received_at");

-- CreateIndex: the 365-day audit purge ranges over accessed_at (AAP 0.5.2)
CREATE INDEX "operator_access_log_accessed_at_idx" ON "operator_access_log"("accessed_at");

-- CreateIndex: the 365-day call-metadata purge selects tasks by kind (AAP 0.5.2)
CREATE INDEX "call_task_kind_idx" ON "call_task"("kind");

-- Hand-added: a constraint Prisma 6 cannot express (keep on every later migration)
-- Prisma does not model check constraints. Any later `prisma migrate dev` / `prisma migrate diff` output that
-- proposes dropping this object must have its drop removed before commit.

-- Money is always integer USD cents, and no amount is negative (AAP 0.11.1). The shared Zod schemas and the Int
-- column types bound every application write; this is the database's own refusal, which raw SQL reaches.
ALTER TABLE "price_record" ADD CONSTRAINT "price_record_amount_nonnegative_chk" CHECK ("local_amount_minor" >= 0 AND "price_usd_cents" >= 0);
