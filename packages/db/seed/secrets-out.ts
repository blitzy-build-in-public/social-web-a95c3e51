import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
// `@tablemate/db` declares no zod of its own, and cannot gain one without regenerating the shared root lockfile; the workspace's hoisted linker resolves the single 4.6.7 copy the sibling packages pin (AAP 0.4.1), and the two file schemas below are written with that copy.
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
/** Where the fixture console secrets are written, relative to the repository root (AAP 0.5.2). */
export const FIXTURE_SECRETS_RELATIVE_PATH = '.local/fixture-secrets.json';
const SECRET_BYTES = 32;
const TEMP_SUFFIX_BYTES = 6;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
/** The identity of one fixture row whose console secret is issued (AAP 0.5.2): the row `seed.ts` upserted, named so the local file says which console a human can open with the secret. */
export type FixtureSecretTarget = { id: string; cityId: string; name: string };
/** One fixture row and its console secret, as the local file carries it (AAP 0.5.2). */
export const FixtureSecretEntry = z.strictObject({
  id: Uuid,
  cityId: CitySlug,
  name: z.string().min(1),
  secret: z.string().min(1),
});
export type FixtureSecretEntry = z.infer<typeof FixtureSecretEntry>;
/** The local fixture-secret file (AAP 0.5.2): the environment it was written in, when it was written, and one entry per fixture venue and lodging. */
export const FixtureSecretsFile = z.strictObject({
  appEnv: AppEnv,
  generatedAt: IsoDateTime,
  venues: z.array(FixtureSecretEntry),
  lodgings: z.array(FixtureSecretEntry),
});
export type FixtureSecretsFile = z.infer<typeof FixtureSecretsFile>;
type SecretRow = {
  id: string;
  secretLookupHash: string | null;
  secretCiphertext: string | null;
};
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
type IssueContext = { keyring: FieldKeyring; clock: Clock };
type FixtureKind = 'venue' | 'lodging';
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
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
/** Reads the local fixture-secret file (AAP 0.5.2). */
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
/** Gives every fixture row in `venues` and `lodgings` a console secret, keeping the one it already has (AAP 0.5.2, 0.3.2). */
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
  // A wipe is not a rotation: a row the seed re-created carries no stored digest at all, so the entry the file holds for its id is the secret this console already has. The row is re-stored with it, digest and issue instant included, because there is nothing stored to compare against.
  if (previous !== undefined && row.secretLookupHash === null) {
    await delegate.update({
      where: { id: target.id },
      data: {
        secretLookupHash: secretLookupHash(previous.secret),
        secretCiphertext: encryptField(context.keyring, previous.secret),
        secretIssuedAt: context.clock.now(),
      },
    });
    return previous.secret;
  }
  if (previous !== undefined && secretLookupHash(previous.secret) === row.secretLookupHash) {
    // The digest matches, so only a re-encryption happened: the digest and `secretIssuedAt` stand.
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
/** Writes the local fixture-secret file (AAP 0.5.2). */
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
