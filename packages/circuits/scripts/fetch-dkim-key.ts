/**
 * The DKIM key fetcher,
 * `pnpm --filter @tablemate/circuits fetch-dkim-key -- <issuer> [--write]` (AAP 0.5.5, 0.8.1).
 *
 * The operator-side half of onboarding an issuer. Once real confirmation emails are in the git-ignored
 * `packages/circuits/samples/<issuer>/`, it reads the `d=` and `s=` tags of their DKIM signatures,
 * resolves each selector's `p=` key over DNS, prints one key record per aligned signature, and with
 * `--write` merges those records into the issuer's record as `unverified`, so `pnpm circuits:samples`
 * still decides whether the issuer earns a production leaf.
 *
 * Alignment is the security rule here: only a signature whose `d=` equals the message's `From` domain
 * or a parent domain of it is kept. A confirmation is routinely also signed by the sending ESP
 * (`amazonses.com`, `sendgrid.net`), whose key signs mail for every one of that ESP's customers;
 * recording it as an issuer key would let anyone forge a "confirmation". Every other signature is
 * reported and dropped. No key is invented either: each record comes from DNS for a selector a sample
 * actually carried.
 *
 * This is the only place in the project that resolves DNS — the client takes its keys from the
 * published registry by `d=` and `s=` (AAP 0.5.5) — and samples stay git-ignored, never copied,
 * quoted or logged. Output carries a sample number, the first 8 hex of its SHA-256, and public DNS
 * names only, so no file name, address, local part or line of email text is printed.
 */
import { createHash, createPublicKey } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IssuerConfig } from '@tablemate/shared';
import type { DkimKey } from '@tablemate/shared';

import type { HeaderField, ParsedEml } from '../src/inputs/eml-parse.ts';
import { CircuitInputError, bytesToLatin1, parseEml } from '../src/inputs/eml-parse.ts';
import { modulusFromBase64, pubkeyHash } from '../src/registry/leaves.ts';
import { PKG_DIR, REPO_ROOT, loadIssuers } from './build-registry.ts';
import type { LoadedIssuer } from './build-registry.ts';

/** The samples' directory, repository-relative: git-ignored, so a path in a message names no file. */
const SAMPLES_DIR = 'packages/circuits/samples';

/** The command line, printed on stderr whenever the arguments do not match it. */
const USAGE = 'usage: pnpm --filter @tablemate/circuits fetch-dkim-key -- <issuer> [--write]';

/** The modulus bit bounds a DKIM key may have: RSA-1024 at the floor, RSA-2048 at the ceiling. */
const MIN_MODULUS_BITS = 1024;
const MAX_MODULUS_BITS = 2048;

/** The length of the printed sample digest prefix, in hex characters. */
const DIGEST_PREFIX = 8;

/** An aligned signature's source: the signing domain and selector, and the samples that carried it. */
interface KeySource {
  domain: string;
  selector: string;
  samples: number[];
}

/**
 * The domain of a message's `From` header: the text after the last `@` of the address, lowercased. The
 * `<>`-enclosed address is read when the display name carries one of its own, because that is the
 * address the message is from.
 *
 * @param headers - The message's header fields, in file order.
 * @returns The domain, or undefined when no readable address or domain is there.
 */
export function fromDomainOf(headers: readonly HeaderField[]): string | undefined {
  const field = headers.find((header) => header.lowerName === 'from');
  if (field === undefined) return undefined;

  const text = bytesToLatin1(field.raw);
  const open = text.lastIndexOf('<');
  const close = open < 0 ? -1 : text.indexOf('>', open);
  const address = open >= 0 && close > open ? text.slice(open + 1, close) : text;
  const at = address.lastIndexOf('@');
  if (at < 0) return undefined;

  const domain = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/.exec(address.slice(at + 1).trim());

  return domain === null ? undefined : domain[0].toLowerCase();
}

/**
 * Whether a DKIM `d=` is aligned with the `From` domain as DKIM's relaxed alignment reads it: the
 * signing domain is the `From` domain itself or a parent domain of it. A domain that merely ends with
 * the same text (`booking.com.example` for `booking.com`), and a child of the `From` domain, are not.
 */
export function isAligned(signingDomain: string, fromDomain: string): boolean {
  if (signingDomain === '' || fromDomain === '') return false;

  return signingDomain === fromDomain || fromDomain.endsWith(`.${signingDomain}`);
}

