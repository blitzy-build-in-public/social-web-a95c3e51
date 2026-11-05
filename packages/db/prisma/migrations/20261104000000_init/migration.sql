-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('traveler', 'operator');

-- CreateEnum
CREATE TYPE "meetup_status" AS ENUM ('proposed', 'locked', 'declined', 'lapsed', 'cancelled', 'completed', 'forfeited', 'unattended', 'lock_lost', 'no_fault');

-- CreateEnum
CREATE TYPE "cancel_reason" AS ENUM ('initiator', 'recipient', 'block', 'account_deleted');

-- CreateEnum
CREATE TYPE "forfeit_reason" AS ENUM ('no_show', 'late_cancel');

-- CreateEnum
CREATE TYPE "variant" AS ENUM ('social', 'punitive');

-- CreateEnum
CREATE TYPE "variant_pairing" AS ENUM ('social', 'punitive', 'mixed');

-- CreateEnum
CREATE TYPE "participant_role" AS ENUM ('initiator', 'recipient');

-- CreateEnum
CREATE TYPE "deposit_status" AS ENUM ('pending', 'requires_action', 'held', 'failed', 'released', 'captured', 'expired', 'refunded');

-- CreateEnum
CREATE TYPE "payment_operation_kind" AS ENUM ('hold', 'release', 'capture', 'refund', 'delete_customer');

-- CreateEnum
CREATE TYPE "payment_operation_status" AS ENUM ('pending', 'executing', 'succeeded', 'failed_retryable', 'failed_terminal', 'fenced');

-- CreateEnum
CREATE TYPE "outbox_kind" AS ENUM ('notification', 'apply_call_result', 'create_call_task', 'account_erasure');

-- CreateEnum
CREATE TYPE "check_in_result" AS ENUM ('pass', 'fail');

-- CreateEnum
CREATE TYPE "distance_bucket" AS ENUM ('lt_50', 'm50_150');

-- CreateEnum
CREATE TYPE "settlement_outcome" AS ENUM ('completed', 'no_show', 'late_cancel', 'unattended');

-- CreateEnum
CREATE TYPE "settlement_status" AS ENUM ('applying', 'complete');

-- CreateEnum
CREATE TYPE "dispute_kind" AS ENUM ('venue_unavailable', 'other');

-- CreateEnum
CREATE TYPE "dispute_status" AS ENUM ('open', 'resolved');

-- CreateEnum
CREATE TYPE "dispute_outcome" AS ENUM ('settle_by_checkins', 'no_fault');

-- CreateEnum
CREATE TYPE "dispute_resolution_note" AS ENUM ('cancelled_by_block', 'hold_expired');

-- CreateEnum
CREATE TYPE "credit_kind" AS ENUM ('grant', 'void');

-- CreateEnum
CREATE TYPE "stripe_event_status" AS ENUM ('received', 'processed');

-- CreateEnum
CREATE TYPE "push_platform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "place_category" AS ENUM ('restaurant', 'cafe', 'bar', 'activity');

-- CreateEnum
CREATE TYPE "item_category" AS ENUM ('main', 'starter', 'dessert', 'drink', 'ticket');

-- CreateEnum
CREATE TYPE "ticket_type" AS ENUM ('standard', 'concession', 'group');

-- CreateEnum
CREATE TYPE "price_source" AS ENUM ('online_menu', 'phone_quote', 'operator_entry');

-- CreateEnum
CREATE TYPE "review_status" AS ENUM ('approved', 'needs_review');

-- CreateEnum
CREATE TYPE "crawl_decision" AS ENUM ('allowed', 'prohibited', 'uncertain');

-- CreateEnum
CREATE TYPE "call_task_kind" AS ENUM ('menu_prices', 'lodging_stay_verification');

-- CreateEnum
CREATE TYPE "call_task_status" AS ENUM ('queued', 'in_progress', 'completed', 'needs_review', 'refused', 'do_not_call', 'unreachable', 'cancelled');

