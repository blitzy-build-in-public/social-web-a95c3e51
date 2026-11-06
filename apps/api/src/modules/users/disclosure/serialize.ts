/**
 * Disclosure layer 3 of 3: the tier's allowlist copied into a fresh object and parsed through the
 * tier's own schema, plus the two readers every profile response is built from (AAP 0.5.1, 0.5.4).
 *
 * `computeTier` (`tier.ts`) decides which tier a viewer has earned toward a target and
 * `selectForTier` (`select.ts`) loads only the columns behind that tier's fields; this file turns
 * that row into the response. {@link serializeProfile} walks `TIER_FIELDS[tier]`, calls one builder
 * per field from an exhaustive map and ends in `PROFILE_SCHEMA_BY_TIER[tier]`, whose strip mode
 * drops every key the schema does not declare. A row is never spread, so a column added to `User`
 * tomorrow cannot reach a response by accident, and a field above the viewer's tier is never loaded,
 * let alone returned (AAP 0.3.2, 0.12.2, criterion 5).
 *
 * {@link loadProfile} is one target for one viewer, {@link loadProfiles} a page of targets each at its
 * own pair's tier, and {@link tier0Profiles} a page of strangers. None writes: no transaction, no
 * lock, and the instant they reason about arrives as the `now` argument from the caller's injected
 * clock, never from the process (AAP 0.11.1).
 *
 * @see AAP 0.5.4 for the tier fields and the gates they feed, 0.5.7 for the tier and reputation
 *   rules, 0.5.2 for the tier-3 ciphertext and the tombstone, 0.8.1 for this file.
 */

import { decryptField, FieldDecryptionError } from '@tablemate/server-core';
import {
  INTEREST_TAGS_MAX,
  InterestTag,
  PROFILE_SCHEMA_BY_TIER,
  TIER_FIELDS,
} from '@tablemate/shared';
import type {
  AnyTierProfile,
  DisclosureTier,
  ProfileField,
  Reputation,
  Tier0Profile,
  Tier1Profile,
  Tier2Profile,
  Tier3Profile,
  TierResult,
} from '@tablemate/shared';

import { countersFor, countersForMany } from '../../reputation/counters.ts';
import { currentProof, currentProofsFor } from '../../proofs/validity.ts';
import type { ProofSummary } from '../../proofs/validity.ts';
import { selectForTier } from './select.ts';
import type { ProfileRow } from './select.ts';
import { canMessageFrom, pairFacts, pairFactsFor, tierFrom } from './tier.ts';
import type { PairFacts } from './tier.ts';

import type { AppServices } from '../../../app.ts';

/** What serializing one profile needs from the app's services (AAP 0.5.4). */
export type SerializationServices = Pick<AppServices, 'keyring' | 'logger'>;

/** What the two readers need: serializing, plus the database their extras come from. */
export type ReaderServices = Pick<AppServices, 'db' | 'keyring' | 'logger'>;

/**
 * The response type of each tier, over the shared profile schemas (AAP 0.5.4). A map rather than the
 * union, so a caller holding the tier keeps the exact type instead of the union of all four.
 */
export type ProfileByTier = {
  0: Tier0Profile;
  1: Tier1Profile;
  2: Tier2Profile;
  3: Tier3Profile;
};

/**
 * The response schema of a tier, for a route that declares `AnyTierProfile` and serializes with this
 * (AAP 0.5.4). Every field a tier adds is required and nullable rather than optional, so the union
 * never narrows a higher-tier payload to a lower tier's shape.
 *
 * @param tier - The tier `computeTier` returned; `'blocked'` is not a tier and reaches no schema.
 * @returns The tier's schema from the shared contract.
 */
export function profileSchemaFor<T extends DisclosureTier>(
  tier: T,
): (typeof PROFILE_SCHEMA_BY_TIER)[T] {
  return PROFILE_SCHEMA_BY_TIER[tier];
}

/**
 * The fields of a profile that come from outside the row (AAP 0.5.4).
 *
 * `reputation` is always present, because every user has counters and an empty history is zeroes;
 * `currentProof` is `null` for a traveler with no valid proof, which is what leaves `currentCityId`
 * and `proofDates` `null`; `canMessage` belongs to the viewer-and-target pair, not to the target.
 */
export type ProfileExtras = {
  reputation: Reputation;
  currentProof: ProofSummary | null;
  canMessage: boolean;
};

