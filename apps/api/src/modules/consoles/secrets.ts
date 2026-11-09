/**
 * Console-secret issue and lookup: the one place a venue's or a lodging's console secret is minted, given the shape
 * a row stores, and found again by its header.
 *
 * The shape is fixed: a secret is 32 random bytes shown once at issue, and what a row keeps is a SHA-256 *lookup*
 * hash beside an AES-256-GCM ciphertext. The hash is what `X-Venue-Secret` and `X-Lodging-Secret` are matched on, so
 * a leaked table yields no usable secret; the ciphertext exists because the code generator needs the secret itself
 * back, since `totp.ts` derives its HKDF key from the UTF-8 text of this exact string. The format is shared, never
 * restated: `packages/db/seed/secrets-out.ts` writes seeded consoles through the same helpers.
 *
 * A lookup answers `null` for everything that is not a live secret: a header that is absent, duplicated, empty or
 * over {@link MAX_HEADER_CHARACTERS}, an unknown hash, a row never issued a secret, and a row whose stored secret is
 * not the presented one ({@link timingSafeEqualString}). Failing to *decrypt* a stored value is not one of those
 * cases: the process cannot open its own row, which is a key misconfiguration, so the error propagates to `500`
 * instead of being misread as a wrong secret. Nothing here logs: header, secret, hash and ciphertext stay out of
 * every log line, no stored form reaches a caller, and nothing reads time.
 */

import {
  decryptField,
  encryptField,
  randomSecret,
  secretLookupHash as hashConsoleSecret,
  timingSafeEqualString,
} from '@tablemate/server-core';
import type { FieldKeyring } from '@tablemate/server-core';

import type { DbClient, DbTx } from '@tablemate/db';

// Type-only, so this file holds no runtime edge to the module that builds the app: `app.ts` reaches
// the consoles plugin as a value, and nothing of `AppServices` exists at run time.
import type { AppServices } from '../../app.ts';

/** Random bytes behind one console secret (AAP 0.3.2): 43 base64url characters. */
const SECRET_BYTES = 32;

/**
 * Longest header value a lookup will hash. It is a length bound, not a format check: a value's shape is not
 * validated, because the row is found by hash.
 */
const MAX_HEADER_CHARACTERS = 256;

/**
 * One console secret in the three forms it takes (AAP 0.3.2, 0.5.2). The plaintext is what a console operator types
 * in and what `totp.ts` derives the check-in key from; the other two are the columns a row stores, kept apart from it
 * so neither is ever handed back to a caller.
 */
export interface ConsoleSecretMaterial {
  /** The plaintext: 32 random bytes as base64url. Shown once at issue, never stored in the clear. */
  readonly secret: string;
  /** `secretLookupHash` of `Venue` and `Lodging`: SHA-256 hex of the secret, what a lookup matches. */
  readonly secretLookupHash: string;
  /** `secretCiphertext` of `Venue` and `Lodging`: `<keyId>.<base64url(iv, tag, ciphertext)>`. */
  readonly secretCiphertext: string;
}

/**
 * Mints one console secret in the shape a `Venue` or `Lodging` row stores (AAP 0.3.2).
 *
 * Pure: it writes nothing and reads only the keyring, so the caller owns the row, the transaction and the moment.
 * `admin/onboarding.ts` stores the hash and the ciphertext with `secretIssuedAt` and answers the plaintext once, in
 * the shared `SecretIssued` body (AAP 0.5.4).
 */
export function issueSecret(services: Pick<AppServices, 'keyring'>): ConsoleSecretMaterial {
  const secret = randomSecret(SECRET_BYTES);
  return {
    secret,
    secretLookupHash: hashConsoleSecret(secret),
    secretCiphertext: encryptField(services.keyring, secret),
  };
}

/** nullable because a row exists before a secret is issued to it, and such a row can never produce a */
interface ConsoleSecretRow {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly secretCiphertext: string | null;
}

/**
 * The one read both lookups perform, stated as the capability they use so `db.venue` and `db.lodging` of a guarded
 * `DbClient` satisfy it structurally. `findFirst` rather than `findUnique`, because the fixture guard narrows a
 * `findFirst` to `isFixture: false` outside `test` and `demo`, which is what makes a fixture console invisible for
 * free (AAP 0.5.2); a hand-written filter here would be a second, contradictory source of that rule.
 */
interface ConsoleSecretDelegate {
  findFirst(args: {
    where: { secretLookupHash: string };
    select: { id: true; cityId: true; name: true; secretCiphertext: true };
  }): Promise<ConsoleSecretRow | null>;
}