-- CreateEnum
CREATE TYPE "blocked_reason" AS ENUM ('not_allowlisted', 'no_phone', 'do_not_call', 'invalid_number', 'vendor_unavailable', 'dispatch_unknown', 'no_final_status');

-- CreateEnum
CREATE TYPE "resolved_by" AS ENUM ('agent', 'operator');

-- CreateEnum
CREATE TYPE "call_attempt_state" AS ENUM ('dispatching', 'dispatch_unknown', 'dispatch_failed', 'dialing', 'in_progress', 'ended');

-- CreateEnum
CREATE TYPE "call_attempt_outcome" AS ENUM ('completed', 'no_answer', 'refused', 'do_not_call', 'unreachable', 'needs_review');

-- CreateEnum
CREATE TYPE "confidence" AS ENUM ('high', 'low');

-- CreateEnum
CREATE TYPE "lodging_kind" AS ENUM ('hostel', 'hotel', 'guesthouse');

-- CreateEnum
CREATE TYPE "phone_source" AS ENUM ('osm', 'operator');

-- CreateEnum
CREATE TYPE "lodging_claim_status" AS ENUM ('pending_call', 'calling', 'verified', 'rejected', 'unreachable');

-- CreateEnum
CREATE TYPE "operator_access_purpose" AS ENUM ('manual_verification_call');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email_ciphertext" TEXT,
    "email_lookup_hash" TEXT,
    "handle" TEXT,
    "avatar_seed" TEXT,
    "home_city" VARCHAR(80),
    "home_country_code" CHAR(2),
    "role" "user_role" NOT NULL DEFAULT 'traveler',
    "age_confirmed_at" TIMESTAMPTZ(6),
    "terms_version" TEXT,
    "stripe_customer_id" TEXT,
    "deletion_requested_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "previous_refresh_token_hash" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "rotated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "magic_link_token" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email_ciphertext" TEXT NOT NULL,
    "email_lookup_hash" TEXT NOT NULL,
    "delivery_token_ciphertext" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "magic_link_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "city" (
    "id" TEXT NOT NULL,
    "circuit_city_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "timezone" TEXT NOT NULL,
    "call_language" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "centroid" geography(Point,4326),
    "bbox" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "city_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue" (
    "id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "place_id" UUID,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "location" geography(Point,4326),
    "is_active_partner" BOOLEAN NOT NULL DEFAULT true,
    "is_fixture" BOOLEAN NOT NULL DEFAULT false,
    "secret_lookup_hash" TEXT,
    "secret_ciphertext" TEXT,
    "secret_issued_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "itinerary_proof" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "arrival_date" DATE NOT NULL,
    "departure_date" DATE NOT NULL,
    "issuer_id" BIGINT NOT NULL,
    "nullifier" TEXT NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6) NOT NULL,
    "registry_root" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "itinerary_proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spent_nullifier" (
    "nullifier" TEXT NOT NULL,
    "spent_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "spent_nullifier_pkey" PRIMARY KEY ("nullifier")
);