/**
 * The disclosure columns any tier's select loads, as one structural view (AAP 0.5.4).
 *
 * `ProfileRow<DisclosureTier>` is a union of four payloads, and a tier-0 payload carries neither
 * `profilePhoto` nor a ciphertext, so a builder cannot read those off the union directly. Widening
 * once gives every builder one shape to read: each field it touches is either loaded by the tier the
 * profile is built for — which `selectForTier` guarantees and the parse below enforces — or absent,
 * which the builder answers as `null`, `false` or `[]`.
 */
interface DisclosureColumns {
  readonly interestTags?: readonly string[];
  readonly nickname?: string | null;
  readonly bio?: string | null;
  readonly fullNameCiphertext?: string | null;
  readonly externalContactCiphertext?: string | null;
}

/** One row of any tier's select, as the builders read it. */
interface ProfileSource {
  readonly id: string;
  readonly handle: string | null;
  readonly avatarSeed: string | null;
  readonly homeCountryCode: string | null;
  readonly disclosureProfile: DisclosureColumns | null;
  readonly profilePhoto?: { readonly userId: string } | null;
}

/** What one field builder may read: the widened row, the extras and the two services it needs. */
interface BuildContext {
  readonly row: ProfileSource;
  readonly extras: ProfileExtras;
  readonly services: SerializationServices;
}

/** Builds one response field. A builder's output is checked by the tier's schema, not by a type. */
type FieldBuilder = (context: BuildContext) => unknown;

/**
 * The counters of a user with no witnessed meetup and no no-show (AAP 0.5.7), frozen because more
 * than one profile may be handed it. `countersForMany` zero-fills every id it is asked for, so this
 * stands in only for an id that did not reach that map.
 */
const EMPTY_REPUTATION: Reputation = Object.freeze({
  witnessedMeetups: 0,
  distinctCounterparts: 0,
  distinctVenues: 0,
  distinctCities: 0,
  noShows90d: 0,
});

/**
 * The stay dates a viewer receives, from the current valid proof (AAP 0.5.4). Day precision, as the
 * circuit proved them: no time, nullifier or registry root, and `null` without a valid proof.
 */
function proofDatesOf(
  proof: ProofSummary | null,
): { arrivalDate: string; departureDate: string } | null {
  return proof === null
    ? null
    : { arrivalDate: proof.arrivalDate, departureDate: proof.departureDate };
}

/**
 * The tag list a viewer receives, filtered to the shared vocabulary and capped (AAP 0.5.2).
 *
 * `PUT /me/profile` already rejects a tag outside `INTEREST_TAGS` and more than `INTEREST_TAGS_MAX`,
 * so this is a fail-safe for what is stored: a tag later dropped from the vocabulary would otherwise
 * fail every profile read in the app, and an over-long list would fail the tier schema inside a
 * response. Filtering first and capping second keeps the tags a profile legitimately has.
 */
function interestTagsOf(tags: readonly string[] | undefined): InterestTag[] {
  const kept: InterestTag[] = [];
  for (const tag of tags ?? []) {
    const parsed = InterestTag.safeParse(tag);
    if (!parsed.success) {
      continue;
    }
    kept.push(parsed.data);
    if (kept.length === INTEREST_TAGS_MAX) {
      break;
    }
  }
  return kept;
}

/**
 * A tier-3 field, decrypted, or `null` when it is unset or unreadable (AAP 0.5.2).
 *
 * Only tier 3 reaches this function: `TIER_FIELDS[3]` alone holds `fullName` and `externalContact`,
 * and the tier-3 select is the only one that loads their ciphertext. A value this keyring cannot
 * open is logged and answered as `null` rather than raised, because one unreadable field must not
 * fail the whole profile read. The log carries the event, the user id and the field name — never the
 * ciphertext, never the plaintext (AAP 0.11.1).
 *
 * @throws Whatever the ring raised, when it is not a {@link FieldDecryptionError}: a value we cannot
 *   read is answered `null`, while any other error is a bug and is not swallowed.
 */
function decryptFieldOrNull(
  context: BuildContext,
  field: 'fullName' | 'externalContact',
): string | null {
  const ciphertext =
    field === 'fullName'
      ? context.row.disclosureProfile?.fullNameCiphertext
      : context.row.disclosureProfile?.externalContactCiphertext;

  if (ciphertext === null || ciphertext === undefined) {
    return null;
  }

  try {
    return decryptField(context.services.keyring, ciphertext);
  } catch (error) {
    if (!(error instanceof FieldDecryptionError)) {
      throw error;
    }
    context.services.logger.warn({
      event: 'disclosure_decrypt_failed',
      userId: context.row.id,
      field,
    });
    return null;
  }
}

