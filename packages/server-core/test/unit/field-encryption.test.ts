import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  FIELD_KEY_ID_PATTERN,
  FieldDecryptionError,
  FieldKeyringError,
  createFieldKeyring,
  decryptField,
  encryptField,
  isValidFieldKey,
  keyringFromEnv,
} from '../../src/crypto/field-encryption.ts';
import type { FieldKeyring } from '../../src/crypto/field-encryption.ts';

const key = (): string => randomBytes(32).toString('base64');

const VALUE_PATTERN = /^[A-Za-z0-9_-]{1,16}\.[A-Za-z0-9_-]+$/;

const IV_BYTES = 12;
const MIN_PAYLOAD_BYTES = IV_BYTES + 16;

function b64url(value: string): [keyId: string, body: Buffer] {
  const separator = value.indexOf('.');
  return [value.slice(0, separator), Buffer.from(value.slice(separator + 1), 'base64url')];
}

function join(keyId: string, body: Buffer): string {
  return `${keyId}.${body.toString('base64url')}`;
}

const payloadOf = (value: string): Buffer => b64url(value)[1];

const ivOf = (value: string): string => payloadOf(value).subarray(0, IV_BYTES).toString('hex');

function withPayload(value: string, body: Buffer, keyId = b64url(value)[0]): string {
  return join(keyId, body);
}

function flipPayloadBit(value: string, index: number): string {
  const [keyId, body] = b64url(value);
  body.writeUInt8(body.readUInt8(index) ^ 1, index);
  return join(keyId, body);
}

function failureOf<Thrown extends Error>(
  run: () => unknown,
  expected: new (...args: never) => Thrown,
): Thrown {
  expect(run).toThrow(expected);
  try {
    run();
  } catch (error) {
    if (error instanceof expected) {
      return error;
    }
    throw error;
  }
  throw new Error('the call was expected to throw');
}

describe('encryptField and decryptField', () => {
  let ring: FieldKeyring;
  beforeEach(() => {
    ring = createFieldKeyring({ currentKeyId: 'k1', keys: { k1: key() } });
  });
  it.each([
    ['a short plaintext', 'hello world'],
    ['an email address', 'traveler@example.com'],
    ['a Thai dish name', 'ข้าวผัดกะเพรา'],
    ['astral-plane characters', '🍜☕️'],
    ['an empty plaintext', ''],
    ['a long plaintext', 'x'.repeat(4096)],
  ])('round-trips %s inside the documented envelope', (_label, plaintext) => {
    const stored = encryptField(ring, plaintext);
    expect(stored).toMatch(VALUE_PATTERN);
    expect(stored.startsWith('k1.')).toBe(true);
    expect(decryptField(ring, stored)).toBe(plaintext);
  });
  it('writes the key id the environment names', () => {
    const fromEnv = keyringFromEnv({
      FIELD_ENCRYPTION_KEY: key(),
      FIELD_ENCRYPTION_KEY_ID: 'env1',
    });
    const stored = encryptField(fromEnv, 'traveler@example.com');
    expect(stored.startsWith('env1.')).toBe(true);
    expect(decryptField(fromEnv, stored)).toBe('traveler@example.com');
  });
  it('stores an empty plaintext as exactly an IV and a tag', () => {
    expect(payloadOf(encryptField(ring, ''))).toHaveLength(MIN_PAYLOAD_BYTES);
  });
  it('draws a fresh IV for equal plaintexts', () => {
    const first = encryptField(ring, 'Fixture Guest');
    const second = encryptField(ring, 'Fixture Guest');
    expect(first).not.toBe(second);
    expect(ivOf(first)).not.toBe(ivOf(second));
    expect(decryptField(ring, first)).toBe('Fixture Guest');
    expect(decryptField(ring, second)).toBe('Fixture Guest');
  });
});