/** One selector's DKIM TXT record: its `p=` key value and its `k=` algorithm, empty when absent. */
export interface DkimTxtRecord {
  p: string;
  k: string;
}

/**
 * The DKIM record among a selector's TXT answers (RFC 6376 §3.6): each answer's chunks joined, the
 * first answer carrying a `p=` tag taken, its tag list read into tags.
 *
 * @returns The `p=` and `k=` tags, `p` empty for a revoked key; undefined when no answer carries a
 *   `p=` tag at all, which is a different state from a withdrawn key.
 */
export function dkimTxtRecord(answers: readonly (readonly string[])[]): DkimTxtRecord | undefined {
  for (const chunks of answers) {
    const tags = new Map<string, string>();

    for (const tag of chunks.join('').split(';')) {
      const equals = tag.indexOf('=');
      if (equals > 0) {
        tags.set(tag.slice(0, equals).trim().toLowerCase(), tag.slice(equals + 1).trim());
      }
    }

    const p = tags.get('p');
    if (p !== undefined) return { p, k: (tags.get('k') ?? '').toLowerCase() };
  }

  return undefined;
}

/**
 * Encodes one selector's `p=` value (AAP 0.5.5). The tag carries the DER SubjectPublicKeyInfo of the
 * RSA public key; `modulusBase64` is standard base64 of the unsigned big-endian modulus with no leading
 * zero byte — the encoding `src/registry/leaves.ts` decodes and `make-test-fixtures.ts` writes — and
 * `hash` is the issuer leaf's `pubkeyHash`, printed so an operator can compare it with the registry.
 *
 * @param p - The base64 `p=` value, its folding whitespace already removed.
 * @throws {Error} When the value is not a valid SPKI public key, is not RSA, or carries a modulus
 *   outside 1024-2048 bits.
 */
export function modulusRecordOf(p: string): { modulusBase64: string; bits: number; hash: bigint } {
  let key: ReturnType<typeof createPublicKey>;

  try {
    key = createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error('p= is not a valid SPKI public key');
  }

  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`p= is a ${key.asymmetricKeyType ?? 'unknown'} key, not rsa`);
  }

  const n = (key.export({ format: 'jwk' }) as { n?: string }).n;
  if (n === undefined) throw new Error('p= is not a valid SPKI public key');

  const hex = Buffer.from(n, 'base64url').toString('hex');
  const modulus = BigInt(`0x${hex === '' ? '0' : hex}`);
  const bits = modulus.toString(2).length;

  if (bits < MIN_MODULUS_BITS || bits > MAX_MODULUS_BITS) {
    throw new Error(`modulus is ${bits} bits, outside 1024-2048`);
  }

  const minimal = modulus.toString(16);
  const bytes = minimal.length % 2 === 0 ? minimal : `0${minimal}`;
  const modulusBase64 = Buffer.from(bytes, 'hex').toString('base64');

  if (modulusFromBase64(modulusBase64) !== modulus) {
    throw new Error('modulus does not round-trip through its encoding');
  }

  return { modulusBase64, bits, hash: pubkeyHash(modulus) };
}

/**
 * The issuer's key list with the resolved records merged in, deduplicated by domain (lowercased) and
 * selector (AAP 0.5.5). A recorded key wins while its modulus is identical, so a repeated run rewrites
 * nothing; it is replaced — and reported as rotated — when the modulus differs, because the DNS answer
 * of this run is current and the file's is not. Existing entries keep their position and new selectors
 * are appended, so a rerun's diff is only what actually changed.
 *
 * @returns The merged list, whether it differs from `existing`, and the records it replaced.
 */
export function mergeKeys(
  existing: readonly DkimKey[],
  resolved: readonly DkimKey[],
): { keys: DkimKey[]; changed: boolean; rotated: DkimKey[] } {
  const replacements = new Map(resolved.map((key) => [keyId(key.domain, key.selector), key]));
  const keys: DkimKey[] = [];
  const rotated: DkimKey[] = [];
  let changed = false;

  for (const key of existing) {
    const replacement = replacements.get(keyId(key.domain, key.selector));

    if (replacement === undefined || replacement.modulusBase64 === key.modulusBase64) {
      keys.push(key);
      continue;
    }

    rotated.push(key);
    keys.push(replacement);
    changed = true;
  }

  const recorded = new Set(keys.map((key) => keyId(key.domain, key.selector)));

  for (const key of resolved) {
    if (recorded.has(keyId(key.domain, key.selector))) continue;

    recorded.add(keyId(key.domain, key.selector));
    keys.push(key);
    changed = true;
  }

  return { keys, changed, rotated };
}

