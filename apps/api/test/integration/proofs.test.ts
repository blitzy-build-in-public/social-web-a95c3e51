/**
 * Criterion 3 for the itinerary proof, and the public `GET /v1/zk/config`.
 *
 * Every case proves a committed `.eml` fixture the way a phone proves one and submits only
 * `{ proof, publicSignals }`, the sole thing the server ever receives about a booking confirmation: a
 * genuine proof is accepted once and stored as the stay it proves, the same booking cannot be proved
 * again, and every way of departing from the contract is refused with the code the contract names. A
 * tampered email is unprovable rather than merely unaccepted, because the input generator refuses it
 * before a witness exists.
 *
 * It does not skip — a missing artefact fails by naming `pnpm circuits:build` — and it does not prove
 * on the server: the harness is in the client's role, and the stored rows are audited by column.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CircuitInputError } from '@tablemate/circuits';
import { addLocalDays, endOfLocalDay, startOfLocalDay } from '@tablemate/server-core';
import {
  ArtifactsManifest,
  IssuerConfig,
  PROOF_VALID_FROM_DAYS_BEFORE,
  PUBLIC_SIGNAL_NAMES,
  ProofAccepted,
  RegistryFile,
  ZkConfig,
} from '@tablemate/shared';

import { cityByCircuitId } from '../../src/modules/proofs/registry.ts';
import { createTestApp, TEST_NULLIFIER_SALT, type TestApp } from '../support/app.ts';
import { callRoute, expectError, makeUser, rows } from '../support/factories.ts';
import {
  alterSignal,
  fixtureProof,
  fixtureStay,
  findRepoRoot,
  instantDuringStay,
  PROOF_TIMEOUT_MS,
} from '../support/proofs.ts';

import type { DbClient } from '@tablemate/db';
import type { CityConfig, ErrorCode, ErrorEnvelope, ProofSubmission } from '@tablemate/shared';
import type { FactoryContext, RouteResponse, UserFixture } from '../support/factories.ts';
import type { FixtureStay } from '../support/proofs.ts';

const PROOF_ROUTE = '/v1/itinerary-proofs';

const ZK_CONFIG_ROUTE = '/v1/zk/config';

/**
 * The salt the foreign-salt case proves the `valid` booking under: a short decimal field element
 * that is not the published {@link TEST_NULLIFIER_SALT}. The proof is genuine for the salt it names,
 * so Groth16 verification succeeds and the verifier's own salt check is what refuses it.
 *
 * Fixed rather than randomised, so the proof it names stays in `.local/test-proofs/` between runs.
 */
const FOREIGN_NULLIFIER_SALT = '7777777777777777';

const UNSUPPORTED_ISSUER_FILES = [
  'config/issuers/booking-com.json',
  'config/issuers/airbnb.json',
] as const;

const TEST_ISSUER_FILE = 'config/issuers/tablemate-test.json';

const REGISTRY_FILES = {
  production: 'config/registry/production.json',
  test: 'config/registry/test.json',
} as const;

/** The artefact manifest `pnpm circuits:build` writes; git-ignored, so it is read, never committed. */
const MANIFEST_FILE = 'packages/circuits/build/artifacts.manifest.json';

/**
 * Every column `itinerary_proof` may hold: the proof's public outputs, the ids and the stored
 * validity window. The audit fails on any column this list does not name.
 */
const ITINERARY_PROOF_COLUMNS: readonly string[] = [
  'arrival_date',
  'city_id',
  'created_at',
  'departure_date',
  'id',
  'issuer_id',
  'nullifier',
  'registry_root',
  'user_id',
  'valid_from',
  'valid_to',
];

/**
 * Every column `spent_nullifier` may hold: the key and when it was spent, and no user column at all —
 * the table outlives account erasure, so a deleted account cannot free a booking for reuse.
 */
const SPENT_NULLIFIER_COLUMNS: readonly string[] = ['nullifier', 'spent_at'];

interface MalformedRow {
  readonly name: string;
  readonly body: (proof: ProofSubmission) => object;
}

