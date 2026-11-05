import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Shape of a field encryption key id, as set in `FIELD_ENCRYPTION_KEY_ID`. `.` is excluded because
 * it separates the key id from the payload of a stored value, so an id holding one would make that
 * prefix ambiguous. `src/env/common.ts` validates the variable against this pattern.
 */
export const FIELD_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_PAYLOAD_BYTES = IV_BYTES + TAG_BYTES; // IV and tag of an empty plaintext.
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/;
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom'); // Read by `util.inspect`.
const CONSTRUCTION_TOKEN = Symbol('tablemate.field-keyring'); // Module-private; see FieldKeyring.

/**
 * Whether `base64` is the canonical RFC 4648 §4 encoding of one 32-byte AES-256-GCM key, which is
 * what `FIELD_ENCRYPTION_KEY` must hold. `Buffer.from(value, 'base64')` skips invalid characters
 * and accepts base64url, so validity is decided by re-encoding the decoded bytes.
 */
export function isValidFieldKey(base64: string): boolean {
  const decoded = Buffer.from(base64, 'base64');
  return decoded.length === KEY_BYTES && decoded.toString('base64') === base64;
}

/** Raised when a keyring cannot be built or holds no key for an id. Messages name key ids only. */
export class FieldKeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldKeyringError';
  }
}

/** Why a stored value could not be decrypted. */
export type FieldDecryptionReason = 'unknown_key_id' | 'malformed' | 'authentication_failed';

/**
 * Raised when a stored value cannot be decrypted. `reason` lets callers branch without parsing the
 * message, which names the reason and, for `unknown_key_id` only, the key id. It never carries the
 * plaintext, the ciphertext or a key.
 */
export class FieldDecryptionError extends Error {
  readonly reason: FieldDecryptionReason;

  constructor(reason: FieldDecryptionReason, message: string) {
    super(message);
    this.name = 'FieldDecryptionError';
    this.reason = reason;
  }
}

/** A malformed-value failure whose message never repeats the offending value. */
function malformed(detail: string): FieldDecryptionError {
  return new FieldDecryptionError('malformed', `encrypted field is malformed: ${detail}`);
}

/**
 * Names a key id in a message. An over-long or unprintable value may be a key pasted into the id
 * slot, so such a value is described rather than echoed.
 */
function keyIdLabel(keyId: string): string {
  return /^[ -~]{1,32}$/.test(keyId) ? `key id '${keyId}'` : 'key id';
}

/**
 * The AES-256-GCM keys a process may decrypt under, plus the id new values are written with. Key
 * bytes sit in a private field, so only key ids reach `JSON.stringify`, pino output or
 * `util.inspect`. Build one through {@link createFieldKeyring} or {@link keyringFromEnv}: the
 * constructor's token is module-private, so a ring that skipped validation cannot be built.
 */
export class FieldKeyring {
  readonly #keys: Map<string, Buffer>;
  readonly #currentKeyId: string;

  constructor(token: symbol, currentKeyId: string, keys: ReadonlyMap<string, Buffer>) {
    if (token !== CONSTRUCTION_TOKEN) {
      throw new FieldKeyringError('build a keyring with createFieldKeyring or keyringFromEnv');
    }
    this.#currentKeyId = currentKeyId;
    this.#keys = new Map(keys); // Copied, so later mutation of the source cannot alter the ring.
  }

  /** Id written into every value {@link encryptField} produces. */
  get currentKeyId(): string {
    return this.#currentKeyId;
  }

