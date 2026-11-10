/** The itinerary-proof contract (AAP 0.8.1): what the device submits, what the API answers, and the zero-knowledge configuration both sides agree on. `ProofSubmission` and every configuration schema below is a `z.strictObject` at every nesting level, because an unknown key must be a rejection, while the response DTOs drop unknown keys. The circuit's numeric contracts — the public-signal order, the date-format and charset codes, the registry depth and the issuer-id range — are written once here and imported, never repeated. */

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
/** The seven public signals of `tablemate_itinerary.circom`, in the order snarkjs delivers them: the outputs `cityId`, `arrivalDate`, `departureDate`, `issuerId` and `nullifier` first, then the public inputs `registryRoot` and `nullifierSalt`. Position is part of the contract, and any other count is the API's `400 proof_malformed`. */
export const PUBLIC_SIGNAL_NAMES = [
  'cityId',
  'arrivalDate',
  'departureDate',
  'issuerId',
  'nullifier',
  'registryRoot',
  'nullifierSalt',
] as const;
/** One public signal's name, in circuit order. */
export type PublicSignalName = (typeof PUBLIC_SIGNAL_NAMES)[number];
/** A G1 point of BN254 as snarkjs writes it, each coordinate a decimal field element. */
export const G1Point = z.tuple([FieldElement, FieldElement, FieldElement]);
export type G1Point = z.infer<typeof G1Point>;
/** A G2 point of BN254 as snarkjs writes it — `[[x0, x1], [y0, y1], [1, 0]]`; the inner pairs are the Fp2 coefficients in the order snarkjs's verifier reads them. */
export const G2Point = z.tuple([
  z.tuple([FieldElement, FieldElement]),
  z.tuple([FieldElement, FieldElement]),
  z.tuple([FieldElement, FieldElement]),
]);
export type G2Point = z.infer<typeof G2Point>;
/** A Groth16 proof over BN254 in the JSON shape `snarkjs.groth16.verify` consumes; strict, so a proof carrying any other key is rejected before it is verified. */
export const Groth16Proof = z.strictObject({
  pi_a: G1Point,
  pi_b: G2Point,
  pi_c: G1Point,
  protocol: z.literal('groth16'),
  curve: z.literal('bn128'),
});
export type Groth16Proof = z.infer<typeof Groth16Proof>;
/** The body of `POST /itinerary-proofs` — the only thing the server ever receives about the email. Strict at both levels, with the signal count fixed at seven; guest name, booking reference, email text, address and price are private inputs and appear in neither part. */
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
/** The date layouts `lib/date_parse.circom` can parse, selected per issuer template: `ISO_YMD`, `D_MONTH_YYYY`, `MONTH_D_YYYY` and `DOW_D_MON_YYYY`. */
export const DateFormat = z.enum(['ISO_YMD', 'D_MONTH_YYYY', 'MONTH_D_YYYY', 'DOW_D_MON_YYYY']);
export type DateFormat = z.infer<typeof DateFormat>;
/** The code each date layout contributes to the template hash, matching `lib/date_parse.circom` and `template-hash.ts`: a template differing in this code hashes to a value with no registry leaf. */
export const DATE_FORMAT_CODE = {
  ISO_YMD: 1,
  D_MONTH_YYYY: 2,
  MONTH_D_YYYY: 3,
  DOW_D_MON_YYYY: 4,
} as const satisfies Record<DateFormat, number>;
/** The byte set an extracted value may use: `digits` is `0`-`9`; `alnum` adds `A`-`Z`, `a`-`z` and `-`; `date` adds the space and comma the English layouts need; `text` adds `0x20`-`0x7E` and at or above `0x80`, so an accented place name still extracts. */
export const CharsetName = z.enum(['digits', 'alnum', 'date', 'text']);
export type CharsetName = z.infer<typeof CharsetName>;
/** The code each charset contributes to the template hash. */
export const CHARSET_CODE = {
  digits: 1,
  alnum: 2,
  date: 3,
  text: 4,
} as const satisfies Record<CharsetName, number>;
/** One extractable field of an issuer's confirmation email: `anchor` is the literal text preceding the value in the decoded body, `terminator` the byte that ends it and `charset` the bytes the value may contain. The anchor is 1-32 UTF-8 bytes and must occur exactly once in the body window. */
export const TemplateField = z.strictObject({
  anchor: z.string().refine((s) => {
    const bytes = utf8ByteLength(s);
    return bytes >= 1 && bytes <= 32;
  }, 'anchor must be 1–32 UTF-8 bytes'),
  terminator: z.number().int().min(0).max(255),
  charset: CharsetName,
});
export type TemplateField = z.infer<typeof TemplateField>;
/** The registered extraction template of one issuer: where each of the four fields sits and how its dates are written; no field is read from the headers, because the statement places the stay in the body. */
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
/** One DKIM key record of an issuer; the records are filled from the `d=` and `s=` tags of a real signed email, and the registry builder derives each `pubkeyHash` from the modulus. */
export const DkimKey = z.strictObject({
  domain: z.string().min(1),
  selector: z.string().min(1),
  modulusBase64: z.base64(),
});
export type DkimKey = z.infer<typeof DkimKey>;
/** The scalar fields the issuer configuration, the registry and the published ZK configuration share. */
const issuerIdField = z.number().int().min(1).max(4294967295);
const circuitCityIdField = z.number().int().min(1);
const leafIndexField = z.number().int().min(0).max(255);
/** How far an issuer's record has been taken: `awaiting_samples` — no real confirmation email supplied, so no key and no leaf; `unverified` — records authored from samples but the check has not passed; `verified` — the only state that receives a production leaf. */
export const IssuerVerificationStatus = z.enum(['awaiting_samples', 'unverified', 'verified']);
export type IssuerVerificationStatus = z.infer<typeof IssuerVerificationStatus>;
/** One record of `config/issuers/<issuer>.json` before its status rules are applied. */
export const IssuerConfigBase = z.strictObject({
  issuerId: issuerIdField,
  displayName: z.string().min(1),
  verificationStatus: IssuerVerificationStatus,
  keys: z.array(DkimKey),
  template: IssuerTemplate.nullable(),
});
export type IssuerConfigBase = z.infer<typeof IssuerConfigBase>;
/** One issuer record with the status rules that keep an invented key or anchor out of the system: an issuer awaiting samples records no key and no template, and one whose samples exist records at least one of each. */
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
/** One issuer key leaf of the registry: the issuer, the key the signature verified under and the template the extraction used, as `Poseidon(1, issuerId, pubkeyHash, templateHash)` records them. The leaf type is a domain tag, so an issuer leaf cannot stand in for a city leaf. */
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
/** One city alias leaf: `Poseidon(2, cityId, cityAliasHash)`, over the alias exactly as it appears in the decoded body, quoted-printable escapes included. */
export const RegistryCityEntry = z.strictObject({
  cityId: circuitCityIdField,
  slug: CitySlug,
  alias: z.string(),
  aliasHash: FieldElement,
  leafIndex: leafIndexField,
});
export type RegistryCityEntry = z.infer<typeof RegistryCityEntry>;
/** A generated registry file, `config/registry/{production,test}.json`: the leaves and root of the commitment tree the circuit proves membership against, produced by `pnpm circuits:registry` and never hand-edited. */
export const RegistryFile = z.strictObject({
  name: z.enum(['production', 'test']),
  depth: z.literal(8),
  root: FieldElement,
  leaves: z.array(FieldElement).max(256),
  issuers: z.array(RegistryIssuerEntry),
  cities: z.array(RegistryCityEntry),
});
export type RegistryFile = z.infer<typeof RegistryFile>;

