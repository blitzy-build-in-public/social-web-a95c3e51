/**
 * This client's circuit API as each platform can reach it: the witness input generator, the base64 decoder the intakes
 * share, and the way a platform recognises the generator's own error (AAP 0.5.1, AAP 0.5.5).
 *
 * The neutral half of a platform pair, resolved by an extensionless `./circuits` import on iOS, Android and in a Node
 * test process; `circuits.web.ts` is the web half, and `tsconfig.json` type-checks this file, through `moduleSuffixes`,
 * as the contract both halves satisfy. A React Native bundle cannot split its route graph, so this half imports
 * `@tablemate/circuits` statically. Client-safe on both halves: no `expo-*`, no `react-native`, no native module, no
 * Node built-in and no global `Buffer`.
 */
import { CircuitInputError, base64ToBytes, buildCircuitInputs } from '@tablemate/circuits';
import type { CircuitInputErrorCode } from '@tablemate/circuits';
/**
 * The input generator's error as a caller can recognise it without holding its class: the class sets
 * `name = 'CircuitInputError'` and carries a `snake_case` {@link CircuitInputErrorCode}, and nothing else about it
 * travels — an error here never names a message, a field value or a booking reference.
 */
export interface CircuitInputErrorShape {
  /** The class's own name, the only marker a half without the class can test. */
  readonly name: 'CircuitInputError';
  /** The reason the input was refused. */
  readonly code: CircuitInputErrorCode;
}

export type CircuitInputErrorPredicate = (error: unknown) => error is CircuitInputErrorShape;

export interface CircuitApi {
  readonly buildCircuitInputs: typeof buildCircuitInputs;
  readonly base64ToBytes: typeof base64ToBytes;
}

export function loadCircuitApi(): Promise<CircuitApi> {
  return Promise.resolve({ buildCircuitInputs, base64ToBytes });
}

export function isCircuitInputError(error: unknown): error is CircuitInputErrorShape {
  return error instanceof CircuitInputError;
}
