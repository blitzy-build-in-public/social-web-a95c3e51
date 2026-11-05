/**
 * The itinerary-proof contract (AAP 0.5.5, AAP 0.8.1): what the device submits, what the API
 * answers, and the zero-knowledge configuration both sides agree on.
 *
 * `ProofSubmission` and every configuration schema below is a `z.strictObject` at every nesting
 * level, because they are parsed from input and an unknown key must be a rejection (AAP 0.12.2);
 * the response DTOs (`ProofAccepted`, `ZkConfig`) are `z.object` and drop unknown keys. The
 * circuit's numeric contracts — the public-signal order, the date-format and charset codes, the
 * registry depth and the issuer-id range — are written down once here and imported, never repeated.
 *
 * Client-safe: `zod` and `./common.ts` are its only imports and it has no side effect, because the
 * client builds proving inputs from `GET /zk/config` under Hermes and in the web Worker
 * (AAP 0.1.2, AAP 0.5.5).
 */

import { z } from 'zod';

import {
  CitySlug,
  DateOnly,
  FieldElement,
  IsoDateTime,
  Sha256Hex,
  Uuid,
  utf8ByteLength,
} from './common.ts';

/* Public signals, the proof and the submission (AAP 0.5.4, AAP 0.5.5). */

/**
 * The seven public signals of `tablemate_itinerary.circom`, in the order snarkjs delivers them: the
 * outputs `cityId`, `arrivalDate`, `departureDate`, `issuerId` and `nullifier` first, then the
 * public inputs `registryRoot` and `nullifierSalt`.
 *
 * Position is part of the contract — a signal is read by index — and any other count is the API's
 * `400 proof_malformed` (AAP 0.5.4). The dates are day-precision `YYYYMMDD` integers, as
 * `lib/date_parse.circom` produces them, and `cityId` is the circuit's integer city id, not a slug.
 */
export const PUBLIC_SIGNAL_NAMES = [
  'cityId',
  'arrivalDate',
  'departureDate',
  'issuerId',
  'nullifier',
  'registryRoot',
  'nullifierSalt',
] as const;

/** One public signal's name, in circuit order (AAP 0.5.5). */
export type PublicSignalName = (typeof PUBLIC_SIGNAL_NAMES)[number];

/** A G1 point of BN254 as snarkjs writes it, each coordinate a decimal field element. */
export const G1Point = z.tuple([FieldElement, FieldElement, FieldElement]);
export type G1Point = z.infer<typeof G1Point>;

/** A G2 point of BN254 as snarkjs writes it — `[[x0, x1], [y0, y1], [1, 0]]` (AAP 0.5.5). */
export const G2Point = z.tuple([
  z.tuple([FieldElement, FieldElement]),
  z.tuple([FieldElement, FieldElement]),
  z.tuple([FieldElement, FieldElement]),
]);
export type G2Point = z.infer<typeof G2Point>;

/**
 * A Groth16 proof over BN254 in the JSON shape `snarkjs.groth16.verify` consumes (AAP 0.5.5).
 *
 * The native prover returns rapidsnark/mopro output, so `apps/mobile/src/zk/prover.native.ts`
 * normalizes it to exactly this shape, adding `curve: 'bn128'`, which mopro omits. Strict, so a
 * proof carrying any other key is rejected before it is verified.
 */
export const Groth16Proof = z.strictObject({
  pi_a: G1Point,
  pi_b: G2Point,
  pi_c: G1Point,
  protocol: z.literal('groth16'),
  curve: z.literal('bn128'),
});
export type Groth16Proof = z.infer<typeof Groth16Proof>;

/**
 * The body of `POST /itinerary-proofs` — the only thing the server ever receives about the email
 * (AAP 0.5.4, AAP 0.12.2). Strict at both levels, so an unknown key at the top level or inside
 * `proof` is the `400 proof_malformed` the route answers, and the signal count is fixed at seven.
 *
 * Guest name, booking reference, email text, address and price are private inputs and appear in
 * neither part (AAP 0.5.5, success criterion 3).
 */
export const ProofSubmission = z.strictObject({
  proof: Groth16Proof,
  publicSignals: z.array(FieldElement).length(PUBLIC_SIGNAL_NAMES.length),
});
export type ProofSubmission = z.infer<typeof ProofSubmission>;