/**
 * One file of the artefact manifest ({@link ARTIFACTS_MANIFEST_FILE}): its name, size in bytes and
 * SHA-256, which the client compares after downloading a proving artefact and whenever size or
 * modification time changed.
 */
export const ArtifactRef = z.strictObject({
  name: z.string().min(1),
  size: z.number().int().positive(),
  sha256: Sha256Hex,
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/**
 * The file name `packages/circuits/scripts/setup.sh` writes the artefact manifest under in the
 * circuit build directory, and the name the `artifacts` service serves it by: the one spelling the
 * API that reads the manifest and the client that fetches it share (AAP 0.5.5, AAP 0.11.1).
 */
export const ARTIFACTS_MANIFEST_FILE = 'artifacts.manifest.json';

/**
 * The artefact manifest, the file {@link ARTIFACTS_MANIFEST_FILE} names: written by
 * `packages/circuits/scripts/setup.sh` and served by the `artifacts` service; the `api` container
 * mounts only this manifest and `verification_key.json`, never a proving key (AAP 0.5.5).
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
/** A downloadable proving artefact as the published configuration advertises it: where to fetch it and what to expect, so the client hashes what it downloaded without a second round trip; the verification key never leaves the server. */
export const ArtifactLink = z.object({
  url: z.url(),
  size: z.number().int().positive(),
  sha256: Sha256Hex,
});
export type ArtifactLink = z.infer<typeof ArtifactLink>;

/**
 * The public `GET /v1/zk/config` response — everything the device needs to build circuit inputs and
 * prove without a DNS lookup (AAP 0.5.4, AAP 0.5.5): `issuers` holds every `verified` issuer's key
 * records and template; `unsupportedIssuers` the display names still awaiting samples; `registry`
 * the tree whose `root` the proof must name, with the leaves the client reads its `pubkeyHash` and
 * `aliasHash` from; `nullifierSalt` the published salt the booking reference is hashed with; and
 * `artifacts` the circuit WASM and proving key are served from, each with the size and SHA-256 the
 * client verifies its download against.
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
});
export type ZkConfig = z.infer<typeof ZkConfig>;
