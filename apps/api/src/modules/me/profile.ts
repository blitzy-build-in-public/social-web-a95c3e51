/**
 * Own-profile read and update: the body of `GET /me` and the write behind `PUT /me/profile`
 * (AAP 0.5.1, 0.5.2, 0.5.4).
 *
 * {@link buildMeDto} is the only place `MeDto` is assembled. The caller reads their own account, so
 * no disclosure tier applies: the whole ladder is present, the two tier-3 fields decrypted from
 * their AES-256-GCM ciphertext, and the photo represented by its presence alone — the WebP bytes are
 * served by `GET /users/:userId/photo` (AAP 0.5.2). Nothing on this path carries the account's
 * address: neither its ciphertext, nor its lookup hash, nor the Stripe customer id is selected.
 *
 * {@link updateProfile} writes only the keys the caller sent, in one transaction fenced against
 * account deletion, and answers the profile it wrote. Validation is the shared `ProfileUpdate`, so an
 * unknown key, a tag outside the interest vocabulary, more than three tags, a duplicate tag, a
 * mis-cased country code and a length over its limit are all `400 invalid_field` from the route's
 * validator before this module runs; the photo's refusals — `413 photo_too_large` above 5 MiB,
 * `400 invalid_field` for a format or payload the encoder cannot use — come from `processPhoto`.
 */

import { decryptField, encryptField, FieldDecryptionError } from '@tablemate/server-core';
import { INTEREST_TAGS_MAX, InterestTag } from '@tablemate/shared';
import type { MeDto, ProfileUpdate, ProofStatus } from '@tablemate/shared';
import type { DbClient, DbTx } from '@tablemate/db';

import { AppError } from '../../plugins/errors.ts';
import { variantFor } from '../experiment/assignment.ts';
import { activeClaimFor } from '../lodgings/claims.ts';
import { transact } from '../outbox/write.ts';
import { currentProof, latestProof, validCityIdsFor } from '../proofs/validity.ts';
import type { ProofSummary } from '../proofs/validity.ts';
import { countersFor } from '../reputation/counters.ts';
import { processPhoto, storePhoto } from './photo.ts';
import type { ProcessedPhoto } from './photo.ts';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { AppServices } from '../../app.ts';

/**
 * The two arguments {@link buildMeDto} may take in place of the app's own services (AAP 0.5.4).
 *
 * Both are optional: the ordinary read wants the process's client and the injected clock, and only a
 * caller inside an open transaction has something else to pass.
 */
export interface BuildMeDtoOptions {
  /**
   *
   * A caller already holding a transaction passes its client, because a row written in that
   * transaction is not visible through the process's client yet: `auth/magic-link.ts` builds this
   * payload inside the transaction that creates the account, so the new `User` row reachable only
   * there must be the one the payload reports (ReadCommitted).
   */
  readonly db?: DbClient | DbTx;
  /** The instant proof validity and the 90-day no-show window are judged at. Defaults to `services.clock.now()`. */
  readonly now?: Date;
}

interface UserWrite {
  homeCity?: string | null;
  homeCountryCode?: string | null;
}

/**
 * The `DisclosureProfile` columns `PUT /me/profile` may write, the tier-3 pair already encrypted.
 *
 * One row per user holds all of them, so a body naming one field updates that field and leaves the
 * rest as they stand — which makes the key set of this object the exact set of columns a call changes.
 */
interface DisclosureWrite {
  nickname?: string | null;
  bio?: string | null;
  interestTags?: string[];
  fullNameCiphertext?: string | null;
  externalContactCiphertext?: string | null;
}

/**
 * The tag list a response carries, filtered to the shared vocabulary and capped at
 * `INTEREST_TAGS_MAX` (AAP 0.5.2).
 *
 * `ProfileUpdate` already rejects both, so this guards what is *stored*: a tag later dropped from
 * `INTEREST_TAGS` would otherwise fail every `GET /me` against `MeDto.interestTags`, costing the
 * caller their whole profile to one retired tag.
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
 * A value this process's keyring cannot open is logged and answered `null` rather than raised: one
 * unreadable field must not fail the caller's own profile read. The line carries the event, the user
 * id and the field name — never the ciphertext, never the plaintext (AAP 0.11.1). Any other error is
 * a defect and is not swallowed.
 */
function decryptOrNull(
  services: AppServices,
  userId: string,
  ciphertext: string | null | undefined,
  field: 'fullName' | 'externalContact',
): string | null {
  if (ciphertext === null || ciphertext === undefined) {
    return null;
  }
  try {
    return decryptField(services.keyring, ciphertext);
  } catch (error) {
    if (!(error instanceof FieldDecryptionError)) {
      throw error;
    }
    services.logger.warn({ event: 'me_decrypt_failed', userId, field }, 'me_decrypt_failed');
    return null;
  }
}