/** The `201` response of `POST /itinerary-proofs`: the stored proof's id and the stay it proves. */
export const ProofAccepted = z.object({
  proofId: Uuid,
  cityId: CitySlug,
  arrivalDate: DateOnly,
  departureDate: DateOnly,
});
export type ProofAccepted = z.infer<typeof ProofAccepted>;

/* Extraction templates (AAP 0.5.5). */

/**
 * The date layouts `lib/date_parse.circom` can parse, selected per issuer template: `ISO_YMD` as in
 * `2026-03-04`, `D_MONTH_YYYY` as in `4 March 2026`, `MONTH_D_YYYY` as in `March 4, 2026` and
 * `DOW_D_MON_YYYY` as in `Wed, 4 Mar 2026`.
 */
export const DateFormat = z.enum(['ISO_YMD', 'D_MONTH_YYYY', 'MONTH_D_YYYY', 'DOW_D_MON_YYYY']);
export type DateFormat = z.infer<typeof DateFormat>;

/**
 * The code each date layout contributes to the template hash, matching `lib/date_parse.circom` and
 * `packages/circuits/src/registry/template-hash.ts`. A template that differs from the registered
 * one in this code hashes to a value with no registry leaf.
 */
export const DATE_FORMAT_CODE = {
  ISO_YMD: 1,
  D_MONTH_YYYY: 2,
  MONTH_D_YYYY: 3,
  DOW_D_MON_YYYY: 4,
} as const satisfies Record<DateFormat, number>;

/**
 * The byte set an extracted value may use: `digits` is `0`-`9`; `alnum` is `A`-`Z`, `a`-`z`, `0`-`9`
 * and `-`; `date` is `alnum` plus the space and the comma the English date layouts need; `text` is
 * the printable ASCII range 0x20-0x7E plus every byte at or above 0x80, so an accented place name or
 * booking reference still extracts.
 */
export const CharsetName = z.enum(['digits', 'alnum', 'date', 'text']);
export type CharsetName = z.infer<typeof CharsetName>;

/**
 * The code each charset contributes to the template hash. `lib/anchor_extract.circom` and
 * `packages/circuits/src/registry/template-hash.ts` implement exactly these sets and codes.
 */
export const CHARSET_CODE = {
  digits: 1,
  alnum: 2,
  date: 3,
  text: 4,
} as const satisfies Record<CharsetName, number>;

/**
 * One extractable field of an issuer's confirmation email: `anchor` is the literal text preceding
 * the value in the decoded body, `terminator` the byte that ends it and `charset` the bytes the
 * value may contain (AAP 0.5.5).
 *
 * The anchor is 1-32 UTF-8 bytes, the circuit's bound, counted with `utf8ByteLength` rather than a
 * platform encoder because this module also runs under Hermes. The circuit requires the anchor to
 * occur exactly once in the body window, so a value can be neither taken from a second occurrence
 * nor padded to another length.
 */
export const TemplateField = z.strictObject({
  anchor: z.string().refine((s) => {
    const bytes = utf8ByteLength(s);
    return bytes >= 1 && bytes <= 32;
  }, 'anchor must be 1–32 UTF-8 bytes'),
  terminator: z.number().int().min(0).max(255),
  charset: CharsetName,
});
export type TemplateField = z.infer<typeof TemplateField>;

/**
 * The registered extraction template of one issuer: where each of the four fields sits and how its
 * dates are written. No field is read from the headers, because the statement places the stay in
 * the email body (AAP 0.5.5).
 */
export const IssuerTemplate = z.strictObject({
  fields: z.strictObject({
    city: TemplateField,
    arrival: TemplateField,
    departure: TemplateField,
    reference: TemplateField,
  }),
  dateFormat: DateFormat,
});
export type IssuerTemplate = z.infer<typeof IssuerTemplate>;

/**
 * One DKIM key record of an issuer (AAP 0.5.5). The records are filled from the `d=` and `s=` tags
 * of a real signed email, and the registry builder derives each `pubkeyHash` from the modulus with
 * the circuit's limb hashing, so no hash is entered by hand.
 */
