/**
 * Pseudonymous handles and avatar seeds: drawn from the closed vocabularies below, never from an
 * email address, a name or any other user input (AAP 0.1.1, 0.5.1, 0.7.2).
 */
import { randomBytes, randomInt } from 'node:crypto';

/**
 * Adjectives a handle may start with: 3 to 8 lowercase ASCII letters, so every handle matches
 * {@link HANDLE_PATTERN}, and none a name, brand or place. `prettier-ignore` keeps the closed list
 * compact; Prettier would otherwise expand it to one word per line.
 */
// prettier-ignore
export const ADJECTIVES = [
  'agile', 'airy', 'bold', 'brave', 'breezy', 'bright', 'brisk', 'calm', 'cheerful', 'clever',
  'crisp', 'eager', 'friendly', 'gentle', 'golden', 'happy', 'hearty', 'jolly', 'kind', 'lively',
  'lucky', 'mild', 'nimble', 'patient', 'peaceful', 'polite', 'quiet', 'ready', 'steady', 'sunlit',
  'swift', 'tidy',
] as const;

/** The nouns a handle may end with: animals, plants and landscape words, chosen as above. */
// prettier-ignore
export const NOUNS = [
  'aspen', 'badger', 'bamboo', 'birch', 'cedar', 'comet', 'coral', 'creek', 'ember', 'fern',
  'finch', 'glade', 'harbor', 'heron', 'lagoon', 'larch', 'lotus', 'lynx', 'maple', 'meadow',
  'mist', 'moss', 'otter', 'pebble', 'pine', 'quartz', 'reef', 'river', 'sparrow', 'thistle',
  'tide', 'walnut',
] as const;

/** One adjective, one noun and a four-digit suffix: at most 22 characters, the width `Tier0Profile.handle` allows. */
export const HANDLE_PATTERN = /^[a-z]{3,8}-[a-z]{3,8}-\d{4}$/;

/** Retries before account creation gives up: uniqueness comes from the unique index on `User.handle` (AAP 0.5.2), not from a check here. */
export const MAX_HANDLE_ATTEMPTS = 5;

/** Exclusive upper bound of the handle's four-digit suffix. */
const SUFFIX_RANGE = 10_000;

/**
 * A new pseudonymous handle. Randomness comes from `node:crypto`, never `Math.random`, because a
 * guessable handle would let one traveler impersonate another.
 */
export function generateHandle(): string {
  const adjective = pick(ADJECTIVES);
  const noun = pick(NOUNS);
  const suffix = randomInt(0, SUFFIX_RANGE).toString().padStart(4, '0');
  return `${adjective}-${noun}-${suffix}`;
}

/**
 * A new avatar seed: 32 lowercase hex characters from 16 random bytes, opaque and carrying no
 * personal information, so it is safe to disclose at tier 0.
 */
export function newAvatarSeed(): string {
  return randomBytes(16).toString('hex');
}

/**
 * One word of a vocabulary, chosen uniformly at random; a vocabulary literal is never `undefined`,
 * so the `noUncheckedIndexedAccess` read is rejected rather than becoming a malformed handle.
 */
function pick(words: readonly string[]): string {
  const word = words[randomInt(0, words.length)];
  if (word === undefined) {
    throw new RangeError('handle word list is empty');
  }
  return word;
}
