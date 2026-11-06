/**
 * The seed's fixture console secrets (AAP 0.5.2, 0.3.2): one random 32-byte secret per fixture venue
 * and lodging, stored in the shape the API looks it up by and written to the git-ignored file that
 * lets a demo and criterion 9 open each console.
 *
 * AAP 0.5.2 sets this module's three jobs: "at seed time each venue and lodging receives a random
 * secret", the secrets are "written to the gitignored `.local/fixture-secrets.json` so demos and
 * criterion 9 can open each console", and "no secret enters the repository". AAP 0.3.2 fixes the
 * stored shape: `secretLookupHash` is the unkeyed SHA-256 digest the console route finds a row by,
 * and `secretCiphertext` is the AES-256-GCM ciphertext the code generator reads the secret back
 * from, which is why the ciphertext exists at all rather than a digest alone.
 *
 * The digest and the ciphertext are never computed here: {@link secretLookupHash},
 * {@link encryptField} and {@link decryptField} are the single implementations of that format, so
 * what this module writes is exactly what the API's console-secret lookup (AAP 0.3.2) can find and
 * decrypt. A reseed must not rotate a console out from under a running demo, so an existing secret
 * is kept whenever it can still be read back — including one an operator rotated through
 * `POST /admin/venues/:id/secret` — and a fresh secret is issued only when no usable one exists.
 *
 * Plaintext secrets live in memory and in the local file the caller names, nowhere else: nothing
 * here logs, and no message this module raises carries a secret (AAP 0.12.2).
 *
 * @see AAP 0.5.2 for the fixture sets and the local secret file, 0.3.2 for the console-secret
 *   format, 0.6.2 for the seed variables, 0.8.1 for this file's place in the inventory.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// `@tablemate/db` declares no zod of its own, and cannot gain one without regenerating the shared
// root lockfile; the workspace's hoisted linker resolves the single 4.6.7 copy the sibling packages
// pin (AAP 0.4.1), and the two file schemas below are written with that copy.
import { z } from 'zod';

import {
  decryptField,
  encryptField,
  FieldDecryptionError,
  randomSecret,
  secretLookupHash,
} from '@tablemate/server-core';
import type { Clock, FieldKeyring } from '@tablemate/server-core';
import { AppEnv, CitySlug, IsoDateTime, Uuid } from '@tablemate/shared';

import type { DbClient, DbTx } from '../src/index.ts';

/**
 * Where the fixture console secrets are written, relative to the repository root (AAP 0.5.2). The
 * root `.gitignore` excludes `/.local/`, which is what keeps the values out of every commit; the
 * caller resolves this against the root it found, so the constant stays a plain relative path.
 */
export const FIXTURE_SECRETS_RELATIVE_PATH = '.local/fixture-secrets.json';

/** Random bytes per console secret (AAP 0.3.2), rendered as 43 base64url characters by `randomSecret`. */
const SECRET_BYTES = 32;

/** Hex characters of randomness in a temporary file name, so two writers cannot collide. */
const TEMP_SUFFIX_BYTES = 6;

/** Mode of the secret file: readable and writable by its owner alone. */
const FILE_MODE = 0o600;

/** Mode of the directory holding the secret file: owner-only, since everything under it is secret. */
const DIRECTORY_MODE = 0o700;

/**
 * The identity of one fixture row whose console secret is issued (AAP 0.5.2): the row `seed.ts`
 * upserted, named so the local file says which console a human can open with the secret.
 */
export type FixtureSecretTarget = { id: string; cityId: string; name: string };

/**
 * One fixture row and its console secret, as the local file carries it (AAP 0.5.2).
 *
 * Strict, because a key nothing declares would be a secret-shaped value without an owner. `secret`
 * is the plaintext shown once at issue, never the stored digest or ciphertext (AAP 0.3.2).
 */
export const FixtureSecretEntry = z.strictObject({
  id: Uuid,
  cityId: CitySlug,
  name: z.string().min(1),
  secret: z.string().min(1),
});
export type FixtureSecretEntry = z.infer<typeof FixtureSecretEntry>;

/**
 * The local fixture-secret file (AAP 0.5.2): the environment it was written in, when it was written,
 * and one entry per fixture venue and lodging. `generatedAt` is an ISO 8601 instant taken from the
 * caller's injected clock (AAP 0.11.1), so no call site reads the wall clock.
 */
export const FixtureSecretsFile = z.strictObject({
  appEnv: AppEnv,
  generatedAt: IsoDateTime,
  venues: z.array(FixtureSecretEntry),
  lodgings: z.array(FixtureSecretEntry),
});
export type FixtureSecretsFile = z.infer<typeof FixtureSecretsFile>;

/** The three columns of `venue` and `lodging` this module reads and writes (AAP 0.5.2). */
type SecretRow = {
  id: string;
  secretLookupHash: string | null;
  secretCiphertext: string | null;
};