-- CreateTable
CREATE TABLE "meetup" (
    "id" UUID NOT NULL,
    "initiator_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "deposit_cents" INTEGER NOT NULL,
    "status" "meetup_status" NOT NULL DEFAULT 'proposed',
    "cancel_reason" "cancel_reason",
    "forfeit_reason" "forfeit_reason",
    "variant_pairing" "variant_pairing" NOT NULL,
    "locked_at" TIMESTAMPTZ(6),
    "proposal_visible_at" TIMESTAMPTZ(6),
    "recipient_deadline" TIMESTAMPTZ(6),
    "recipient_viewed_at" TIMESTAMPTZ(6),
    "recipient_accepted_at" TIMESTAMPTZ(6),
    "both_checked_in_at" TIMESTAMPTZ(6),
    "suggestions_first_viewed_at" TIMESTAMPTZ(6),
    "budget_cents" INTEGER,
    "budget_updated_by" UUID,
    "settled_at" TIMESTAMPTZ(6),
    "final_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meetup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit" (
    "id" UUID NOT NULL,
    "meetup_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "role" "participant_role" NOT NULL,
    "status" "deposit_status" NOT NULL DEFAULT 'pending',
    "amount_cents" INTEGER NOT NULL,
    "current_attempt" INTEGER NOT NULL DEFAULT 1,
    "current_payment_intent_id" TEXT,
    "capture_before" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_operation" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "deposit_id" UUID,
    "kind" "payment_operation_kind" NOT NULL,
    "attempt" INTEGER,
    "seq" INTEGER NOT NULL,
    "depends_on_id" UUID,
    "payment_intent_id" TEXT,
    "stripe_customer_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "status" "payment_operation_status" NOT NULL DEFAULT 'pending',
    "claimed_at" TIMESTAMPTZ(6),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" UUID NOT NULL,
    "kind" "outbox_kind" NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(6),
    "tries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_in" (
    "id" UUID NOT NULL,
    "meetup_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "result" "check_in_result" NOT NULL,
    "distance_bucket" "distance_bucket",
    "failure_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_in_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "witness_event" (
    "id" UUID NOT NULL,
    "meetup_id" UUID,
    "user_id" UUID NOT NULL,
    "counterpart_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,
    "counts_for_reputation" BOOLEAN NOT NULL,

    CONSTRAINT "witness_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pair_history" (
    "user_low_id" UUID NOT NULL,
    "user_high_id" UUID NOT NULL,
    "completed_count" INTEGER NOT NULL DEFAULT 0,
    "first_completed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_completed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pair_history_pkey" PRIMARY KEY ("user_low_id","user_high_id")
);

-- CreateTable
CREATE TABLE "meetup_settlement" (
    "meetup_id" UUID NOT NULL,
    "outcome" "settlement_outcome" NOT NULL,
    "status" "settlement_status" NOT NULL DEFAULT 'applying',
    "initiator_present" BOOLEAN NOT NULL,
    "recipient_present" BOOLEAN NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "meetup_settlement_pkey" PRIMARY KEY ("meetup_id")
);

-- CreateTable
CREATE TABLE "disclosure_profile" (
    "user_id" UUID NOT NULL,
    "interest_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nickname" VARCHAR(40),
    "bio" VARCHAR(280),
    "full_name_ciphertext" TEXT,
    "external_contact_ciphertext" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "disclosure_profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "profile_photo" (
    "user_id" UUID NOT NULL,
    "webp" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_photo_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL,
    "meetup_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute" (
    "id" UUID NOT NULL,
    "meetup_id" UUID NOT NULL,
    "filed_by_id" UUID NOT NULL,
    "kind" "dispute_kind" NOT NULL DEFAULT 'other',
    "reason" VARCHAR(500) NOT NULL,
    "status" "dispute_status" NOT NULL DEFAULT 'open',
    "outcome" "dispute_outcome",
    "resolution_note" "dispute_resolution_note",
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "escalated_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "block" (
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "block_pkey" PRIMARY KEY ("blocker_id","blocked_id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reported_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "meetup_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_credit_entry" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "meetup_id" UUID NOT NULL,
    "kind" "credit_kind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_credit_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_assignment" (
    "assignment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "variant" "variant" NOT NULL,
    "share_at_assignment" DOUBLE PRECISION NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "experiment_assignment_pkey" PRIMARY KEY ("assignment_id")
);

-- CreateTable
CREATE TABLE "analytics_event" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "actor_hash" TEXT,
    "city_id" TEXT,
    "variant" "variant",
    "assignment_id" UUID,
    "meetup_id" UUID,
    "props" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "analytics_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "push_platform" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_event" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "stripe_event_status" NOT NULL DEFAULT 'received',
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "stripe_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_callback_event" (
    "id" UUID NOT NULL,
    "call_attempt_id" UUID NOT NULL,
    "call_sid" TEXT NOT NULL,
    "call_status" TEXT NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "voice_callback_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "place" (
    "id" UUID NOT NULL,
    "osm_type" TEXT,
    "osm_id" BIGINT,
    "city_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "place_category" NOT NULL,
    "location" geography(Point,4326),
    "website" TEXT,
    "menu_url" TEXT,
    "phone" TEXT,
    "opening_hours" TEXT,
    "do_not_call" BOOLEAN NOT NULL DEFAULT false,
    "is_fixture" BOOLEAN NOT NULL DEFAULT false,
    "nearest_partner_distance_m" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_record" (
    "id" UUID NOT NULL,
    "place_id" UUID NOT NULL,
    "capture_batch_id" UUID NOT NULL,
    "item_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "item_category" "item_category" NOT NULL,
    "alcoholic" BOOLEAN,
    "per_person" BOOLEAN,
    "ticket_type" "ticket_type",
    "price_text" TEXT NOT NULL,
    "local_amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "price_usd_cents" INTEGER NOT NULL,
    "source" "price_source" NOT NULL,
    "source_url" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "fx_date" DATE NOT NULL,
    "confidence" "confidence",
    "review_status" "review_status" NOT NULL DEFAULT 'approved',
    "is_fixture" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "price_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_domain_policy" (
    "domain" TEXT NOT NULL,
    "decision" "crawl_decision" NOT NULL,
    "reason" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "overridden_by" TEXT,

    CONSTRAINT "crawl_domain_policy_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "lodging_activity_fact" (
    "id" UUID NOT NULL,
    "lodging_id" UUID NOT NULL,
    "meetup_id" UUID NOT NULL,
    "pair_key" TEXT NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lodging_activity_fact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_access_log" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "lodging_claim_id" UUID NOT NULL,
    "accessed_at" TIMESTAMPTZ(6) NOT NULL,
    "purpose" "operator_access_purpose" NOT NULL,

    CONSTRAINT "operator_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rate" (
    "date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "usd_per_unit" DECIMAL(20,10) NOT NULL,

    CONSTRAINT "fx_rate_pkey" PRIMARY KEY ("date","currency")
);

-- CreateTable
CREATE TABLE "call_task" (
    "id" UUID NOT NULL,
    "kind" "call_task_kind" NOT NULL,
    "place_id" UUID,
    "lodging_id" UUID,
    "lodging_claim_id" UUID,
    "status" "call_task_status" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "vendor_failures" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "outcome_at" TIMESTAMPTZ(6),
    "blocked_reason" "blocked_reason",
    "priority" INTEGER NOT NULL DEFAULT 0,
    "resolved_by" "resolved_by",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "call_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_attempt" (
    "id" UUID NOT NULL,
    "call_task_id" UUID NOT NULL,
    "twilio_call_sid" TEXT,
    "state" "call_attempt_state" NOT NULL DEFAULT 'dispatching',
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "twilio_final_status" TEXT,
    "outcome" "call_attempt_outcome",
    "extracted_fields" JSONB,
    "summary" TEXT,
    "confidence" "confidence",
    "transcript" TEXT,
    "transcript_delete_at" TIMESTAMPTZ(6),
    "duration_sec" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "llm_reserved_micros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "call_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_budget_day" (
    "city_id" TEXT NOT NULL,
    "local_date" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "llm_spend_micros" BIGINT NOT NULL DEFAULT 0,
    "llm_reserved_micros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "call_budget_day_pkey" PRIMARY KEY ("city_id","local_date")
);

-- CreateTable
CREATE TABLE "lodging" (
    "id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "osm_type" TEXT,
    "osm_id" BIGINT,
    "name" TEXT NOT NULL,
    "kind" "lodging_kind" NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "phone_source" "phone_source" NOT NULL DEFAULT 'osm',
    "location" geography(Point,4326),
    "do_not_call" BOOLEAN NOT NULL DEFAULT false,
    "is_fixture" BOOLEAN NOT NULL DEFAULT false,
    "osm_missing_at" TIMESTAMPTZ(6),
    "secret_lookup_hash" TEXT,
    "secret_ciphertext" TEXT,
    "secret_issued_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lodging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lodging_claim" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "lodging_id" UUID NOT NULL,
    "stay_from" DATE NOT NULL,
    "stay_to" DATE NOT NULL,
    "booking_name_ciphertext" TEXT,
    "booking_reference_ciphertext" TEXT,
    "call_consent_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "lodging_claim_status" NOT NULL DEFAULT 'pending_call',
    "resolved_at" TIMESTAMPTZ(6),
    "details_erased_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lodging_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lodging_visibility" (
    "user_id" UUID NOT NULL,
    "lodging_claim_id" UUID NOT NULL,
    "show_staying" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lodging_visibility_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_lookup_hash_key" ON "user"("email_lookup_hash");

-- CreateIndex
CREATE UNIQUE INDEX "user_handle_key" ON "user"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "session_refresh_token_hash_key" ON "session"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "session_previous_refresh_token_hash_key" ON "session"("previous_refresh_token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "magic_link_token_token_hash_key" ON "magic_link_token"("token_hash");

-- CreateIndex
CREATE INDEX "magic_link_token_email_lookup_hash_created_at_idx" ON "magic_link_token"("email_lookup_hash", "created_at");

-- CreateIndex
CREATE INDEX "magic_link_token_expires_at_idx" ON "magic_link_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "city_circuit_city_id_key" ON "city"("circuit_city_id");

-- CreateIndex
CREATE INDEX "city_centroid_idx" ON "city" USING GIST ("centroid");

-- CreateIndex
CREATE UNIQUE INDEX "venue_secret_lookup_hash_key" ON "venue"("secret_lookup_hash");

-- CreateIndex
CREATE INDEX "venue_location_idx" ON "venue" USING GIST ("location");

-- CreateIndex
CREATE INDEX "venue_city_id_is_active_partner_idx" ON "venue"("city_id", "is_active_partner");

-- CreateIndex
CREATE UNIQUE INDEX "itinerary_proof_nullifier_key" ON "itinerary_proof"("nullifier");

-- CreateIndex
CREATE INDEX "itinerary_proof_city_id_valid_to_idx" ON "itinerary_proof"("city_id", "valid_to");

-- CreateIndex
CREATE INDEX "itinerary_proof_user_id_idx" ON "itinerary_proof"("user_id");

-- CreateIndex
CREATE INDEX "meetup_status_starts_at_idx" ON "meetup"("status", "starts_at");

-- CreateIndex
CREATE INDEX "meetup_initiator_id_idx" ON "meetup"("initiator_id");

-- CreateIndex
CREATE INDEX "meetup_recipient_id_idx" ON "meetup"("recipient_id");

-- CreateIndex
CREATE INDEX "meetup_venue_id_idx" ON "meetup"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_current_payment_intent_id_key" ON "deposit"("current_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_meetup_id_owner_id_key" ON "deposit"("meetup_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_operation_idempotency_key_key" ON "payment_operation"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_operation_deposit_id_seq_idx" ON "payment_operation"("deposit_id", "seq");

-- CreateIndex
CREATE INDEX "payment_operation_payment_intent_id_idx" ON "payment_operation"("payment_intent_id");

-- CreateIndex
CREATE INDEX "payment_operation_status_idx" ON "payment_operation"("status");

-- CreateIndex
CREATE INDEX "check_in_meetup_id_idx" ON "check_in"("meetup_id");

-- CreateIndex
CREATE INDEX "witness_event_user_id_completed_at_idx" ON "witness_event"("user_id", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "witness_event_meetup_id_user_id_key" ON "witness_event"("meetup_id", "user_id");

-- CreateIndex
CREATE INDEX "message_meetup_id_created_at_idx" ON "message"("meetup_id", "created_at");

-- CreateIndex
CREATE INDEX "dispute_status_deadline_at_idx" ON "dispute"("status", "deadline_at");

-- CreateIndex
CREATE INDEX "block_blocked_id_idx" ON "block"("blocked_id");

-- CreateIndex
CREATE INDEX "table_credit_entry_user_id_idx" ON "table_credit_entry"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "table_credit_entry_meetup_id_user_id_kind_key" ON "table_credit_entry"("meetup_id", "user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_assignment_user_id_key" ON "experiment_assignment"("user_id");

-- CreateIndex
CREATE INDEX "analytics_event_name_occurred_at_idx" ON "analytics_event"("name", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_event_actor_hash_idx" ON "analytics_event"("actor_hash");

-- CreateIndex
CREATE UNIQUE INDEX "push_token_token_key" ON "push_token"("token");

-- CreateIndex
CREATE UNIQUE INDEX "voice_callback_event_call_sid_call_status_sequence_number_key" ON "voice_callback_event"("call_sid", "call_status", "sequence_number");

-- CreateIndex
CREATE INDEX "place_location_idx" ON "place" USING GIST ("location");

-- CreateIndex
CREATE INDEX "place_city_id_idx" ON "place"("city_id");

-- CreateIndex
CREATE UNIQUE INDEX "place_osm_type_osm_id_key" ON "place"("osm_type", "osm_id");

-- CreateIndex
CREATE INDEX "price_record_place_id_source_captured_at_idx" ON "price_record"("place_id", "source", "captured_at");

-- CreateIndex
CREATE INDEX "lodging_activity_fact_lodging_id_completed_at_idx" ON "lodging_activity_fact"("lodging_id", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "lodging_activity_fact_lodging_id_meetup_id_key" ON "lodging_activity_fact"("lodging_id", "meetup_id");

-- CreateIndex
CREATE INDEX "call_task_status_next_attempt_at_idx" ON "call_task"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "call_task_place_id_idx" ON "call_task"("place_id");

-- CreateIndex
CREATE INDEX "call_task_lodging_id_idx" ON "call_task"("lodging_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_attempt_twilio_call_sid_key" ON "call_attempt"("twilio_call_sid");

-- CreateIndex
CREATE INDEX "call_attempt_call_task_id_idx" ON "call_attempt"("call_task_id");

-- CreateIndex
CREATE INDEX "call_attempt_state_idx" ON "call_attempt"("state");

-- CreateIndex
CREATE UNIQUE INDEX "lodging_secret_lookup_hash_key" ON "lodging"("secret_lookup_hash");

-- CreateIndex
CREATE INDEX "lodging_location_idx" ON "lodging" USING GIST ("location");

-- CreateIndex
CREATE INDEX "lodging_city_id_idx" ON "lodging"("city_id");

-- CreateIndex
CREATE UNIQUE INDEX "lodging_osm_type_osm_id_key" ON "lodging"("osm_type", "osm_id");

-- CreateIndex
CREATE INDEX "lodging_claim_user_id_status_idx" ON "lodging_claim"("user_id", "status");

-- CreateIndex
CREATE INDEX "lodging_claim_lodging_id_status_idx" ON "lodging_claim"("lodging_id", "status");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue" ADD CONSTRAINT "venue_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue" ADD CONSTRAINT "venue_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "place"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_proof" ADD CONSTRAINT "itinerary_proof_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_proof" ADD CONSTRAINT "itinerary_proof_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetup" ADD CONSTRAINT "meetup_initiator_id_fkey" FOREIGN KEY ("initiator_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetup" ADD CONSTRAINT "meetup_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetup" ADD CONSTRAINT "meetup_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit" ADD CONSTRAINT "deposit_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "meetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit" ADD CONSTRAINT "deposit_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_operation" ADD CONSTRAINT "payment_operation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_operation" ADD CONSTRAINT "payment_operation_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "meetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "witness_event" ADD CONSTRAINT "witness_event_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "meetup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "witness_event" ADD CONSTRAINT "witness_event_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetup_settlement" ADD CONSTRAINT "meetup_settlement_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "meetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disclosure_profile" ADD CONSTRAINT "disclosure_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_photo" ADD CONSTRAINT "profile_photo_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "meetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "meetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_filed_by_id_fkey" FOREIGN KEY ("filed_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block" ADD CONSTRAINT "block_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block" ADD CONSTRAINT "block_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "meetup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_credit_entry" ADD CONSTRAINT "table_credit_entry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_credit_entry" ADD CONSTRAINT "table_credit_entry_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "meetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignment" ADD CONSTRAINT "experiment_assignment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_callback_event" ADD CONSTRAINT "voice_callback_event_call_attempt_id_fkey" FOREIGN KEY ("call_attempt_id") REFERENCES "call_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place" ADD CONSTRAINT "place_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_record" ADD CONSTRAINT "price_record_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lodging_activity_fact" ADD CONSTRAINT "lodging_activity_fact_lodging_id_fkey" FOREIGN KEY ("lodging_id") REFERENCES "lodging"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_access_log" ADD CONSTRAINT "operator_access_log_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_task" ADD CONSTRAINT "call_task_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_task" ADD CONSTRAINT "call_task_lodging_id_fkey" FOREIGN KEY ("lodging_id") REFERENCES "lodging"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_task" ADD CONSTRAINT "call_task_lodging_claim_id_fkey" FOREIGN KEY ("lodging_claim_id") REFERENCES "lodging_claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_attempt" ADD CONSTRAINT "call_attempt_call_task_id_fkey" FOREIGN KEY ("call_task_id") REFERENCES "call_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lodging" ADD CONSTRAINT "lodging_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lodging_claim" ADD CONSTRAINT "lodging_claim_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lodging_claim" ADD CONSTRAINT "lodging_claim_lodging_id_fkey" FOREIGN KEY ("lodging_id") REFERENCES "lodging"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lodging_visibility" ADD CONSTRAINT "lodging_visibility_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lodging_visibility" ADD CONSTRAINT "lodging_visibility_lodging_claim_id_fkey" FOREIGN KEY ("lodging_claim_id") REFERENCES "lodging_claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-added: constraints Prisma 6 cannot express (keep on every later migration)
-- Prisma does not model partial/expression indexes or check constraints. Any later `prisma migrate dev` /
-- `prisma migrate diff` output that proposes dropping these objects must have their drops removed before commit.

-- One open (proposed or locked) meetup per pair, in either initiator/recipient order (AAP 0.5.2; 409 meetup_exists)
CREATE UNIQUE INDEX "meetup_open_pair_key" ON "meetup" (LEAST("initiator_id", "recipient_id"), GREATEST("initiator_id", "recipient_id")) WHERE "status" IN ('proposed', 'locked');

-- One pass check-in per attendee per meetup; fail rows are unrestricted (AAP 0.5.2; 409 already_checked_in)
CREATE UNIQUE INDEX "check_in_pass_key" ON "check_in" ("meetup_id", "user_id") WHERE "result" = 'pass';

-- One open dispute per meetup (AAP 0.5.2; 409 dispute_open)
CREATE UNIQUE INDEX "dispute_open_key" ON "dispute" ("meetup_id") WHERE "status" = 'open';

-- Outbox dispatcher poll over undispatched rows, every 2 s (AAP 0.3.2, 0.5.2)
CREATE INDEX "outbox_message_undispatched_idx" ON "outbox_message" ("created_at") WHERE "dispatched_at" IS NULL;

-- A call task targets exactly one of place or lodging (AAP 0.5.2)
ALTER TABLE "call_task" ADD CONSTRAINT "call_task_one_target_chk" CHECK (num_nonnulls("place_id", "lodging_id") = 1);
