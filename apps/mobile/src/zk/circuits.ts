/**
 * This client's circuit API as each platform can reach it: the witness input generator, the base64 decoder the
 * intakes share, and the way a platform recognises the generator's own error (AAP 0.5.1, AAP 0.5.5 "Client input
 * generation", AAP 0.8.1).
 *
 * The neutral half of a platform pair, and the half an extensionless `./circuits` import resolves to on iOS, Android
 * and in a Node test process; `circuits.web.ts` is the web half, and `tsconfig.json` type-checks this file, through
 * `moduleSuffixes`, as the contract both halves satisfy.
 *
 * A React Native bundle cannot split its route graph, so this half imports `@tablemate/circuits` statically and
 * {@link loadCircuitApi} answers from module scope. Client-safe on both halves, which is why the pair exists at all:
 * no `expo-*`, no `react-native`, no native module, no Node built-in and no global `Buffer`, so the package runs
 * under Hermes (React Native 0.76.9) and in a browser alike (AAP 0.5.5).
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

/**
 * Recognises the input generator's refusal. A half with the class in hand tests membership of it; the half without
 * tests the shape above, which is the same answer for the consumer that reads a code.
 */
export type CircuitInputErrorPredicate = (error: unknown) => error is CircuitInputErrorShape;

/**
 * The `@tablemate/circuits` client API, as each half supplies it: the witness input generator the device proves
 * from, and the base64 decoder the `.eml` intakes decode a fixture with — both the package's own functions, so each
 * half is held to the package's own signatures.
 */
export interface CircuitApi {
  /** Builds the complete `TablemateItinerary` witness for one booking confirmation (AAP 0.5.5). */
  readonly buildCircuitInputs: typeof buildCircuitInputs;
  /** Decodes standard base64 to bytes, on a platform whose runtime has no `atob` (AAP 0.5.5). */
  readonly base64ToBytes: typeof base64ToBytes;
}

/**
 * The circuit API of this platform.
 *
 * On this half the package is already loaded, so the promise settles on the microtask queue and a caller's `await`
 * costs one turn, which is what lets the web half be written at the call sites as though the values were local.
 */
export function loadCircuitApi(): Promise<CircuitApi> {
  return Promise.resolve({ buildCircuitInputs, base64ToBytes });
}

/**
 * Whether `error` is the input generator's refusal. This half holds the class itself, so membership is exact rather
 * than nominal: an error built by anything else, however named, is not one (AAP 0.5.5).
 */
export function isCircuitInputError(error: unknown): error is CircuitInputErrorShape {
  return error instanceof CircuitInputError;
}