/**
 * What {@link issueFixtureSecrets} needs from a fixture-bearing model: the one read that loads the
 * rows it was handed, and the one write that stores a decided secret.
 *
 * Both calls are typed narrowly so that the model delegate of a guarded `DbClient` and that of an
 * interactive transaction client satisfy them unchanged, which is what lets the seed pass either.
 */
type FixtureSecretDelegate = {
  findMany(args: {
    where: { id: { in: string[] } };
    select: { id: true; secretLookupHash: true; secretCiphertext: true };
  }): Promise<SecretRow[]>;
  update(args: {
    where: { id: string };
    data: { secretLookupHash?: string; secretCiphertext?: string; secretIssuedAt?: Date };
  }): Promise<{ id: string }>;
};

/** The keyring and clock every target of one issue run shares (AAP 0.11.1). */
type IssueContext = { keyring: FieldKeyring; clock: Clock };

/** Which fixture table is being issued, for the failure message of {@link issueKind}. */
type FixtureKind = 'venue' | 'lodging';

/** True when a filesystem failure is a missing file, which {@link readFixtureSecrets} reads as no file. */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

/**
 * The plaintext of a stored ciphertext, or `null` when this keyring cannot open it (AAP 0.3.2).
 *
 * Only {@link FieldDecryptionError} is absorbed: it covers a retired key id, a malformed value and a
 * value written under a different key, and each of those means the row's stored secret is gone and a
 * decision falls through to the next branch of {@link secretFor}. Anything else is a defect and is
 * raised rather than read as a lost secret.
 */
function decryptOrNull(keyring: FieldKeyring, ciphertext: string): string | null {
  try {
    return decryptField(keyring, ciphertext);
  } catch (error) {
    if (error instanceof FieldDecryptionError) {
      return null;
    }
    throw error;
  }
}

/**
 * Reads the local fixture-secret file (AAP 0.5.2).
 *
 * A file that is missing, does not parse, or does not match {@link FixtureSecretsFile} is treated as
 * absent: the file is a convenience for demos and tests, so a stale or hand-edited copy must make
 * the seed issue fresh secrets rather than fail. Every other failure — an unreadable file, or a
 * directory in its place — is raised, because absorbing it would silently rotate consoles.
 *
 * @param filePath - The file's absolute path, which the caller resolves from
 *   {@link FIXTURE_SECRETS_RELATIVE_PATH}.
 * @returns The parsed file, or `null` when there is nothing usable to read.
 * @throws Whatever `readFile` raises for a failure other than a missing file.
 */
export async function readFixtureSecrets(filePath: string): Promise<FixtureSecretsFile | null> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = FixtureSecretsFile.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Gives every fixture row in `venues` and `lodgings` a console secret, keeping the one it already has
 * (AAP 0.5.2, 0.3.2).
 *
 * Each kind's rows are loaded once, and then each target's secret is decided in this order:
 *
 * 1. **Stored.** The row's `secretCiphertext` decrypts under `options.keyring` and its
 *    {@link secretLookupHash} equals the stored `secretLookupHash`: the row keeps its secret and
 *    nothing is written, so a reseed on every `docker compose up` leaves a demo's console working,
 *    and a secret an operator rotated through `POST /admin/venues/:id/secret` is not overwritten.
 * 2. **Previous file.** The entry `options.previous` holds for the same id hashes to the row's stored
 *    digest: that secret is kept and only its ciphertext is rewritten, so a rotated
 *    `FIELD_ENCRYPTION_KEY` re-encrypts the value without changing it, and `secretIssuedAt` — the
 *    moment the secret was first issued — is left untouched.
 * 3. **Issue.** Otherwise `randomSecret(32)` mints a new secret, and the row receives its digest, its
 *    ciphertext and `secretIssuedAt` from `options.clock.now()`.
 *
 * Only fixture rows are ever handed to this function, so an operator-onboarded venue or lodging is
 * never touched by the seed.
 *
 * @param db - The guarded client or interactive transaction the seed writes through.
 * @param options - The keyring, the clock, the fixture rows of each kind, and the file
 *   {@link readFixtureSecrets} returned if there was one.
 * @returns The entries for the caller to persist with {@link writeFixtureSecrets}, in the order of
 *   the input targets.
 * @throws Error when a target names a row the read did not return, which means the caller's list and
 *   the seed's writes disagree. The message names the kind and the id, never a secret.
 */
export async function issueFixtureSecrets(
  db: DbClient | DbTx,
  options: {
    keyring: FieldKeyring;
    clock: Clock;
    venues: readonly FixtureSecretTarget[];
    lodgings: readonly FixtureSecretTarget[];
    previous: FixtureSecretsFile | null;
  },
): Promise<{ venues: FixtureSecretEntry[]; lodgings: FixtureSecretEntry[] }> {
  const context: IssueContext = { keyring: options.keyring, clock: options.clock };

  return {
    venues: await issueKind(
      db.venue,
      'venue',
      options.venues,
      context,
      options.previous?.venues ?? [],
    ),
    lodgings: await issueKind(
      db.lodging,
      'lodging',
      options.lodgings,
      context,
      options.previous?.lodgings ?? [],
    ),
  };
}

