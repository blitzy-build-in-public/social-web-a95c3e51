/**
 * The circuit API on the web: the input generator deferred to a chunk of its own, and the input error recognised by the
 * shape the class gives itself (AAP 0.5.5).
 *
 * The web half of the `./circuits` pair whose contract `circuits.ts` declares, held to the neutral half's names and
 * signatures by the annotations below. Everything the package offers is deferred: `loadCircuitApi` is the page's only
 * path to it, and the one dynamic import inside it keeps the generator — by far the heaviest thing in the package — out
 * of the entry chunk the first paint waits on. A fetch that fails rejects with the import's own error, which carries no
 * code, so a proof attempt ends as `unknown_error` rather than as a wrong one of the flow's own codes. This half never
 * loads the package, so no witness input, field value or email byte passes through it.
 */
import type { CircuitInputErrorShape } from './circuits.ts';
/** The neutral half's exports, named once so each export here is checked against its counterpart. */
type NeutralCircuits = typeof import('./circuits.ts');
/** A `snake_case` code, the only form an error's `code` takes in this client. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const loadCircuitApi: NeutralCircuits['loadCircuitApi'] = async () => {
  const circuits = await import('@tablemate/circuits');
  return {
    buildCircuitInputs: circuits.buildCircuitInputs,
    base64ToBytes: circuits.base64ToBytes,
  };
};

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
