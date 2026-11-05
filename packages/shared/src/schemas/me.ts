/**
 * Own-profile contract (AAP 0.5.4, AAP 0.8.1): the `GET /me` response, which is also the `user`
 * of `VerifyResponse`, plus the bodies of `PUT /me/profile`, `POST /me/consents` and
 * `POST /me/push-tokens`, and the response of `POST /me/payment-setup`.
 *
 * Every schema here serves the authenticated owner, so no disclosure tier applies to them:
 * {@link MeDto} carries the caller's own tier-3 fields, already decrypted, whereas the profile
 * another traveler reads is one of `Tier0Profile` … `Tier3Profile` (AAP 0.5.2, 0.5.4). No schema
 * here carries an email address; the account's address stays on the server (AAP 0.5.4).
 *
 * Responses are `z.object` and strip unknown keys on serialization; request bodies are
 * `z.strictObject` and reject them, which is the `400 invalid_field` of the route table
 * (AAP 0.5.4). Client-safe: `zod` and the shared primitives only — no Node built-in, no DOM
 * global, no top-level side effect — because the same module loads under Hermes and in a browser.
 */
import { z } from 'zod';

import {
  BIO_MAX_CHARS,
  EXTERNAL_CONTACT_MAX_CHARS,
  FULL_NAME_MAX_CHARS,
  HOME_CITY_MAX_CHARS,
  INTEREST_TAGS_MAX,
  NICKNAME_MAX_CHARS,
} from '../constants.ts';
import { LodgingClaimStatus, ProofStatus, PushPlatform, UserRole, Variant } from '../enums.ts';
import { InterestTag } from '../interests.ts';
import { CitySlug, CountryCode, DateOnly, IsoDateTime, Uuid, UsdCents } from './common.ts';
import { Reputation } from './users.ts';

/**
 * The caller's own account, profile, consents and proof state (AAP 0.5.4): the response of
 * `GET /me` and the `user` property of `VerifyResponse`.
 *
 * This is the only profile payload that carries the caller's tier-3 fields, and they are
 * `null` until the caller fills them in. `role` decides whether the web build offers `/ops`,
 * and `variant` is the experiment assignment recorded once at account creation, `null` only
 * before that assignment (AAP 0.5.7).
 *
 * `consents` is unset until the age gate has been passed, which the client reads to route to
 * `app/(auth)/age-gate.tsx`; `proof` then drives the unverified browsing states of AAP 0.5.8 —
 * its `cityId`, `arrivalDate`, `departureDate` and `validTo` are present only alongside a
 * `status` of `valid` (AAP 0.5.5).
 *
 * `tableCreditCents` is the Table Credit balance: the grants less the reversing voids of
 * `TableCreditEntry`, in USD cents, redeemable at partner venues and with no cash value
 * (AAP 0.5.2, 0.5.7). `activeLodgingClaim` is the caller's claim in `pending_call`, `calling`
 * or a `verified` one whose stay has not ended, with the visibility the caller set; it feeds
 * `app/profile/stay.tsx` (AAP 0.5.3, 0.5.8).
 */
export const MeDto = z.object({
  id: Uuid,
  handle: z.string(),
  avatarSeed: z.string(),
  role: UserRole,
  homeCity: z.string().nullable(),
  homeCountryCode: CountryCode.nullable(),
  interestTags: z.array(InterestTag),
  nickname: z.string().nullable(),
  bio: z.string().nullable(),
  fullName: z.string().nullable(),
  externalContact: z.string().nullable(),
  hasPhoto: z.boolean(),
  variant: Variant.nullable(),
  consents: z.object({
    ageConfirmedAt: IsoDateTime.nullable(),
    termsVersion: z.string().nullable(),
  }),
  proof: z.object({
    status: ProofStatus,
    cityId: CitySlug.optional(),
    arrivalDate: DateOnly.optional(),
    departureDate: DateOnly.optional(),
    validTo: IsoDateTime.optional(),
  }),
  tableCreditCents: UsdCents,
  reputation: Reputation,
  activeLodgingClaim: z
    .object({
      id: Uuid,
      lodgingId: Uuid,
      lodgingName: z.string(),
      status: LodgingClaimStatus,
      stayFrom: DateOnly,
      stayTo: DateOnly,
      showStaying: z.boolean(),
    })
    .nullable(),
});
export type MeDto = z.infer<typeof MeDto>;