/**
 * The bodies that are not the contract's `ProofSubmission`, one per case: the strictness of both
 * object levels, the fixed signal count of seven, the proof's protocol, and the field-element shape
 * of a signal. The empty body is the smallest such submission — Fastify parses it and the schema
 * rejects it — which is why it is a `proof_malformed` row rather than a parser failure.
 */
const MALFORMED_SUBMISSIONS: readonly MalformedRow[] = [
  {
    name: 'an extra top-level key',
    body: (proof) => ({ ...submissionBody(proof), extra: 'not part of the contract' }),
  },
  {
    name: 'an extra key inside the proof',
    body: (proof) => ({
      proof: { ...proof.proof, extra: 'not part of the contract' },
      publicSignals: proof.publicSignals,
    }),
  },
  {
    name: 'six public signals',
    body: (proof) => ({
      proof: proof.proof,
      publicSignals: proof.publicSignals.slice(0, PUBLIC_SIGNAL_NAMES.length - 1),
    }),
  },
  {
    name: 'eight public signals',
    body: (proof) => ({ proof: proof.proof, publicSignals: [...proof.publicSignals, '0'] }),
  },
  {
    name: 'a proof of another protocol',
    body: (proof) => ({
      proof: { ...proof.proof, protocol: 'plonk' },
      publicSignals: proof.publicSignals,
    }),
  },
  {
    name: 'a signal that is not a field element',
    body: (proof) => ({
      proof: proof.proof,
      publicSignals: ['not-a-field-element', ...proof.publicSignals.slice(1)],
    }),
  },
  { name: 'an empty body', body: () => ({}) },
];

/**
 * The public signals by name and position, one case each. Altering any of them must answer
 * `422 proof_invalid`, and the position that makes that an assertion about the check *order* is
 * `registryRoot`: the altered root is not one this API publishes, so a server that resolved the
 * registry before verifying the proof would answer `422 issuer_not_allowlisted` instead.
 */
const SIGNAL_POSITIONS: readonly { readonly name: string; readonly index: number }[] =
  PUBLIC_SIGNAL_NAMES.map((name, index) => ({ name, index }));

/**
 * Read one committed JSON configuration file and parse it with its own schema, so every expectation
 * below is the configured value — an issuer id, a display name, a registry root — rather than one
 * written into this file.
 */
async function readConfig<T>(relative: string, schema: { parse(value: unknown): T }): Promise<T> {
  const text = await readFile(join(findRepoRoot(), relative), 'utf8');
  return schema.parse(JSON.parse(text) as unknown);
}

/**
 * The columns one table actually holds, from the catalog. This is what makes the storage cases
 * evidence rather than restatement: a column the migration adds shows up here.
 */
async function tableColumns(db: DbClient, table: string): Promise<string[]> {
  const held = await db.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return held.map((row) => row.column_name).sort();
}

/**
 * The launch city a proof's `cityId` signal names, resolved through the committed configuration the
 * registry was built from.
 */
function configuredCity(stay: FixtureStay): CityConfig {
  const city = cityByCircuitId(stay.circuitCityId);
  if (city === undefined) {
    throw new Error(`no configured city carries circuit city id ${stay.circuitCityId}`);
  }
  return city;
}

function submissionBody(submission: ProofSubmission): object {
  return { proof: submission.proof, publicSignals: [...submission.publicSignals] };
}

function submit(target: TestApp, user: UserFixture, body: object): Promise<RouteResponse> {
  return callRoute(target.app, { method: 'POST', url: PROOF_ROUTE, as: user, body });
}

function submitProof(
  target: TestApp,
  user: UserFixture,
  submission: ProofSubmission,
): Promise<RouteResponse> {
  return submit(target, user, submissionBody(submission));
}

/**
 * Assert an answer is the error envelope with `code`, at `status`, and return the envelope.
 *
 * The code is compared here as well as through the harness, so the refusal a case names cannot be
 * asserted by its HTTP status alone: a route answering another refusal's code with the same status
 * would otherwise pass.
 */