/**
 * One builder per response field, exhaustive over `ProfileField` (AAP 0.5.4): a field added to the
 * shared allowlist stops the build until it has a builder here. Each output is that field's value
 * alone; the tier's schema is what decides whether the combination is a profile.
 */
const BUILDERS: Record<ProfileField, FieldBuilder> = {
  id: ({ row }) => row.id,
  handle: ({ row }) => row.handle,
  avatarSeed: ({ row }) => row.avatarSeed,
  homeRegion: ({ row }) => row.homeCountryCode,
  currentCityId: ({ extras }) => extras.currentProof?.cityId ?? null,
  proofDates: ({ extras }) => proofDatesOf(extras.currentProof),
  reputation: ({ extras }) => extras.reputation,
  interestTags: ({ row }) => interestTagsOf(row.disclosureProfile?.interestTags),
  nickname: ({ row }) => row.disclosureProfile?.nickname ?? null,
  bio: ({ row }) => row.disclosureProfile?.bio ?? null,
  canMessage: ({ extras }) => extras.canMessage,
  hasPhoto: ({ row }) => row.profilePhoto !== null && row.profilePhoto !== undefined,
  externalContact: (context) => decryptFieldOrNull(context, 'externalContact'),
  fullName: (context) => decryptFieldOrNull(context, 'fullName'),
};

/**
 * Parses a built object through its tier's schema (AAP 0.5.4).
 *
 * The file's one cast, and the step the compiler cannot follow: `profileSchemaFor(tier)` types as
 * the union of the four schemas, whose output is the union of the four profiles, while the schema
 * actually held is that tier's own — whose output is `ProfileByTier[T]` by construction of
 * `PROFILE_SCHEMA_BY_TIER`. That each schema's key set is exactly its tier's field list is the
 * invariant behind it, held by `packages/shared/test/tiers.test.ts`. A parse failure throws: failing
 * closed leaves the caller with `500 internal_error`, where returning the unparsed object would
 * answer with something no schema has vouched for (AAP 0.12.2).
 */
function parseProfile<T extends DisclosureTier>(tier: T, value: unknown): ProfileByTier[T] {
  return profileSchemaFor(tier).parse(value) as ProfileByTier[T];
}

/**
 * Serializes one loaded row into the profile its viewer has earned (AAP 0.5.1, 0.5.4).
 *
 * The output is a NEW object holding the tier's fields and nothing else: the row is read through the
 * builders and never spread, because a serialized profile is the last place a column the select
 * happened to load could escape. The tier's own schema then parses the result, so a builder's
 * mistake fails the request instead of reaching a viewer.
 *
 * @param services - The keyring the tier-3 fields are decrypted with, and the logger a decryption
 *   failure is recorded on.
 * @param row - A row loaded with `selectForTier(tier)`: a builder reads only fields that tier loads.
 * @param tier - The tier for the viewer, from `computeTier` or `tierFrom`.
 * @param extras - The reputation counters, the current proof and the pair's messaging gate.
 * @returns The tier's profile, parsed.
 * @throws ZodError when a built field does not satisfy the tier's schema.
 */
export function serializeProfile<T extends DisclosureTier>(
  services: SerializationServices,
  row: ProfileRow<DisclosureTier>,
  tier: T,
  extras: ProfileExtras,
): ProfileByTier[T] {
  const context: BuildContext = { row, extras, services };
  const out: Record<string, unknown> = {};

  for (const field of TIER_FIELDS[tier]) {
    out[field] = BUILDERS[field](context);
  }

  return parseProfile(tier, out);
}

/** What {@link loadProfile} answers: the tier its viewer earned, and the profile that tier produced. */
export interface LoadedProfile {
  readonly tier: DisclosureTier;
  readonly profile: AnyTierProfile;
}

/**
 * Loads one target's profile for one viewer, at the tier between them (AAP 0.5.1, 0.5.4).
 *
 * Layers 1 to 3 in order: the pair's facts decide the tier, the tier's select loads only its columns
 * and {@link serializeProfile} builds and parses the response. A viewer's own row is never gated —
 * self-view answers tier 3 without a pair query — and the comparison lowercases both ids, as
 * `tier.ts`'s own self check does, because an id can arrive from a path in any case and `pairFacts`
 * refuses a pair of one user against themselves.
 *
 * @param services - The database, keyring and logger.
 * @param viewerId - The id of the user doing the looking.
 * @param targetId - The id of the user being looked at.
 * @param now - The instant proof validity is judged at; from `request.receivedAt` or
 *   `services.clock.now()`, never from the process.
 * @param opts - `blocked: 'tier0'` answers tier 0 for a blocked target instead of `null`, for a
 *   counterpart shown inside the viewer's own existing meetup. The default, `'hide'`, is the
 *   `404 user_not_found` a profile route answers for a block in either direction.
 * @returns The tier and profile, or `null` for a target that must not be served at all: a block in
 *   either direction, an unknown id, a deleted or deletion-requested user, or a tombstone whose
 *   `handle` and `avatarSeed` account erasure nulled (AAP 0.5.2, 0.5.4).
 */