export const DkimKey = z.strictObject({
  domain: z.string().min(1),
  selector: z.string().min(1),
  modulusBase64: z.base64(),
});
export type DkimKey = z.infer<typeof DkimKey>;

/* Issuers and the registry (AAP 0.5.5). */

/*
 * The scalar fields the issuer configuration, the registry and the published ZK configuration share,
 * written once and referenced wherever they occur (AAP 0.11.1).
 */

/** A circuit `issuerId`: a positive 32-bit integer. */
const issuerIdField = z.number().int().min(1).max(4294967295);

/** A circuit `cityId`: the integer a city slug maps to (`City.circuitCityId`, AAP 0.5.2). */
const circuitCityIdField = z.number().int().min(1);

/** A leaf's index in the registry's fixed-depth-8 tree: 0 to 255. */
const leafIndexField = z.number().int().min(0).max(255);

/**
 * How far an issuer's record has been taken: `awaiting_samples` — no real confirmation email
 * supplied, so no key, no template and no leaf; `unverified` — samples exist and the records are
 * authored from them, but the check has not passed; `verified` — the samples build inputs, witness,
 * prove and verify, the only state that receives a production leaf (AAP 0.5.5).
 */
export const IssuerVerificationStatus = z.enum(['awaiting_samples', 'unverified', 'verified']);
export type IssuerVerificationStatus = z.infer<typeof IssuerVerificationStatus>;

/**
 * One record of `config/issuers/<issuer>.json` before its status rules are applied. Kept unrefined
 * and exported so a caller can extend it without inheriting the refinement below. The synthetic test
 * issuer `tablemate-test` is a record of this shape and appears in the test registry only.
 */
export const IssuerConfigBase = z.strictObject({
  issuerId: issuerIdField,
  displayName: z.string().min(1),
  verificationStatus: IssuerVerificationStatus,
  keys: z.array(DkimKey),
  template: IssuerTemplate.nullable(),
});
export type IssuerConfigBase = z.infer<typeof IssuerConfigBase>;

/**
 * One issuer record with the status rules that keep an invented key or anchor out of the system: an
 * issuer awaiting samples records no key and no template, and one whose samples exist records at
 * least one key and a template. Booking.com and Airbnb ship as `awaiting_samples`; only a `verified`
 * issuer receives a production leaf (AAP 0.5.5).
 */
export const IssuerConfig = IssuerConfigBase.superRefine((value, ctx) => {
  const awaitingSamples = value.verificationStatus === 'awaiting_samples';
  const keyIssue = awaitingSamples
    ? 'An issuer awaiting samples records no DKIM key.'
    : 'An unverified or verified issuer records at least one DKIM key.';
  const templateIssue = awaitingSamples
    ? 'An issuer awaiting samples records no template.'
    : 'An unverified or verified issuer records a template.';

  if (awaitingSamples ? value.keys.length > 0 : value.keys.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['keys'], message: keyIssue });
  }
  if (awaitingSamples ? value.template !== null : value.template === null) {
    ctx.addIssue({ code: 'custom', path: ['template'], message: templateIssue });
  }
});
export type IssuerConfig = z.infer<typeof IssuerConfig>;

/**
 * One issuer key leaf of the registry: the issuer, the key the signature verified under and the
 * template the extraction used, as `Poseidon(1, issuerId, pubkeyHash, templateHash)` records them,
 * with the leaf's index in the tree. The leaf type is a domain tag inside the hash, so an issuer
 * leaf cannot stand in for a city leaf (AAP 0.5.5).
 */
export const RegistryIssuerEntry = z.strictObject({
  issuerId: issuerIdField,
  displayName: z.string().min(1),
  domain: z.string().min(1),
  selector: z.string().min(1),
  pubkeyHash: FieldElement,
  templateHash: FieldElement,
  leafIndex: leafIndexField,
});
export type RegistryIssuerEntry = z.infer<typeof RegistryIssuerEntry>;

/**
 * One city alias leaf: `Poseidon(2, cityId, cityAliasHash)`, where the alias hash is
 * `Poseidon(cityLength, pack(cityBytes)[0], pack(cityBytes)[1])` over the alias exactly as it
 * appears in the decoded body, quoted-printable escapes included (AAP 0.5.5).
 */