function expectCode(response: RouteResponse, status: number, code: ErrorCode): ErrorEnvelope {
  const envelope = expectError(response, status, code);
  expect(envelope.error.code).toBe(code);
  return envelope;
}

/**
 * The five proofs the cases submit: the `valid` booking at the published salt, the same booking
 * proved again (a different `pi_a`, the same nullifier), the second distinct booking, the
 * `other-issuer` fixture proved against a root this API does not publish, and the `valid` booking
 * under {@link FOREIGN_NULLIFIER_SALT}.
 */
interface FixtureSubmissions {
  readonly valid: ProofSubmission;
  readonly validAgain: ProofSubmission;
  readonly validSecond: ProofSubmission;
  readonly otherIssuer: ProofSubmission;
  readonly foreignSalt: ProofSubmission;
}

let app: TestApp;

let ctx: FactoryContext;

let submissions: FixtureSubmissions;

let published: { registry: RegistryFile; issuer: IssuerConfig };

/**
 * Prove the five fixtures in the order the cases read them, sequenced rather than gathered into one
 * `Promise.all`, because each proof reads a 1.6 GB proving key and holds it while it runs (AAP 0.11.2).
 */
async function proveFixtures(): Promise<FixtureSubmissions> {
  return {
    valid: await fixtureProof('valid'),
    validAgain: await fixtureProof('valid', { fresh: true }),
    validSecond: await fixtureProof('valid-second'),
    otherIssuer: await fixtureProof('other-issuer'),
    foreignSalt: await fixtureProof('valid', { salt: FOREIGN_NULLIFIER_SALT }),
  };
}

beforeAll(async () => {
  app = await createTestApp();
  ctx = { services: app.services, stripe: app.stripe, app: app.app };
  submissions = await proveFixtures();
  published = {
    registry: await readConfig(REGISTRY_FILES.test, RegistryFile),
    issuer: await readConfig(TEST_ISSUER_FILE, IssuerConfig),
  };
}, PROOF_TIMEOUT_MS);

beforeEach(async () => {
  await app.resetState();
  // The proof route stores a row that references a `City`, so the launch cities must exist; the
  // fixtures are not seeded, because no case here reads a venue, a lodging or a place.
  await app.seedCities();
  // Any instant works for acceptance, and standing inside the stay keeps the stored proof in force
  // rather than merely stored (AAP 0.5.7).
  app.time.at(instantDuringStay(submissions.valid));
});

afterAll(async () => {
  // A `beforeAll` that failed before assigning `app` must report its own error, not a second one here.
  if (app !== undefined) {
    await app.close();
  }
});

