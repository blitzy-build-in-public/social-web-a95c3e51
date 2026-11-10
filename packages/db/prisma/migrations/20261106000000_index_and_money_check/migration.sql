-- Why this is a new migration directory rather than an edit of 20261104000000_init: that migration is already
-- applied in every database of this run and `prisma migrate deploy` skips an applied migration by name, so a change
-- appended to it can never reach an existing database.
--
-- Two kinds of object live here: the single-column indexes the retention, metric and reference-check predicates
-- need, which the datamodel also declares and which a new directory is the only way to add once the init directory
-- is applied; and a check constraint on the money columns, which Prisma 6.19.3 cannot express at all.

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

-- CreateIndex: the suggestions candidate statement runs a correlated EXISTS on place_id per candidate place (AAP 0.5.7)
CREATE INDEX "venue_place_id_idx" ON "venue"("place_id");

-- CreateIndex: the tombstone reference checks and the executor's user scope read operations by user_id (AAP 0.5.2)
CREATE INDEX "payment_operation_user_id_idx" ON "payment_operation"("user_id");

-- CreateIndex: the tombstone reference checks ask whether a message still references a user by sender_id (AAP 0.5.2)
CREATE INDEX "message_sender_id_idx" ON "message"("sender_id");

-- CreateIndex: the tombstone reference checks ask whether a dispute still references a user by filed_by_id (AAP 0.5.2)
CREATE INDEX "dispute_filed_by_id_idx" ON "dispute"("filed_by_id");

-- CreateIndex: the tombstone reference checks ask whether a report still names a user by reporter_id (AAP 0.5.2)
CREATE INDEX "report_reporter_id_idx" ON "report"("reporter_id");

-- CreateIndex: the same checks ask it by reported_id, the other side of the same row (AAP 0.5.2)
CREATE INDEX "report_reported_id_idx" ON "report"("reported_id");

-- CreateIndex: the financial purge nulls the meetup link on reports whose meetup it deletes (AAP 0.5.2)
CREATE INDEX "report_meetup_id_idx" ON "report"("meetup_id");

-- CreateIndex: notifications read push_token by user_id on every send (AAP 0.5.6)
CREATE INDEX "push_token_user_id_idx" ON "push_token"("user_id");

-- CreateIndex: the metadata strip deletes a call's callbacks by call_attempt_id (AAP 0.5.2)
CREATE INDEX "voice_callback_event_call_attempt_id_idx" ON "voice_callback_event"("call_attempt_id");

-- CreateIndex: the tombstone reference checks ask whether the log still references a user by operator_id (AAP 0.5.2)
CREATE INDEX "operator_access_log_operator_id_idx" ON "operator_access_log"("operator_id");

-- CreateIndex: the tombstone reference checks ask whether a check-in still references a user by user_id (AAP 0.5.2)
CREATE INDEX "check_in_user_id_idx" ON "check_in"("user_id");

-- CreateIndex: both claim-resolution paths read call_task by lodging_claim_id (AAP 0.5.3)
CREATE INDEX "call_task_lodging_claim_id_idx" ON "call_task"("lodging_claim_id");

-- CreateIndex: the claim read joins visibility by lodging_claim_id, and the strip step updates it by the same column (AAP 0.5.2, 0.5.7)
CREATE INDEX "lodging_visibility_lodging_claim_id_idx" ON "lodging_visibility"("lodging_claim_id");

-- CreateIndex: a do-not-call reply looks up every place sharing the caller's number by phone (AAP 0.5.3, 0.5.6)
CREATE INDEX "place_phone_idx" ON "place"("phone");

-- CreateIndex: a do-not-call reply looks up every lodging sharing the caller's number by phone (AAP 0.5.3, 0.5.6)
CREATE INDEX "lodging_phone_idx" ON "lodging"("phone");

-- CreateIndex: the outcome metric ranges over outcome_at and the operator queue orders by it (AAP 0.5.7)
CREATE INDEX "call_task_outcome_at_idx" ON "call_task"("outcome_at");

-- CreateIndex: the metric ranges filter occurred_at alone, which the composite (name, occurred_at) cannot serve (AAP 0.5.7)
CREATE INDEX "analytics_event_occurred_at_idx" ON "analytics_event"("occurred_at");

-- CreateIndex: the 7-year financial purge selects the batch it deletes by ranging over final_at (AAP 0.5.2)
CREATE INDEX "meetup_final_at_idx" ON "meetup"("final_at");

-- CreateIndex: the 30-day transcript clearance ranges over transcript_delete_at (AAP 0.5.2)
CREATE INDEX "call_attempt_transcript_delete_at_idx" ON "call_attempt"("transcript_delete_at");

-- CreateIndex: the 120-day fact purge ranges over completed_at alone, which the composite (lodging_id, completed_at) cannot serve (AAP 0.5.2)
CREATE INDEX "lodging_activity_fact_completed_at_idx" ON "lodging_activity_fact"("completed_at");

-- Hand-added: a constraint Prisma 6 cannot express (keep on every later migration)
-- Prisma does not model check constraints. Any later `prisma migrate dev` / `prisma migrate diff` output that
-- proposes dropping this object must have its drop removed before commit.

-- Money is always integer USD cents, and no amount is negative (AAP 0.11.1). The shared Zod schemas and the Int
-- column types bound every application write; this is the database's own refusal, which raw SQL reaches.
ALTER TABLE "price_record" ADD CONSTRAINT "price_record_amount_nonnegative_chk" CHECK ("local_amount_minor" >= 0 AND "price_usd_cents" >= 0);