  /** Every id this ring can decrypt under, the retired ones included. */
  get keyIds(): readonly string[] {
    return [...this.#keys.keys()];
  }

  /** Key material for the helpers below; never logged, serialized or handed to a caller. */
  keyFor(keyId: string): Buffer | undefined {
    return this.#keys.get(keyId);
  }

  toJSON(): { currentKeyId: string; keyIds: string[] } {
    return { currentKeyId: this.#currentKeyId, keyIds: [...this.#keys.keys()] };
  }

  [INSPECT_CUSTOM](): { currentKeyId: string; keyIds: string[] } {
    return this.toJSON();
  }
}

/**
 * Builds a keyring from validated key material, decoding each key once.
 *
 * @throws FieldKeyringError when a key id or the current key id fails {@link FIELD_KEY_ID_PATTERN},
 * when a key is not the base64 of 32 bytes, or when `currentKeyId` names no supplied key.
 */
export function createFieldKeyring(input: {
  currentKeyId: string;
  keys: Record<string, string>;
}): FieldKeyring {
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(input.keys)) {
    if (!FIELD_KEY_ID_PATTERN.test(keyId)) {
      throw new FieldKeyringError(`field ${keyIdLabel(keyId)} must match FIELD_KEY_ID_PATTERN`);
    }
    if (!isValidFieldKey(encoded)) {
      throw new FieldKeyringError(`field key for id '${keyId}' must be base64 of 32 bytes`);
    }
    keys.set(keyId, Buffer.from(encoded, 'base64'));
  }
  const currentLabel = keyIdLabel(input.currentKeyId);
  if (!FIELD_KEY_ID_PATTERN.test(input.currentKeyId)) {
    throw new FieldKeyringError(`current ${currentLabel} must match FIELD_KEY_ID_PATTERN`);
  }
  if (!keys.has(input.currentKeyId)) {
    throw new FieldKeyringError(`current key id '${input.currentKeyId}' has no key`);
  }
  return new FieldKeyring(CONSTRUCTION_TOKEN, input.currentKeyId, keys);
}

/**
 * Builds the keyring the environment describes: the current key from `FIELD_ENCRYPTION_KEY_ID` and
 * `FIELD_ENCRYPTION_KEY`, plus `extraKeys` so values written under a retired id still decrypt. A
 * rotation therefore changes the current id and key and leaves every stored value untouched. The
 * environment shape matches the parsed configuration of `src/env/common.ts` and `loadSeedEnv`, so
 * callers pass that validated object straight in.
 *
 * @throws FieldKeyringError when `extraKeys` gives the current id a different key, so a rotation
 * mistake never silently picks one of the two, and for any {@link createFieldKeyring} rejection.
 */
export function keyringFromEnv(
  env: { FIELD_ENCRYPTION_KEY: string; FIELD_ENCRYPTION_KEY_ID: string },
  extraKeys?: Record<string, string>,
): FieldKeyring {
  const keys: Record<string, string> = {};
  for (const [keyId, key] of Object.entries(extraKeys ?? {})) {
    if (keyId === env.FIELD_ENCRYPTION_KEY_ID && key !== env.FIELD_ENCRYPTION_KEY) {
      throw new FieldKeyringError(`extra keys give the current key id '${keyId}' a different key`);
    }
    keys[keyId] = key;
  }
  keys[env.FIELD_ENCRYPTION_KEY_ID] = env.FIELD_ENCRYPTION_KEY;
  return createFieldKeyring({ currentKeyId: env.FIELD_ENCRYPTION_KEY_ID, keys });
}

/**
 * Encrypts one field with AES-256-GCM under the ring's current key and a fresh random IV, so equal
 * plaintexts always produce different values. The result is `<keyId>.<base64url(iv, tag,
 * ciphertext)>`, the shape the ciphertext columns of AAP 0.5.2 hold: the account and magic-link
 * email addresses, the magic link's delivery token, the lodging booking name and reference, the
 * tier-3 full name and contact handle, and the venue and lodging console secrets, which the code
 * generator must read back in the clear.
 *
 * The key id is deliberately not bound as associated data: a swapped prefix selects a different key
 * and fails authentication, and a forged id cannot select a key this ring lacks. One format across
 * every protected column — the seed, the API and the workers all call these functions — is what
 * makes that trade worth taking, so a caller must not read the format as evidence of which column a
 * value came from.
 */
export function encryptField(keyring: FieldKeyring, plaintext: string): string {
  const keyId = keyring.currentKeyId;
  const key = keyring.keyFor(keyId);
  if (key === undefined) {
    throw new FieldKeyringError(`current key id '${keyId}' has no key`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${keyId}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

/**
 * Decrypts a value written by {@link encryptField}, using the key id the value itself carries so
 * that values written before a rotation stay readable.
 *
 * @throws FieldDecryptionError with reason `malformed` when the value is not `<keyId>.<base64url>`
 * or its payload is shorter than IV plus tag, `unknown_key_id` when this ring holds no key for the
 * id, and `authentication_failed` when the IV, the tag or the ciphertext was altered or the value
 * was written under a different key.
 */
export function decryptField(keyring: FieldKeyring, value: string): string {
  const separator = value.indexOf('.');
  if (separator <= 0 || value.indexOf('.', separator + 1) >= 0) {
    throw malformed('expected <keyId>.<payload>');
  }
  const keyId = value.slice(0, separator);
  if (!FIELD_KEY_ID_PATTERN.test(keyId)) {
    throw malformed('key id must match FIELD_KEY_ID_PATTERN');
  }
  const key = keyring.keyFor(keyId);
  if (key === undefined) {
    throw new FieldDecryptionError('unknown_key_id', `no key for id '${keyId}'`);
  }
  const payload = value.slice(separator + 1);
  if (!PAYLOAD_PATTERN.test(payload)) {
    throw malformed('payload is not base64url');
  }
  const body = Buffer.from(payload, 'base64url');
  // A non-canonical payload (skipped characters, padding or trailing bits) re-encodes differently.
  if (body.toString('base64url') !== payload) {
    throw malformed('payload is not canonical base64url');
  }
  if (body.length < MIN_PAYLOAD_BYTES) {
    throw malformed(`payload is under ${MIN_PAYLOAD_BYTES} bytes`);
  }
  const iv = body.subarray(0, IV_BYTES);
  const tag = body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = body.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new FieldDecryptionError('authentication_failed', `auth failed for id '${keyId}'`);
  }
}