describe('POST /v1/itinerary-proofs (AAP 0.12.1 criterion 3)', () => {
  it('accepts a genuine booking confirmation and stores the stay it proves', async () => {
    const user = await makeUser(ctx, {});
    const response = await submitProof(app, user, submissions.valid);
    expect(response.status).toBe(201);
    const accepted = ProofAccepted.parse(response.json());
    const stay = fixtureStay(submissions.valid);
    const city = configuredCity(stay);
    expect(accepted.cityId).toBe(city.id);
    expect(accepted.arrivalDate).toBe(stay.arrivalDate);
    expect(accepted.departureDate).toBe(stay.departureDate);
    const row = await app.services.db.itineraryProof.findFirstOrThrow();
    expect(row.userId).toBe(user.id);
    expect(row.cityId).toBe(city.id);
    expect(row.arrivalDate.toISOString().slice(0, 10)).toBe(stay.arrivalDate);
    expect(row.departureDate.toISOString().slice(0, 10)).toBe(stay.departureDate);
    expect(row.issuerId).toBe(BigInt(published.issuer.issuerId));
    expect(BigInt(row.nullifier)).toBe(BigInt(stay.nullifier));
    expect(BigInt(row.registryRoot)).toBe(BigInt(published.registry.root));
    // The window is the city's own days, not UTC midnights: `validFrom` is two local days before the
    // arrival, so a traveler can prove shortly before getting there, and `validTo` is the end of the
    // departure day in the city's zone — stored rather than re-derived on every read (AAP 0.5.7).
    expect(row.validFrom).toEqual(
      startOfLocalDay(city.timezone, addLocalDays(stay.arrivalDate, -PROOF_VALID_FROM_DAYS_BEFORE)),
    );
    expect(row.validTo).toEqual(endOfLocalDay(city.timezone, stay.departureDate));
  });
  it('stores only the public outputs, the ids and the window, and the key to no account', async () => {
    await submitProof(app, await makeUser(ctx, {}), submissions.valid);
    expect(await tableColumns(app.services.db, 'itinerary_proof')).toEqual([
      ...ITINERARY_PROOF_COLUMNS,
    ]);
    expect(await tableColumns(app.services.db, 'spent_nullifier')).toEqual([
      ...SPENT_NULLIFIER_COLUMNS,
    ]);
    const spent = await app.services.db.spentNullifier.findMany();
    expect(spent.map((entry) => BigInt(entry.nullifier))).toEqual([
      BigInt(fixtureStay(submissions.valid).nullifier),
    ]);
  });
  it('accepts a second, distinct booking from another account', async () => {
    expect((await submitProof(app, await makeUser(ctx, {}), submissions.valid)).status).toBe(201);
    const response = await submitProof(app, await makeUser(ctx, {}), submissions.validSecond);
    expect(response.status).toBe(201);
    const stay = fixtureStay(submissions.validSecond);
    expect(ProofAccepted.parse(response.json()).arrivalDate).toBe(stay.arrivalDate);
    expect(stay.nullifier).not.toBe(fixtureStay(submissions.valid).nullifier);
    expect(await app.services.db.itineraryProof.count()).toBe(2);
  });
});

describe('POST /v1/itinerary-proofs refusals', () => {
  it.each(rows(MALFORMED_SUBMISSIONS))('answers 400 proof_malformed for $name', async (row) => {
    const response = await submit(app, await makeUser(ctx, {}), row.body(submissions.valid));
    expectCode(response, 400, 'proof_malformed');
    expect(await app.services.db.itineraryProof.count()).toBe(0);
  });
  it.each(rows(SIGNAL_POSITIONS))(
    'answers 422 proof_invalid when the $name signal is altered',
    async (row) => {
      const user = await makeUser(ctx, {});
      const response = await submitProof(app, user, alterSignal(submissions.valid, row.index));
      expectCode(response, 422, 'proof_invalid');
      expect(await app.services.db.itineraryProof.count()).toBe(0);
    },
  );
  it('answers 422 proof_invalid for a proof taken under another salt', async () => {
    const user = await makeUser(ctx, {});
    // Groth16 verifies — the proof is genuine for the salt it names — so the published salt is what
    // refuses it, which is why this case and the table above pin the verifier's check order.
    expectCode(await submitProof(app, user, submissions.foreignSalt), 422, 'proof_invalid');
  });
  it('answers 422 issuer_not_allowlisted for a key outside the published registry', async () => {
    const response = await submitProof(app, await makeUser(ctx, {}), submissions.otherIssuer);
    expectCode(response, 422, 'issuer_not_allowlisted');
    expect(await app.services.db.itineraryProof.count()).toBe(0);
  });
  it('answers 409 nullifier_used when the same booking is proved again', async () => {
    const first = await makeUser(ctx, {});
    const second = await makeUser(ctx, {});
    expect((await submitProof(app, first, submissions.valid)).status).toBe(201);
    // A second proof of the same booking, from a second account: re-proving re-randomises the proof,
    // never the nullifier, and the spent-nullifier key is what refuses both attempts.
    expect(fixtureStay(submissions.validAgain).nullifier).toBe(
      fixtureStay(submissions.valid).nullifier,
    );
    expectCode(await submitProof(app, second, submissions.validAgain), 409, 'nullifier_used');
    expectCode(await submitProof(app, first, submissions.valid), 409, 'nullifier_used');
    // One booking, spent once and stored once: both refusals rolled back with their transactions.
    expect(await app.services.db.spentNullifier.count()).toBe(1);
    expect(await app.services.db.itineraryProof.count()).toBe(1);
  });
  it('cannot be proved at all from a tampered email', async () => {
    const rejection = await fixtureProof('tampered').then(
      () => null,
      (error: unknown) => error,
    );
    // The evidence is the refusal itself: the body no longer hashes to the `bh=` its signature commits
    // to, so no witness exists and no proof of the tampered email can be produced.
    expect(rejection).toBeInstanceOf(CircuitInputError);
    expect(rejection).toMatchObject({ code: 'body_hash_mismatch' });
  });
  it('refuses an account that has not passed the age gate', async () => {
    const user = await makeUser(ctx, { consents: false });
    const response = await submitProof(app, user, submissions.valid);
    expectCode(response, 403, 'age_gate_required');
    expect(await app.services.db.itineraryProof.count()).toBe(0);
  });
  // `422 stay_out_of_range` is unreachable from these fixtures: both bookings are inside
  // `STAY_MIN_DAYS` to `STAY_MAX_DAYS`, and the signing key was discarded once the fixtures were
  // written, so no other stay can be put into a signed body. The rule is covered against injected
  // signals in `apps/api/test/unit/nullifier.test.ts`.
});

