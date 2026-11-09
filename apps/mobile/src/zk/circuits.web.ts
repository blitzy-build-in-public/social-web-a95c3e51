/**
 * The circuit API on the web: the input generator deferred to a chunk of its own, and the input error recognised by
 * the shape the class gives itself (AAP 0.5.5 "Client input generation", AAP 0.8.1).
 *
 * The web half of the `./circuits` pair whose contract `circuits.ts` declares, and the half Metro resolves an
 * extensionless `./circuits` import to in a browser. The two annotations below hold this half to the neutral half's
 * names and signatures by reading them off it, because `moduleSuffixes` type-checks that extensionless import
 * against the neutral file alone.
 *
 * Everything the package offers is deferred: `loadCircuitApi` is the page's only path to it, and the one
 * `import('@tablemate/circuits')` inside it keeps the generator — with the Poseidon hash it carries, by far the
 * heaviest thing in the package — out of the entry chunk the first paint waits on. A fetch that fails rejects with
 * the import's own error, which carries no code, so a proof attempt ends as `unknown_error` rather than as a wrong
 * one of the flow's own codes. This half never loads the package, so no witness input, field value or email byte
 * passes through it (AAP 0.5.5, AAP 0.12.2).
 */
import type { CircuitInputErrorShape } from './circuits.ts';

/** The neutral half's exports, named once so each export here is checked against its counterpart. */
type NeutralCircuits = typeof import('./circuits.ts');

/** A `snake_case` code, the only form an error's `code` takes in this client. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The circuit API of this platform: the package, loaded on first use and shared from then on, because a dynamic
 * `import()` of one specifier evaluates once per page however often it is awaited. The returned functions are the
 * package's own, so nothing is wrapped and no value is copied.
 */
export const loadCircuitApi: NeutralCircuits['loadCircuitApi'] = async () => {
  const circuits = await import('@tablemate/circuits');
  return {
    buildCircuitInputs: circuits.buildCircuitInputs,
    base64ToBytes: circuits.base64ToBytes,
  };
};

/**
 * Whether `error` is the input generator's refusal, recognised by the shape `CircuitInputError` gives itself:
 * `name = 'CircuitInputError'` and a `snake_case` `readonly code`. This half holds no class to test against — the
 * package is not loaded here — and the shape answers exactly what the neutral half's membership test answers for a
 * generator error, so the two halves cannot disagree about the sentence a screen shows.
 */
export const isCircuitInputError: NeutralCircuits['isCircuitInputError'] = (
  error,
): error is CircuitInputErrorShape => {
  if (typeof error !== 'object' || error === null) return false;
  const shape = error as { readonly name?: unknown; readonly code?: unknown };
  return (
    shape.name === 'CircuitInputError' &&
    typeof shape.code === 'string' &&
    CODE_PATTERN.test(shape.code)
  );
};