/**
 * The `proof` block of the own profile (AAP 0.5.4, 0.5.5).
 *
 * `valid` carries the stay the caller may act on — the city slug, the two calendar dates the circuit
 * proved as `YYYY-MM-DD`, and the last instant the proof is valid — and is the only status that
 * carries them, which makes their presence the marker of a usable proof rather than a stored one.
 * `ProofStatus` has no third value, so a stored proof that is not valid now reads `expired` whether
 * its stay has ended or has not begun; `none` means the account has no proof at all.
 */
function proofOf(current: ProofSummary | null, latest: ProofSummary | null): MeDto['proof'] {
  if (current !== null) {
    return {
      status: 'valid',
      cityId: current.cityId,
      arrivalDate: current.arrivalDate,
      departureDate: current.departureDate,
      validTo: current.validTo.toISOString(),
    };
  }
  const status: ProofStatus = latest === null ? 'none' : 'expired';
  return { status };
}

/**
 * The caller's Table Credit balance, `grants - voids`, in integer USD cents (AAP 0.5.2, 0.5.7).
 *
 * One aggregate over the ledger returns both sums, and the balance is floored at zero so a reversal
 * that outlived its grant cannot answer a response field the contract defines as non-negative.
 * Credit is never spent: the balance is read, has no cash value, and is redeemable at partner venues
 * (AAP 0.7.2).
 */
async function tableCreditCents(db: DbClient | DbTx, userId: string): Promise<number> {
  const totals = await db.tableCreditEntry.groupBy({
    by: ['kind'],
    where: { userId },
    _sum: { amountCents: true },
  });
  let grants = 0;
  let voids = 0;
  for (const total of totals) {
    const cents = total._sum.amountCents ?? 0;
    if (total.kind === 'grant') {
      grants = cents;
    } else {
      voids = cents;
    }
  }
  return Math.max(0, grants - voids);
}

/**
 * Builds the caller's own profile payload (AAP 0.5.4): the `GET /me` body, the body of
 * `PUT /me/profile` after its write, and the `user` property of `VerifyResponse` on a first sign-in.
 *
 * One `findUnique` with an explicit `select` loads the row — never `include`, and never a column the
 * payload does not carry — and the seven things outside it are fetched together: the experiment
 * assignment, the reputation counters, the current and the latest proof, the valid proof cities, the
 * Table Credit balance and the active lodging claim. The payload is then built field by field, so a
 * column added to `User` cannot reach a response by itself.
 *
 * `validCityIds` is the caller's whole proof entitlement, not the one city {@link proofOf} reports:
 * a traveler may hold overlapping valid proofs for several cities, and the client gates the city page
 * and the traveler list on that set rather than on the single stay (AAP 0.5.7, 0.5.8).
 *
 * A missing row, a tombstone (`deletedAt` set) and a row whose handle or avatar seed is gone are all
 * `401 token_invalid`: the first two are the account-deletion refusals every route answers with
 * (AAP 0.5.3), and the third cannot be a signed-in traveler, because both are minted at account
 * creation and nulled only by erasure (AAP 0.1.1, 0.5.2). Refusing beats fabricating a handle.
 *
 * @throws AppError `token_invalid` when the account is unknown, erased or unusable.
 */
export async function buildMeDto(
  services: AppServices,
  userId: string,
  opts: BuildMeDtoOptions = {},
): Promise<MeDto> {
  const db = opts.db ?? services.db;
  const now = opts.now ?? services.clock.now();
  const row = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      handle: true,
      avatarSeed: true,
      role: true,
      homeCity: true,
      homeCountryCode: true,
      ageConfirmedAt: true,
      termsVersion: true,
      deletedAt: true,
      disclosureProfile: {
        select: {
          interestTags: true,
          nickname: true,
          bio: true,
          fullNameCiphertext: true,
          externalContactCiphertext: true,
        },
      },
      // Presence only: the WebP bytes are served by `GET /users/:userId/photo` and have no place in
      // a JSON profile.
      profilePhoto: { select: { userId: true } },
    },
  });
  if (row === null || row.deletedAt !== null) {
    throw new AppError('token_invalid');
  }
  if (row.handle === null || row.avatarSeed === null) {
    throw new AppError('token_invalid');
  }
  const [assignment, reputation, current, latest, validCityIds, creditCents, activeLodgingClaim] =
    await Promise.all([
      variantFor(db, userId),
      countersFor(db, userId, now),
      currentProof(db, userId, now),
      latestProof(db, userId),
      validCityIdsFor(db, userId, now),
      tableCreditCents(db, userId),
      activeClaimFor(services, userId),
    ]);
  return {
    id: row.id,
    handle: row.handle,
    avatarSeed: row.avatarSeed,
    role: row.role,
    homeCity: row.homeCity,
    homeCountryCode: row.homeCountryCode,
    interestTags: interestTagsOf(row.disclosureProfile?.interestTags),
    nickname: row.disclosureProfile?.nickname ?? null,
    bio: row.disclosureProfile?.bio ?? null,
    fullName: decryptOrNull(
      services,
      userId,
      row.disclosureProfile?.fullNameCiphertext,
      'fullName',
    ),
    externalContact: decryptOrNull(
      services,
      userId,
      row.disclosureProfile?.externalContactCiphertext,
      'externalContact',
    ),
    hasPhoto: row.profilePhoto !== null,
    variant: assignment?.variant ?? null,
    consents: {
      ageConfirmedAt: row.ageConfirmedAt?.toISOString() ?? null,
      termsVersion: row.termsVersion,
    },
    proof: proofOf(current, latest),
    validCityIds,
    tableCreditCents: creditCents,
    reputation,
    activeLodgingClaim,
  };
}