describe('GET /v1/zk/config (AAP 0.5.4)', () => {
  /** Fetch the published configuration with no bearer token, which is how a device fetches it. */
  async function fetchZkConfig(target: TestApp): Promise<ZkConfig> {
    const response = await callRoute(target.app, { method: 'GET', url: ZK_CONFIG_ROUTE });
    expect(response.status).toBe(200);
    const body = response.json();
    const parsed = ZkConfig.parse(body);
    // The parse drops an unknown key, so the round-trip is what holds the body itself to the contract:
    // a field the schema no longer publishes must be absent from the response, not merely stripped here.
    expect(parsed).toEqual(body);
    return parsed;
  }
  it('answers everything a device proves with, and nothing of the server key', async () => {
    const config = await fetchZkConfig(app);
    const base = app.env.ARTIFACTS_BASE_URL;
    // The test issuer is published, and the registry is the one whose root its proofs prove against.
    expect(config.issuers.map((issuer) => issuer.issuerId)).toContain(published.issuer.issuerId);
    expect(config.registry.name).toBe('test');
    expect(config.registry.root).toBe(published.registry.root);
    expect(config.nullifierSalt).toBe(TEST_NULLIFIER_SALT);
    expect(config.nullifierSalt).toBe(app.env.NULLIFIER_SALT);
    // The issuers still awaiting real confirmation emails, named as their own records name them.
    const awaiting = await Promise.all(
      UNSUPPORTED_ISSUER_FILES.map(
        async (file) => (await readConfig(file, IssuerConfig)).displayName,
      ),
    );
    expect(config.unsupportedIssuers).toEqual(expect.arrayContaining(awaiting));
    // The artefacts a client downloads, checked against the manifest `pnpm circuits:build` wrote.
    const manifest = await readConfig(MANIFEST_FILE, ArtifactsManifest);
    for (const [link, file] of [
      [config.artifacts.wasm, manifest.files.wasm],
      [config.artifacts.zkey, manifest.files.zkey],
    ] as const) {
      expect(link.url.startsWith(base)).toBe(true);
      expect(link.url.endsWith(file.name)).toBe(true);
      expect(link.size).toBe(file.size);
      expect(link.sha256).toBe(file.sha256);
    }
  });
  it('publishes the production registry, and no test issuer, outside the test-only switch', async () => {
    const production = await createTestApp({ env: { ZK_ALLOW_TEST_ISSUER: 'false' } });
    try {
      const config = await fetchZkConfig(production);
      const productionRegistry = await readConfig(REGISTRY_FILES.production, RegistryFile);
      expect(config.registry.name).toBe('production');
      expect(config.registry.root).toBe(productionRegistry.root);
      expect(config.issuers.map((issuer) => issuer.issuerId)).not.toContain(
        published.issuer.issuerId,
      );
    } finally {
      await production.close();
    }
  });
});