export const RegistryCityEntry = z.strictObject({
  cityId: circuitCityIdField,
  slug: CitySlug,
  alias: z.string(),
  aliasHash: FieldElement,
  leafIndex: leafIndexField,
});
export type RegistryCityEntry = z.infer<typeof RegistryCityEntry>;

/**
 * A generated registry file, `config/registry/{production,test}.json`: the leaves and root of the
 * commitment tree the circuit proves membership against, with the readable entries the builder wrote
 * them from. Produced by `pnpm circuits:registry` and committed, never hand-edited.
 *
 * `depth` is the tree's fixed depth of 8, so there are at most 256 leaves, each one issuer key leaf
 * or one city alias leaf — one issuer entry per key leaf and one city entry per alias (AAP 0.5.5).
 */
export const RegistryFile = z.strictObject({
  name: z.enum(['production', 'test']),
  depth: z.literal(8),
  root: FieldElement,
  leaves: z.array(FieldElement).max(256),
  issuers: z.array(RegistryIssuerEntry),
  cities: z.array(RegistryCityEntry),
});
export type RegistryFile = z.infer<typeof RegistryFile>;

/* Proving artefacts and the published ZK configuration (AAP 0.5.4, AAP 0.5.5). */

/**
 * One file of `artifacts.manifest.json`: its name, size in bytes and SHA-256, which the client
 * compares after downloading a proving artefact and whenever size or modification time changed.
 */
export const ArtifactRef = z.strictObject({
  name: z.string().min(1),
  size: z.number().int().positive(),
  sha256: Sha256Hex,
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/**
 * `artifacts.manifest.json`, written by `packages/circuits/scripts/setup.sh` and served by the
 * `artifacts` service. It names the circuit's three files; the `api` container mounts only this
 * manifest and `verification_key.json`, never a proving key (AAP 0.5.5).
 */
export const ArtifactsManifest = z.strictObject({
  circuit: z.string().min(1),
  createdAt: IsoDateTime,
  files: z.strictObject({
    wasm: ArtifactRef,
    zkey: ArtifactRef,
    verificationKey: ArtifactRef,
  }),
});
export type ArtifactsManifest = z.infer<typeof ArtifactsManifest>;

/**
 * A downloadable proving artefact as the published configuration advertises it: where to fetch it
 * and what to expect, so the client hashes what it downloaded without a second round trip. The
 * verification key is not published — it never leaves the server (AAP 0.5.5).
 */
export const ArtifactLink = z.object({
  url: z.url(),
  size: z.number().int().positive(),
  sha256: Sha256Hex,
});
export type ArtifactLink = z.infer<typeof ArtifactLink>;

/**
 * The public `GET /v1/zk/config` response — everything the device needs to build circuit inputs and
 * prove without a DNS lookup (AAP 0.5.4, AAP 0.5.5):
 * - `issuers`: every `verified` issuer's key records and template, plus `tablemate-test` only when
 *   `APP_ENV=test` and `ZK_ALLOW_TEST_ISSUER=true`;
 * - `unsupportedIssuers`: the display names of issuers still awaiting samples, which the import
 *   screen shows as "This booking site isn't supported yet." (AAP 0.5.8);
 * - `registry`: the tree whose `root` the proof must name, with the leaves the client reads its
 *   issuer's `pubkeyHash` and its city's `aliasHash` from to build the two Merkle paths;
 * - `nullifierSalt`: the published salt the booking reference is hashed with, so the device derives
 *   the nullifier the API will look up;
 * - `artifacts` and `manifestUrl`: where the circuit WASM and the proving key are served from.
 *
 * The nested configuration schemas stay strict because the API assembles this response from
 * configuration it has already parsed, so no stray key can reach it.
 */
export const ZkConfig = z.object({
  issuers: z.array(
    z.object({
      issuerId: issuerIdField,
      displayName: z.string().min(1),
      keys: z.array(DkimKey),
      template: IssuerTemplate,
    }),
  ),
  unsupportedIssuers: z.array(z.string()),
  registry: RegistryFile,
  nullifierSalt: FieldElement,
  artifacts: z.object({ wasm: ArtifactLink, zkey: ArtifactLink }),
  manifestUrl: z.url(),
});
export type ZkConfig = z.infer<typeof ZkConfig>;