/**
 * The `DisclosureProfile` columns a body names, the tier-3 pair encrypted in memory (AAP 0.5.2).
 *
 * Encryption happens here, before the transaction opens, so no row lock is held across it and only
 * ciphertext is ever persisted: the plaintext of the full name and the contact handle reaches neither
 * the database nor a log line (AAP 0.11.1). `interestTags` is copied rather than stored by reference,
 * because a Prisma `String[]` column is written as an array.
 */
function disclosureWriteOf(services: AppServices, body: ProfileUpdate): DisclosureWrite {
  const write: DisclosureWrite = {};
  if (body.nickname !== undefined) {
    write.nickname = body.nickname;
  }
  if (body.bio !== undefined) {
    write.bio = body.bio;
  }
  // An empty array is the contract's way of clearing the list, so the column is written whenever the
  // key is present; the tags are the tier-0 set (AAP 0.5.2).
  if (body.interestTags !== undefined) {
    write.interestTags = [...body.interestTags];
  }
  if (body.fullName !== undefined) {
    write.fullNameCiphertext =
      body.fullName === null ? null : encryptField(services.keyring, body.fullName);
  }
  if (body.externalContact !== undefined) {
    write.externalContactCiphertext =
      body.externalContact === null ? null : encryptField(services.keyring, body.externalContact);
  }
  return write;
}

/**
 * Applies an own-profile edit and answers the profile it wrote (AAP 0.5.1, 0.5.4).
 *
 * Only what the caller sent is touched: an absent key leaves its column as it stands, `null` clears
 * it, and a body with no keys is a valid no-op that still runs the fence. The photo differs in shape
 * rather than in meaning — `null` removes the stored photo and a string replaces it.
 *
 * The write is one transaction: the account-deletion fence first (AAP 0.5.3), then the `User`
 * columns, then the single `DisclosureProfile` row and the photo, so the fields a client changed
 * together commit together. The image encode runs before that transaction opens, which keeps a row
 * lock off a CPU-bound step and lets a refused photo roll back nothing (AAP 0.3.2). The response is
 * read after the commit, so the caller sees exactly what was stored.
 *
 * @throws AppError `token_invalid` after `DELETE /me`, thrown by the fence before any write, or when
 *   the account row is gone.
 * @throws AppError `photo_too_large` (413) or `invalid_field` (400) for a photo that cannot be
 *   stored, thrown before the transaction opens.
 */
export async function updateProfile(
  services: AppServices,
  userId: string,
  body: ProfileUpdate,
): Promise<MeDto> {
  // Three cases, and the difference between them is the difference between leaving a photo alone,
  // removing it and replacing it. Only the third touches the encoder.
  let photo: ProcessedPhoto | null | undefined;
  if (body.photoBase64 === undefined) {
    photo = undefined;
  } else if (body.photoBase64 === null) {
    photo = null;
  } else {
    photo = await processPhoto(body.photoBase64);
  }
  const userWrite: UserWrite = {};
  if (body.homeCity !== undefined) {
    userWrite.homeCity = body.homeCity;
  }
  if (body.homeCountryCode !== undefined) {
    userWrite.homeCountryCode = body.homeCountryCode;
  }
  const disclosureWrite = disclosureWriteOf(services, body);
  await transact(
    services,
    async (tx) => {
      if (Object.keys(userWrite).length > 0) {
        await tx.user.update({ where: { id: userId }, data: userWrite });
      }
      if (Object.keys(disclosureWrite).length > 0) {
        // One row per user, keyed by `userId`: `create` fills the columns this body did not name from
        // their defaults, so a first write of one field sets nothing else.
        await tx.disclosureProfile.upsert({
          where: { userId },
          create: { userId, ...disclosureWrite },
          update: disclosureWrite,
        });
      }
      if (photo !== undefined) {
        await storePhoto(tx, userId, photo);
      }
    },
    { fenceUserId: userId },
  );
  // The key names this call wrote and nothing else: no value, no photo byte, no ciphertext and no
  // plaintext of a tier-3 field ever reaches a log line (AAP 0.11.1).
  services.logger.info(
    {
      event: 'profile_updated',
      userId,
      fields: [
        ...Object.keys(userWrite),
        ...Object.keys(disclosureWrite),
        ...(photo === undefined ? [] : ['photoBase64']),
      ],
    },
    'profile_updated',
  );
  return buildMeDto(services, userId);
}