/**
 * Issues the secrets of one kind (AAP 0.5.2): loads the rows once, decides each target's secret as
 * {@link issueFixtureSecrets} documents, and returns the entries in the input order.
 *
 * @param delegate - The model delegate for this kind.
 * @param kind - The kind, for the failure message when a target is not in the database.
 * @param targets - The fixture rows whose secrets are wanted.
 * @param context - The keyring and clock to use.
 * @param previous - The entries the previous local file held for this kind, if any.
 * @returns One entry per target, in the order the targets were given.
 * @throws Error when a target names a row the read did not return.
 */
async function issueKind(
  delegate: FixtureSecretDelegate,
  kind: FixtureKind,
  targets: readonly FixtureSecretTarget[],
  context: IssueContext,
  previous: readonly FixtureSecretEntry[],
): Promise<FixtureSecretEntry[]> {
  if (targets.length === 0) {
    return [];
  }

  const rows = await delegate.findMany({
    where: { id: { in: targets.map((target) => target.id) } },
    select: { id: true, secretLookupHash: true, secretCiphertext: true },
  });
  const rowsById = new Map<string, SecretRow>(
    rows.map((row): [string, SecretRow] => [row.id, row]),
  );
  const previousById = new Map<string, FixtureSecretEntry>(
    previous.map((entry): [string, FixtureSecretEntry] => [entry.id, entry]),
  );

  const entries: FixtureSecretEntry[] = [];
  for (const target of targets) {
    const row = rowsById.get(target.id);
    if (row === undefined) {
      throw new Error(`fixture ${kind} ${target.id} is not in the database`);
    }
    const secret = await secretFor(delegate, target, row, context, previousById.get(target.id));
    entries.push({ id: target.id, cityId: target.cityId, name: target.name, secret });
  }

  return entries;
}

/**
 * Decides one target's secret (AAP 0.5.2): keep the stored one, keep the previous file's, or issue a
 * new one. Each branch, and why the order matters, is documented on {@link issueFixtureSecrets}.
 *
 * @param delegate - The model delegate holding the row.
 * @param target - The fixture row being issued.
 * @param row - The row's stored digest and ciphertext.
 * @param context - The keyring and clock to use.
 * @param previous - The entry the previous local file held for this id, if any.
 * @returns The secret the row now holds, in the clear.
 */
async function secretFor(
  delegate: FixtureSecretDelegate,
  target: FixtureSecretTarget,
  row: SecretRow,
  context: IssueContext,
  previous: FixtureSecretEntry | undefined,
): Promise<string> {
  const stored =
    row.secretCiphertext === null ? null : decryptOrNull(context.keyring, row.secretCiphertext);
  if (
    stored !== null &&
    row.secretLookupHash !== null &&
    secretLookupHash(stored) === row.secretLookupHash
  ) {
    return stored; // Readable and matching, so nothing is written and `secretIssuedAt` stands.
  }

  if (
    previous !== undefined &&
    row.secretLookupHash !== null &&
    secretLookupHash(previous.secret) === row.secretLookupHash
  ) {
    await delegate.update({
      where: { id: target.id },
      data: { secretCiphertext: encryptField(context.keyring, previous.secret) },
    });
    return previous.secret;
  }

  const secret = randomSecret(SECRET_BYTES);
  await delegate.update({
    where: { id: target.id },
    data: {
      secretLookupHash: secretLookupHash(secret),
      secretCiphertext: encryptField(context.keyring, secret),
      secretIssuedAt: context.clock.now(),
    },
  });
  return secret;
}

/**
 * Writes the local fixture-secret file (AAP 0.5.2).
 *
 * The entries are validated first, then written to `<filePath>.<hex>.tmp` and renamed over the
 * destination, so a reader never sees a half-written file and no reader of a replaced file ever sees
 * a partial one. The directory is created owner-only and the file is written with mode `0600`,
 * because every value in it is a console secret; the containing `.local/` directory is git-ignored,
 * so no secret enters the repository (AAP 0.12.2).
 *
 * @param filePath - The file's absolute path.
 * @param file - The entries to write.
 * @returns Nothing, once the renamed file holds them.
 * @throws ZodError when `file` does not match {@link FixtureSecretsFile}.
 * @throws Whatever `mkdir`, `writeFile` or `rename` raises. The temporary file is removed first.
 */
export async function writeFixtureSecrets(
  filePath: string,
  file: FixtureSecretsFile,
): Promise<void> {
  const contents = `${JSON.stringify(FixtureSecretsFile.parse(file), null, 2)}\n`;

  await mkdir(path.dirname(filePath), { recursive: true, mode: DIRECTORY_MODE });

  const temporaryPath = `${filePath}.${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: FILE_MODE, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined); // Best effort: rethrow the cause.
    throw error;
  }
}