describe('decryptField refuses a tampered value', () => {
  const PLAINTEXT = 'Fixture Guest';
  let k1Key: string;
  let twoKeyRing: FieldKeyring;
  let stored: string;
  beforeEach(() => {
    k1Key = key();
    const ring = createFieldKeyring({ currentKeyId: 'k1', keys: { k1: k1Key } });
    twoKeyRing = createFieldKeyring({ currentKeyId: 'k1', keys: { k1: k1Key, k2: key() } });
    stored = encryptField(ring, PLAINTEXT);
  });
  /** One mutation per row, applied to a value the ring wrote: label, corruption, expected reason. */
  const flipIv = (value: string): string => flipPayloadBit(value, 0);
  const flipTag = (value: string): string => flipPayloadBit(value, IV_BYTES);
  const flipCiphertext = (value: string): string => flipPayloadBit(value, MIN_PAYLOAD_BYTES);
  const truncatePayload = (value: string): string =>
    withPayload(value, payloadOf(value).subarray(0, MIN_PAYLOAD_BYTES - 1));
  const dropLastByte = (value: string): string =>
    withPayload(value, payloadOf(value).subarray(0, -1));
  const dropSeparator = (value: string): string => value.replace('.', '');
  const breakPayload = (): string => 'k1.@@@@';
  const foreignKeyId = (value: string): string => withPayload(value, payloadOf(value), 'k2');
  it.each<[string, (value: string) => string, string]>([
    ['a flipped bit in the IV', flipIv, 'authentication_failed'],
    ['a flipped bit in the auth tag', flipTag, 'authentication_failed'],
    ['a flipped bit in the ciphertext', flipCiphertext, 'authentication_failed'],
    ['a payload under IV plus tag', truncatePayload, 'malformed'],
    ['a payload missing its last byte', dropLastByte, 'authentication_failed'],
    ['no key id separator', dropSeparator, 'malformed'],
    ['a payload that is not base64url', breakPayload, 'malformed'],
    ['a prefix naming a key that did not write it', foreignKeyId, 'authentication_failed'],
  ])('rejects %s', (_label, corrupt, reason) => {
    const error = failureOf(() => decryptField(twoKeyRing, corrupt(stored)), FieldDecryptionError);
    expect(error.reason).toBe(reason);
    expect(error.message).not.toContain(PLAINTEXT);
    expect(error.message).not.toContain(k1Key);
    expect(error.message).not.toContain(stored.slice(stored.indexOf('.') + 1));
  });
  it('reports an unknown key id, and a wrong key under a known one, as different reasons', () => {
    const unknownId = failureOf(
      () => decryptField(twoKeyRing, withPayload(stored, payloadOf(stored), 'zz')),
      FieldDecryptionError,
    );
    const otherKey = failureOf(
      () => decryptField(createFieldKeyring({ currentKeyId: 'k1', keys: { k1: key() } }), stored),
      FieldDecryptionError,
    );
    expect(unknownId.reason).toBe('unknown_key_id');
    expect(unknownId.message).toContain('zz');
    expect(otherKey.reason).toBe('authentication_failed');
  });
});

describe('keyring rotation', () => {
  it('reads values written before a rotation and writes new ones under the new id', () => {
    const k1 = key();
    const before = createFieldKeyring({ currentKeyId: 'k1', keys: { k1 } });
    const after = createFieldKeyring({ currentKeyId: 'k2', keys: { k1, k2: key() } });
    const stored = encryptField(before, 'traveler@example.com');
    expect(decryptField(after, stored)).toBe('traveler@example.com');
    const rewritten = encryptField(after, 'traveler@example.com');
    expect(rewritten.startsWith('k2.')).toBe(true);
    expect(failureOf(() => decryptField(before, rewritten), FieldDecryptionError).reason).toBe(
      'unknown_key_id',
    );
  });
});

describe('createFieldKeyring rejects unusable material', () => {
  it.each([
    ['a 31-byte key', randomBytes(31).toString('base64')],
    ['a 33-byte key', randomBytes(33).toString('base64')],
    ['a string that is not base64', 'not base64!!'],
  ])('rejects %s under a valid key id without echoing it', (_label, badKey) => {
    const error = failureOf(
      () => createFieldKeyring({ currentKeyId: 'k1', keys: { k1: badKey } }),
      FieldKeyringError,
    );
    expect(error.message).toContain('k1');
    expect(error.message).not.toContain(badKey);
  });
  it.each([
    ['a dot', 'a.b'],
    ['an empty id', ''],
    ['17 characters', 'a'.repeat(17)],
  ])('rejects the key id %s', (_label, keyId) => {
    failureOf(
      () => createFieldKeyring({ currentKeyId: 'k1', keys: { [keyId]: key() } }),
      FieldKeyringError,
    );
  });
  it('rejects a current key id no key is supplied for', () => {
    const error = failureOf(
      () => createFieldKeyring({ currentKeyId: 'k9', keys: { k1: key() } }),
      FieldKeyringError,
    );
    expect(error.message).toContain('k9');
  });
  it.each([
    ['the canonical base64 of 32 bytes', true, key()],
    ['the base64 of 31 bytes', false, randomBytes(31).toString('base64')],
    ['the base64 of 33 bytes', false, randomBytes(33).toString('base64')],
    ['a string that is not base64', false, 'not base64!!'],
    ['an empty string', false, ''],
  ])('answers %s for %s', (_label, expected, candidate) => {
    expect(isValidFieldKey(candidate)).toBe(expected);
  });
  it.each([
    ['k1', true],
    ['a'.repeat(16), true],
    ['a.b', false],
    ['', false],
    ['a'.repeat(17), false],
  ])('matches the key id %p: %s', (keyId, expected) => {
    expect(FIELD_KEY_ID_PATTERN.test(keyId)).toBe(expected);
  });
});
