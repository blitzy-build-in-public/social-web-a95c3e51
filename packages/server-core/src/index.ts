/**
 * The server-core barrel: the server-only utilities shared by `apps/api`, `apps/workers` and
 * `packages/db/seed` (AAP 0.3.2) — the injected clock, the redacting logger, city-local time,
 * field encryption and hashing, the queue names, payload schemas, connections and job defaults,
 * the Twilio client and its call allowlist, the language-model adapter with its spend reservation,
 * and the per-process environment schemas.
 *
 * It is resolved only by Node processes. `apps/mobile` and `apps/venue-console` never import it,
 * which is what keeps the field-encryption keys, the Stripe secret, the Twilio credentials and the
 * provider SDKs out of a client bundle.
 *
 * Re-exports only: no renamed export, no default export, no top-level statement. Loading the barrel
 * therefore opens no Redis connection, reads no environment variable and constructs no SDK client.
 * Every exported name is unique across the modules below, because a duplicate would make the star
 * exports ambiguous (TS2308); a new collision is renamed at its source module, never aliased here.
 */

export * from './clock.ts';
export * from './logger.ts';
export * from './time/city-time.ts';

export * from './crypto/field-encryption.ts';
export * from './crypto/hashing.ts';

export * from './queues/names.ts';
export * from './queues/payloads.ts';
export * from './queues/connection.ts';
export * from './queues/defaults.ts';

export * from './telephony/twilio-client.ts';
export * from './telephony/allowlist.ts';

export * from './llm/adapter.ts';
export * from './llm/openai.ts';
export * from './llm/fake.ts';
export * from './llm/spend.ts';

export * from './env/common.ts';
export * from './env/modes.ts';
export * from './env/api.ts';
export * from './env/workers.ts';