export async function loadProfile(
  services: ReaderServices,
  viewerId: string,
  targetId: string,
  now: Date,
  opts?: { blocked?: 'hide' | 'tier0' },
): Promise<LoadedProfile | null> {
  const self = viewerId.toLowerCase() === targetId.toLowerCase();

  // A self pair has no row in either table to read facts from, so its facts are stated rather than
  // queried, and `tierFrom` never sees them: a user's own view is all four tiers by definition.
  const facts: PairFacts = self
    ? { blocked: false, completedCount: 0, sharedLockedBothHeld: false, messageable: false }
    : await pairFacts(services.db, viewerId, targetId);
  const result: TierResult = self ? 3 : tierFrom(facts);

  if (result === 'blocked' && opts?.blocked !== 'tier0') {
    return null;
  }

  const tier: DisclosureTier = result === 'blocked' ? 0 : result;

  const [row, reputation, proof] = await Promise.all([
    services.db.user.findFirst({
      where: { id: targetId, deletedAt: null, deletionRequestedAt: null },
      select: selectForTier(tier),
    }),
    countersFor(services.db, targetId, now),
    currentProof(services.db, targetId, now),
  ]);

  if (row === null || row.handle === null || row.avatarSeed === null) {
    return null;
  }

  return {
    tier,
    profile: serializeProfile(services, row, tier, {
      reputation,
      currentProof: proof,
      canMessage: canMessageFrom(facts, viewerId, targetId),
    }),
  };
}

/**
 * The facts of a self pair, stated rather than read (AAP 0.5.7).
 *
 * A viewer looking at themselves has no row in `block`, `pair_history` or `meetup` to measure, which
 * is why {@link pairFacts} refuses such a pair; the tier follows from the self check alone and
 * `canMessageFrom` is false for a self pair whatever these facts say.
 */
const SELF_PAIR_FACTS: PairFacts = {
  blocked: false,
  completedCount: 0,
  sharedLockedBothHeld: false,
  messageable: false,
};

/**
 * Loads a page of targets' profiles for one viewer, each at the tier between them (AAP 0.5.1, 0.5.4).
 *
 * The batched form of {@link loadProfile}, for every counterpart of a meetup page. It applies the
 * same rules in the same order — a self id is tier 3 with stated facts and no pair query, every
 * other id takes its facts from `pairFactsFor` and `tierFrom`, a `'blocked'` result is tier 0 under
 * `blocked: 'tier0'` and is left out entirely otherwise, and an id with no row, or with the `handle`
 * or `avatarSeed` account erasure nulled, is not served — but pays them once for the whole page
 * rather than once per id: one pair-facts statement, one `user` read per tier the page actually
 * holds (at most four, each carrying its own `selectForTier`), one counters call and one
 * current-proof read, whatever the page's length (AAP 0.12.2). Batching widens nothing: a tier's
 * columns are still the only columns loaded for the ids of that tier, and {@link serializeProfile}
 * still builds each profile from its tier's allowlist.
 *
 * @param services - The database, keyring and logger.
 * @param viewerId - The id of the user doing the looking.
 * @param targetIds - The ids being looked at, in the order the answer must hold them; duplicates ask
 *   for the same profile twice, and an empty request queries nothing.
 * @param now - The instant proof validity is judged at; from `request.receivedAt` or
 *   `services.clock.now()`, never from the process.
 * @param opts - `blocked: 'tier0'` answers tier 0 for a blocked target instead of `null`, for the
 *   counterparts shown inside the viewer's own meetups, exactly as {@link loadProfile} does.
 * @returns One entry per requested id, in request order: the tier and its profile, or `null` for a
 *   target that must not be served at all — a block under the default `'hide'`, an unknown id, a
 *   deleted or deletion-requested user, or a tombstone whose `handle` and `avatarSeed` account
 *   erasure nulled (AAP 0.5.2, 0.5.4).
 * @throws ZodError when a built field does not satisfy its tier's schema.
 */