/**
 * Runs the command line: reads the issuer's samples, resolves their aligned DKIM keys, and with
 * `--write` merges the result into the issuer's record. Every failure is reported as
 * `fetch-dkim-key: <message>` with exit code 1, and nothing prints a stack trace or a file's bytes.
 */
async function main(): Promise<void> {
  try {
    const { stem, write } = parseArgs(process.argv.slice(2));
    const issuers = await loadIssuers();
    const issuer = issuers.find((record) => record.stem === stem);

    if (issuer === undefined) {
      const known = issuers.map((record) => record.stem).join(', ');
      throw new Error(`unknown issuer ${stem}; known issuers: ${known}`);
    }

    // The record's schema couples keys to a template: an issuer awaiting samples carries neither, so
    // writing keys first would produce a record `IssuerConfig` refuses (AAP 0.5.5).
    if (write && issuer.config.template === null) {
      throw new Error(
        `${issuer.path}: awaiting_samples forbids DKIM keys; author the template from the samples ` +
          '(anchors, terminators, charsets, date format) and then rerun with --write',
      );
    }

    const resolved = await resolveSamples(stem);

    if (write) await writeKeys(issuer, resolved);
  } catch (error) {
    process.stderr.write(`fetch-dkim-key: ${reasonOf(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Reads the command line: exactly one positional issuer stem and an optional `--write`.
 *
 * @param argv - `process.argv.slice(2)`, whose separating bare `--` is ignored.
 * @throws {Error} For any other argument or a missing stem, after the usage line is printed.
 */
function parseArgs(argv: readonly string[]): { stem: string; write: boolean } {
  const args = argv.filter((argument) => argument !== '--');
  const write = args.includes('--write');
  const named = args.filter((argument) => argument.startsWith('-') && argument !== '--write');
  const [stem, ...extra] = args.filter((argument) => !argument.startsWith('-'));

  if (named.length > 0 || extra.length > 0 || stem === undefined) {
    process.stderr.write(`${USAGE}\n`);
    const unexpected = [...named, ...extra];

    throw new Error(
      unexpected.length > 0 ? `unexpected argument ${unexpected.join(' ')}` : 'missing <issuer>',
    );
  }

  return { stem, write };
}

/**
 * Reads the issuer's samples, keeps the signatures aligned with each message's `From` domain, resolves
 * every remaining selector's DKIM record over DNS and encodes its key. A pair that cannot be resolved
 * is reported and never stops the others, because one dead selector must not hide a usable key.
 *
 * @param stem - The issuer's file stem, which is also its samples' directory name.
 * @throws {Error} When the issuer has no samples, or a sample cannot be read.
 */
async function resolveSamples(stem: string): Promise<DkimKey[]> {
  const directory = path.join(PKG_DIR, 'samples', stem);
  const names = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => name.toLowerCase().endsWith('.eml'))
    .sort();

  if (names.length === 0) {
    throw new Error(
      `no samples in ${SAMPLES_DIR}/${stem}/ (git-ignored; place real confirmation .eml files there)`,
    );
  }

  const sources = new Map<string, KeySource>();

  for (const [index, name] of names.entries()) {
    const sample = index + 1;
    const bytes = await readFile(path.join(directory, name));
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, DIGEST_PREFIX);
    let parsed: ParsedEml;

    try {
      parsed = parseEml(bytes);
    } catch (error) {
      if (!(error instanceof CircuitInputError)) throw error;

      process.stdout.write(`sample #${sample}: ${error.code}\n`);
      continue;
    }

    const fromDomain = fromDomainOf(parsed.headers);

    if (fromDomain === undefined) {
      process.stdout.write(`sample #${sample}: no_from_domain\n`);
      continue;
    }

    process.stdout.write(`sample #${sample} sha256=${digest} from=${fromDomain}\n`);

    for (const signature of parsed.signatures) {
      if (!isAligned(signature.d, fromDomain)) {
        process.stdout.write(
          `skipped d=${signature.d} s=${signature.s} (not aligned with From domain)\n`,
        );
        continue;
      }

      const id = keyId(signature.d, signature.s);
      const source = sources.get(id) ?? { domain: signature.d, selector: signature.s, samples: [] };

      source.samples.push(sample);
      sources.set(id, source);
    }
  }

  if (sources.size === 0) {
    process.stdout.write(`no aligned DKIM signature in ${names.length} sample(s)\n`);
    return [];
  }

  return resolveKeys([...sources.values()]);
}

