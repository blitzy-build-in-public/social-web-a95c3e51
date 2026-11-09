/**
 * The circuit-API pair: each half's recognition of the input generator's error, and the deferred load
 * the web half performs (AAP 0.5.5 "Client input generation", AAP 0.8.1).
 *
 * The pair exists so a caller can read a generator code without the class having to be in the bundle
 * it starts from: iOS and Android test membership of the class, the web tests the shape the class
 * gives itself. The cases below pin both answers against the real generator's error and against
 * errors that merely look like it — a screen shows one sentence per code, so a wrong answer here is a
 * wrong sentence there, and a missing one is the generic failure instead.
 *
 * The deferred half is then exercised the way the app uses it: `loadCircuitApi` is awaited and the
 * values it answers with are checked to be the package's own functions, so the deferred path and the
 * static one cannot drift into different behaviour.
 */
import { CircuitInputError, base64ToBytes, buildCircuitInputs } from '@tablemate/circuits';
import { describe, expect, it } from 'vitest';

import * as neutral from '../src/zk/circuits.ts';
import * as web from '../src/zk/circuits.web.ts';
import { errorCodeOf } from '../src/zk/prover.ts';

/** Four of the generator's own codes: a malformed message, an unregistered issuer, and two fields. */
const GENERATOR_CODES = [
  'eml_malformed',
  'unsupported_issuer',
  'body_hash_mismatch',
  'field_invalid',
] as const;

/** One error that is not the generator's, with the case's own name for it. */
type NotGeneratorError = readonly [label: string, error: unknown];

const NOT_GENERATOR_ERRORS: readonly NotGeneratorError[] = [
  // This client's own error, in the shape every platform file raises it.
  [
    "this client's error",
    Object.assign(new Error('worker_failed'), { name: 'ZkClientError', code: 'worker_failed' }),
  ],
  // A cancelled attempt, which `errorCodeOf` answers from the name alone.
  ['an abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
  // The generator's own code, on a name that is not the generator's.
  ['a code under another name', { name: 'SomeOtherError', code: 'body_hash_mismatch' }],
  // The generator's name, on a code this client would never read.
  [
    'the generator’s name on a code that is not one',
    { name: 'CircuitInputError', code: 'Body Hash Mismatch' },
  ],
  ['a plain error', new Error('body_hash_mismatch')],
];

/** Values that are not errors at all, so neither half may answer true for them. */
const NOT_ERRORS: readonly (readonly [label: string, error: unknown])[] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'body_hash_mismatch'],
  ['a number', 7],
];

describe('the generator’s error, as each half recognises it', () => {
  it.each(GENERATOR_CODES)('reads %s from the error the generator raises', (code) => {
    const error = new CircuitInputError(code);
    expect(neutral.isCircuitInputError(error)).toBe(true);
    expect(web.isCircuitInputError(error)).toBe(true);
    expect(errorCodeOf(error)).toBe(code);
  });

  it.each(NOT_GENERATOR_ERRORS)('refuses %s on both halves', (_label, error) => {
    expect(neutral.isCircuitInputError(error)).toBe(false);
    expect(web.isCircuitInputError(error)).toBe(false);
  });

  it.each(NOT_ERRORS)('refuses %s on both halves', (_label, error) => {
    expect(neutral.isCircuitInputError(error)).toBe(false);
    expect(web.isCircuitInputError(error)).toBe(false);
  });

  it('answers the class’s shape on the half that has no class, and its code either way', () => {
    // What the generator's error reduces to once the package is not loaded: the class's own name and
    // a `snake_case` code. The half holding the class is exact and refuses the copy, and the code
    // still reaches the screen, because `errorCodeOf` reads the shape too.
    const shaped = { name: 'CircuitInputError', code: 'unsupported_issuer' };
    expect(web.isCircuitInputError(shaped)).toBe(true);
    expect(neutral.isCircuitInputError(shaped)).toBe(false);
    expect(errorCodeOf(shaped)).toBe('unsupported_issuer');
  });
});

describe('the circuit API of each half', () => {
  it('answers with the package’s own functions, loaded here and deferred there', async () => {
    const [nativeApi, webApi] = await Promise.all([neutral.loadCircuitApi(), web.loadCircuitApi()]);
    expect(nativeApi.buildCircuitInputs).toBe(buildCircuitInputs);
    expect(webApi.buildCircuitInputs).toBe(buildCircuitInputs);
    expect(nativeApi.base64ToBytes).toBe(base64ToBytes);
    expect(webApi.base64ToBytes).toBe(base64ToBytes);
  });

  it('decodes base64 through the deferred decoder', async () => {
    const { base64ToBytes: deferred } = await web.loadCircuitApi();
    expect(Array.from(deferred('aGVsbG8='))).toEqual([104, 101, 108, 108, 111]);
  });
});