export async function loadProfiles(
  services: ReaderServices,
  viewerId: string,
  targetIds: readonly string[],
  now: Date,
  opts?: { blocked?: 'hide' | 'tier0' },
): Promise<(LoadedProfile | null)[]> {
  const selfKey = viewerId.toLowerCase();
  const wanted = [...new Set(targetIds.map((id) => id.toLowerCase()))];

  if (wanted.length === 0) {
    return [];
  }

  // Every id but the viewer's own, in one statement; the self id never reaches it, as `loadProfile`
  // never reaches `pairFacts` with a self pair.
  const factsByKey = await pairFactsFor(
    services.db,
    viewerId,
    wanted.filter((key) => key !== selfKey),
  );

  /** The ids that are served, with the tier each earned and the facts that decided it. */
  const served = new Map<string, { tier: DisclosureTier; facts: PairFacts }>();

  if (wanted.includes(selfKey)) {
    served.set(selfKey, { tier: 3, facts: SELF_PAIR_FACTS });
  }

  for (const [key, facts] of factsByKey) {
    const result = tierFrom(facts);

    if (result === 'blocked' && opts?.blocked !== 'tier0') {
      continue;
    }

    served.set(key, { tier: result === 'blocked' ? 0 : result, facts });
  }

  const byTier = new Map<DisclosureTier, string[]>();
  for (const [key, entry] of served) {
    const ids = byTier.get(entry.tier);
    if (ids === undefined) {
      byTier.set(entry.tier, [key]);
    } else {
      ids.push(key);
    }
  }

  const rowByKey = new Map<string, ProfileRow<DisclosureTier>>();

  for (const [tier, ids] of byTier) {
    const rows = await services.db.user.findMany({
      where: { id: { in: ids }, deletedAt: null, deletionRequestedAt: null },
      select: selectForTier(tier),
    });

    for (const row of rows) {
      rowByKey.set(row.id, row);
    }
  }

  const servedKeys = [...served.keys()];
  const [counters, proofs] = await Promise.all([
    countersForMany(services.db, servedKeys, now),
    currentProofsFor(services.db, servedKeys, now),
  ]);

  return targetIds.map((targetId) => {
    const key = targetId.toLowerCase();
    const entry = served.get(key);

    if (entry === undefined) {
      return null;
    }

    const row = rowByKey.get(key);

    if (row === undefined || row.handle === null || row.avatarSeed === null) {
      return null;
    }

    return {
      tier: entry.tier,
      profile: serializeProfile(services, row, entry.tier, {
        reputation: counters.get(key) ?? EMPTY_REPUTATION,
        currentProof: proofs.get(key) ?? null,
        canMessage: canMessageFrom(entry.facts, viewerId, targetId),
      }),
    };
  });
}

/**
 * Builds the tier-0 profile of every requested user, in the order they were requested (AAP 0.5.4).
 *
 * Discovery (`cities/discovery.ts`), lodging guest lists (`lodgings/visibility.ts`) and counterpart
 * lists all show strangers, so every item is tier 0 whatever the caller's tier is, and a page costs
 * four queries rather than two per row. This function does not know the viewer and cannot exclude a
 * blocked pair: a caller that knows the viewer excludes those in its own query. Unknown ids, deleted
 * and deletion-requested users and tombstones are absent from the result rather than answered as
 * empty profiles, which is what makes an erased user vanish from every list (AAP 0.5.2).
 *
 * @param services - The database, keyring and logger.
 * @param userIds - The ids whose profiles are wanted; duplicates are collapsed, and an empty request
 *   queries nothing.
 * @param now - The instant proof validity is judged at, from the caller's injected clock.
 * @returns One tier-0 profile per servable user, in the order of first appearance in `userIds`.
 */
export async function tier0Profiles(
  services: ReaderServices,
  userIds: readonly string[],
  now: Date,
): Promise<Tier0Profile[]> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) {
    return [];
  }

  const [rows, counters, proofs] = await Promise.all([
    services.db.user.findMany({
      where: { id: { in: ids }, deletedAt: null, deletionRequestedAt: null },
      select: selectForTier(0),
    }),
    countersForMany(services.db, ids, now),
    currentProofsFor(services.db, ids, now),
  ]);

  const rowById = new Map<string, ProfileRow<0>>();
  for (const row of rows) {
    rowById.set(row.id, row);
  }

  const profiles: Tier0Profile[] = [];
  for (const id of ids) {
    const row = rowById.get(id);
    if (row === undefined || row.handle === null || row.avatarSeed === null) {
      continue;
    }
    profiles.push(
      serializeProfile(services, row, 0, {
        reputation: counters.get(id) ?? EMPTY_REPUTATION,
        currentProof: proofs.get(id) ?? null,
        canMessage: false,
      }),
    );
  }

  return profiles;
}
