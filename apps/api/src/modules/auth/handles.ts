/**
 * Pseudonymous handles and avatar seeds, minted when an account is created
 * (AAP 0.1.1 requirement 1, AAP 0.5.1 Auth component). Trust in Tablemate comes from a verified
 * itinerary proof and a venue-witnessed check-in, never from identity disclosure (AAP 0.7.2), so a
 * handle is drawn from the closed vocabulary below and never from an email address, a name or any
 * other user input.
 */
import { randomBytes, randomInt } from 'node:crypto';

/**
 * The adjectives a handle may start with: neutral, friendly words, each 3 to 8 lowercase ASCII
 * letters so that every minted handle matches {@link HANDLE_PATTERN}, and none of them a name, a
 * brand or a place in any launch language.
 *
 * `prettier-ignore` keeps the closed lists compact: they are one word per line under Prettier's
 * rules, which alone would cost 64 lines of a module budgeted at about 60.
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

/**
 * The shape of every handle this module mints: one adjective, one noun and a four-digit suffix, so
 * at most 22 characters, which fits `Tier0Profile.handle` and the dashboard's columns.
 */
export const HANDLE_PATTERN = /^[a-z]{3,8}-[a-z]{3,8}-\d{4}$/;

/**
 * How many times account creation may retry with a fresh handle before it gives up. Uniqueness is
 * not checked here — the unique index on `User.handle` enforces it (AAP 0.5.2) — and with 32 x 32 x
 * 10,000 possible handles the caller's retry resolves the rare collision.
 */
export const MAX_HANDLE_ATTEMPTS = 5;

/** Exclusive upper bound of the handle's four-digit suffix. */
const SUFFIX_RANGE = 10_000;

/**
 * A new pseudonymous handle, such as `quiet-heron-4821`. Randomness comes from `node:crypto`, never
 * `Math.random`, because a guessable handle would let one traveler impersonate another.
 *
 * The function is pure apart from that randomness — no I/O, no clock, no database — and it checks
 * no uniqueness, so an account-creating caller retries at most {@link MAX_HANDLE_ATTEMPTS} times.
 */
export function generateHandle(): string {
  const adjective = pick(ADJECTIVES);
  const noun = pick(NOUNS);
  const suffix = randomInt(0, SUFFIX_RANGE).toString().padStart(4, '0');
  return `${adjective}-${noun}-${suffix}`;
}

/**
 * A new avatar seed: 32 lowercase hex characters from 16 random bytes. The value is opaque, since
 * the client derives a generated avatar from it and the server never renders one, and it carries no
 * personal information, so it is safe to disclose at tier 0.
 */
export function newAvatarSeed(): string {
  return randomBytes(16).toString('hex');
}

/**
 * One word of a vocabulary, chosen uniformly at random. `noUncheckedIndexedAccess` types an indexed
 * read as `string | undefined`, and a vocabulary literal is never empty, so an `undefined` here is
 * impossible and is rejected rather than becoming a malformed handle.
 */
function pick(words: readonly string[]): string {
  const word = words[randomInt(0, words.length)];
  if (word === undefined) {
    throw new RangeError('handle word list is empty');
  }
  return word;
}