/**
 * The body of `PUT /me/profile`, the caller's own profile edit (AAP 0.5.4).
 *
 * Every key is optional, so a client sends only what changed, and every scalar key is also
 * nullable, so `null` clears a value. An unknown key, a tag outside the interest vocabulary,
 * more than `INTEREST_TAGS_MAX` (3) tags, a duplicate tag or a length over its limit all fail
 * the schema, which the route answers with `400 invalid_field` (AAP 0.5.4). `interestTags` is an
 * empty array to clear the list rather than a nullable field, and its tags are the tier-0 set
 * (AAP 0.5.2).
 *
 * `photoBase64` is the caller's chosen photo as base64, and `null` removes the stored one. The
 * API decodes it, answers `413 photo_too_large` above `PHOTO_MAX_BYTES` (5 MB) and re-encodes it
 * to WebP at most `PHOTO_MAX_EDGE_PX` (1,024) px on the long edge with every metadata and GPS
 * block stripped, so no location ever rides along (`storePhoto`, AAP 0.5.1, AAP 0.5.2); the
 * route's body limit is `PROFILE_BODY_LIMIT_BYTES` (8 MB), which leaves room for the base64
 * expansion. This schema checks the base64 syntax alone, never the decoded size.
 */
export const ProfileUpdate = z
  .strictObject({
    nickname: z.string().max(NICKNAME_MAX_CHARS).nullable().optional(),
    bio: z.string().max(BIO_MAX_CHARS).nullable().optional(),
    homeCity: z.string().max(HOME_CITY_MAX_CHARS).nullable().optional(),
    homeCountryCode: CountryCode.nullable().optional(),
    fullName: z.string().max(FULL_NAME_MAX_CHARS).nullable().optional(),
    externalContact: z.string().max(EXTERNAL_CONTACT_MAX_CHARS).nullable().optional(),
    interestTags: z.array(InterestTag).max(INTEREST_TAGS_MAX).optional(),
    photoBase64: z.base64().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const tags = value.interestTags;
    if (tags !== undefined && new Set(tags).size !== tags.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Interest tags must be distinct.',
        path: ['interestTags'],
      });
    }
  });
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

/**
 * The body of `POST /me/consents`: "I confirm I am 18 or older.", with the terms version shown
 * at that moment (AAP 0.5.8, AAP 0.12.2).
 *
 * `adult` is the literal `true`, because the age gate is a precondition of every feature route
 * rather than a preference: until the consent is recorded the traveler feature routes answer
 * `403 age_gate_required`. The handler records `ageConfirmedAt` and the version and may refuse a
 * version other than `TERMS_VERSION` with `400 invalid_field` (AAP 0.5.2, 0.5.4).
 */
export const ConsentsRequest = z.strictObject({
  adult: z.literal(true),
  termsVersion: z.string().min(1).max(40),
});
export type ConsentsRequest = z.infer<typeof ConsentsRequest>;

/**
 * The body of `POST /me/push-tokens`: the device's Expo push token and the platform it belongs
 * to (AAP 0.5.2 `PushToken`, AAP 0.3.4).
 *
 * Native builds register a token on iOS and Android; the web build is served email instead, so
 * it sends no token. The push payloads themselves are rendered by
 * `apps/workers/src/notify/templates.ts`.
 */
export const PushTokenRequest = z.strictObject({
  token: z.string().min(1).max(200),
  platform: PushPlatform,
});
export type PushTokenRequest = z.infer<typeof PushTokenRequest>;

/**
 * The response of `POST /me/payment-setup`: the traveler's Stripe Customer, the SetupIntent's
 * client secret and an ephemeral key, which is what `createPaymentSetup` returns so the client
 * can render PaymentSheet on native or the Payment Element on web (AAP 0.5.1, AAP 0.3.4).
 *
 * The card is entered only inside those Stripe components, so no card field exists anywhere in
 * this contract and no raw card data reaches the API (AAP 0.12.2).
 */
export const PaymentSetupResponse = z.object({
  customerId: z.string(),
  setupIntentClientSecret: z.string(),
  ephemeralKeySecret: z.string(),
});
export type PaymentSetupResponse = z.infer<typeof PaymentSetupResponse>;