/**
 * The usable value of a console-secret header, or `null` when there is none. Fastify hands a header over as a string,
 * as an array when the client sent it more than once, or as `undefined` when it is absent; only a single, non-empty,
 * not-too-long string can be a secret. An array is refused rather than unwrapped, because two values make the request
 * ambiguous (AAP 0.12.2).
 */
function normalizeHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HEADER_CHARACTERS) {
    return null;
  }
  return value;
}

/**
 * Finds the row one console secret belongs to and returns it with the decrypted secret.
 *
 * A value that cannot be a secret costs no query; a missing row or a null ciphertext is `null`, so an unknown secret
 * and an unissued one are indistinguishable to the caller; the decryption runs last among the stored work and its
 * failure propagates (module header); and the comparison is constant-time defence in depth, since a hash match
 * already implies equality, so a mismatch means a corrupted row and refusing the lookup is the safe answer.
 */
async function lookupBySecret(
  keyring: FieldKeyring,
  delegate: ConsoleSecretDelegate,
  header: string | string[] | undefined,
): Promise<{ row: ConsoleSecretRow; secret: string } | null> {
  const value = normalizeHeader(header);
  if (value === null) {
    return null;
  }
  const row = await delegate.findFirst({
    where: { secretLookupHash: hashConsoleSecret(value) },
    select: { id: true, cityId: true, name: true, secretCiphertext: true },
  });
  if (row === null || row.secretCiphertext === null) {
    return null;
  }
  const secret = decryptField(keyring, row.secretCiphertext);
  return timingSafeEqualString(secret, value) ? { row, secret } : null;
}

/**
 * The venue a console secret belongs to, or `null` when no venue holds it (AAP 0.5.1, 0.5.4).
 *
 * Serves `GET /venue/check-in-code`, for which `X-Venue-Secret` is the only credential, so `isActivePartner` is
 * deliberately not part of the query: whether a venue may host a meetup is the proposal route's business, and a venue
 * that paused as a partner would otherwise lose a console that is still on screen. `cityId` comes back because the
 * caller needs the city's local time.
 */
export async function findVenueBySecret(
  services: Pick<AppServices, 'db' | 'keyring'>,
  header: string | string[] | undefined,
): Promise<{ venue: { id: string; cityId: string; name: string }; secret: string } | null> {
  const found = await lookupBySecret(services.keyring, services.db.venue, header);
  return found === null
    ? null
    : {
        venue: { id: found.row.id, cityId: found.row.cityId, name: found.row.name },
        secret: found.secret,
      };
}

/**
 * The lodging a console secret belongs to, or `null` when no lodging holds it (AAP 0.5.1, 0.5.4).
 *
 * Serves `GET /lodging-console/stats` and behaves exactly as {@link findVenueBySecret} does over `lodging`.
 * `osmMissingAt` is deliberately not part of the query: a lodging that disappeared from OpenStreetMap leaves the
 * directory but keeps its console, its claims and its activity facts (AAP 0.5.6).
 */
export async function findLodgingBySecret(
  services: Pick<AppServices, 'db' | 'keyring'>,
  header: string | string[] | undefined,
): Promise<{ lodging: { id: string; cityId: string; name: string }; secret: string } | null> {
  const found = await lookupBySecret(services.keyring, services.db.lodging, header);
  return found === null
    ? null
    : {
        lodging: { id: found.row.id, cityId: found.row.cityId, name: found.row.name },
        secret: found.secret,
      };
}

/** guarded client and an interactive transaction client satisfy it, which is what lets */
interface VenueSecretReader {
  findUnique(args: {
    where: { id: string };
    select: { secretCiphertext: true };
  }): Promise<{ secretCiphertext: string | null } | null>;
}

/**
 * The check-in secret of one venue, looked up by id (AAP 0.5.1, 0.5.7).
 *
 * `meetups/check-in.ts` calls this to verify a submitted code and `consoles/routes.ts` to render the current one, so
 * it takes the venue's id rather than a row: nothing else of the venue is loaded. `null` means the venue is unknown
 * or holds no issued secret, and such a venue can never produce a valid code — the caller answers `422 invalid_code`
 * (AAP 0.5.4). A stored value this process cannot decrypt still raises `FieldDecryptionError`, as in
 * {@link lookupBySecret}.
 */
export async function venueSecretFor(
  services: Pick<AppServices, 'db' | 'keyring'>,
  venueId: string,
  client?: DbClient | DbTx,
): Promise<string | null> {
  const reader: VenueSecretReader = client === undefined ? services.db.venue : client.venue;
  const row = await reader.findUnique({
    where: { id: venueId },
    select: { secretCiphertext: true },
  });
  return row === null || row.secretCiphertext === null
    ? null
    : decryptField(services.keyring, row.secretCiphertext);
}