/**
 * Resolves each source's DKIM TXT record and prints the key record it yields.
 *
 * @param sources - The aligned `(domain, selector)` pairs, with the samples that carried each.
 */
async function resolveKeys(sources: readonly KeySource[]): Promise<DkimKey[]> {
  const resolved: DkimKey[] = [];

  for (const source of sources) {
    const label = `d=${source.domain} s=${source.selector} samples ${source.samples
      .map((sample) => `#${sample}`)
      .join(',')}`;
    let answers: string[][];

    try {
      answers = await resolveTxt(`${source.selector}._domainkey.${source.domain}`);
    } catch (error) {
      process.stdout.write(`${label}: dns lookup failed (${dnsErrorCode(error)})\n`);
      continue;
    }

    const txt = dkimTxtRecord(answers);

    if (txt === undefined) {
      process.stdout.write(`${label}: no p= tag in the TXT record\n`);
      continue;
    }
    if (txt.k !== '' && txt.k !== 'rsa') {
      process.stdout.write(`${label}: k=${txt.k}, not rsa\n`);
      continue;
    }
    if (txt.p === '') {
      process.stdout.write(`${label}: revoked key (empty p=)\n`);
      continue;
    }

    try {
      const { modulusBase64, bits, hash } = modulusRecordOf(txt.p.replace(/\s+/g, ''));

      process.stdout.write(`${label}: ${bits} bits, pubkeyHash ${hash}\n`);
      process.stdout.write(
        `${JSON.stringify({ domain: source.domain, selector: source.selector, modulusBase64 })}\n`,
      );
      resolved.push({ domain: source.domain, selector: source.selector, modulusBase64 });
    } catch (error) {
      process.stdout.write(`${label}: ${reasonOf(error)}\n`);
    }
  }

  return resolved;
}

/**
 * Merges the resolved keys into the issuer's record and writes it, or reports that nothing changed.
 *
 * @param issuer - The loaded issuer record, whose path the write targets.
 * @throws {Error} When nothing resolved, or when the merged record fails its schema.
 */
async function writeKeys(issuer: LoadedIssuer, resolved: readonly DkimKey[]): Promise<void> {
  if (resolved.length === 0) {
    throw new Error(`${issuer.path}: no aligned key resolved, so nothing was written`);
  }

  const { keys, changed, rotated } = mergeKeys(issuer.config.keys, resolved);

  for (const key of rotated) {
    process.stdout.write(
      `d=${key.domain} s=${key.selector}: modulus changed (rotated key), replacing\n`,
    );
  }

  if (!changed) {
    process.stdout.write(`${issuer.path}: unchanged; every resolved key is already recorded\n`);
    return;
  }

  // A newly recorded key needs its own `pnpm circuits:samples` pass before the issuer may claim a
  // production leaf, so the status drops back to `unverified` (AAP 0.5.5).
  const record: IssuerConfig = {
    issuerId: issuer.config.issuerId,
    displayName: issuer.config.displayName,
    verificationStatus: 'unverified',
    keys,
    template: issuer.config.template,
  };
  const parsed = IssuerConfig.safeParse(record);

  if (!parsed.success) throw new Error(`${issuer.path}: ${issuePaths(parsed.error.issues)}`);

  await writeFile(
    path.join(REPO_ROOT, issuer.path),
    `${JSON.stringify(parsed.data, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `${issuer.path}: wrote ${keys.length} key record(s) as unverified\n` +
      `next: pnpm circuits:samples ${issuer.stem}; once it passes, set verificationStatus to ` +
      'verified and run pnpm circuits:registry\n',
  );
}

/** The identity a key record is deduplicated by: its domain lowercased, its selector as written. */
function keyId(domain: string, selector: string): string {
  return `${domain.trim().toLowerCase()}\u0000${selector}`;
}

/** The DNS error code of a failed lookup, or the message when the failure carries none. */
function dnsErrorCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown } | null)?.code;

  return typeof code === 'string' ? code : reasonOf(error);
}

/** A caught value's message, for the one line a failure prints. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Renders a parse failure as the issue paths and codes, which name a place but never a value. */
function issuePaths(issues: readonly { path: readonly PropertyKey[]; code: string }[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.map((segment) => String(segment)).join('.');
      return where === '' ? `<root> (${issue.code})` : `${where} (${issue.code})`;
    })
    .join(', ');
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
