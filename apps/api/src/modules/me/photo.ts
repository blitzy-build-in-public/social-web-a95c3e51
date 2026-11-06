/**
 * Profile-photo re-encoding and storage for `PUT /me/profile` (AAP 0.5.1, 0.5.2, 0.5.4).
 *
 * A photo is the tier-2 field of the disclosure ladder, shown to a traveler who has completed one
 * meetup with the caller and never below that (AAP 0.5.2, 0.5.4). What is stored is a re-encode,
 * never the uploaded bytes — orientation applied, long edge at most `PHOTO_MAX_EDGE_PX` (1,024),
 * written as WebP, and carrying no image metadata: EXIF is where a device records the GPS position
 * of the shot, and location may be used here only for the check-in test (AAP 0.1.1, 0.12.2).
 *
 * The two functions are deliberately separate. {@link processPhoto} reads nothing but its argument,
 * so `me/profile.ts` runs it *before* opening its fenced transaction and no transaction is held
 * across an image encode (AAP 0.3.2). {@link storePhoto} writes the result inside that caller-owned
 * transaction, so the profile fields and the photo commit or roll back together.
 *
 * Nothing here logs: not the bytes, not the dimensions, not the base64 string. The only failure
 * detail that leaves the process is the error envelope's code and its fixed sentence (AAP 0.11.1).
 */

import sharp from 'sharp';

import { PHOTO_MAX_BYTES, PHOTO_MAX_EDGE_PX } from '@tablemate/shared';

import type { DbTx } from '@tablemate/db';

import { AppError, isAppError } from '../../plugins/errors.ts';

/**
 * The image formats a profile photo may arrive in: JPEG and PNG (the phone-camera defaults), WebP,
 * AVIF and HEIF (what iOS and Android hand over for a modern capture) — as sharp reports them in
 * `Metadata.format`.
 *
 * An allowlist, so anything else sharp can read is refused: SVG and PDF (documents, not
 * photographs), GIF (an animation would flatten to one frame), TIFF and raw. A refusal is
 * `400 invalid_field`, like every other rejected field of `PUT /me/profile` (AAP 0.5.4).
 */
const ACCEPTED_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp', 'avif', 'heif']);

/**
 * The pixel ceiling one decode may produce: `PROFILE_BODY_LIMIT_BYTES` bounds the uploaded bytes,
 * not the pixels they expand to, so a small PNG can still claim a gigapixel canvas. 40 MP is far
 * above any phone camera on the supported platforms (AAP 0.3.4) and far below a decode bomb.
 */
const MAX_INPUT_PIXELS = 40_000_000;

/** The message for a photo past {@link PHOTO_MAX_BYTES}; the envelope carries the code with it. */
const TOO_LARGE_MESSAGE = 'That photo is too large. Choose a smaller one.';

/** The message for a payload whose format is outside {@link ACCEPTED_FORMATS}. */
const FORMAT_MESSAGE = 'Photo format not supported. Use a JPEG, PNG, WebP, AVIF or HEIF image.';

/**
 * The message for bytes that cannot be decoded at all: truncated, corrupt, or not an image.
 * sharp's own text is never answered — it quotes the input's content and structure (AAP 0.11.1).
 */
const UNDECODABLE_MESSAGE = 'photo could not be decoded';

/**
 * One stored profile photo, in the shape `ProfilePhoto` holds it (AAP 0.5.2): the WebP bytes as
 * Prisma's `Bytes` takes them (the column is `BYTEA`) and the dimensions of *that* image, which the
 * upload's EXIF orientation and the resize to `PHOTO_MAX_EDGE_PX` may both have changed.
 */
export interface ProcessedPhoto {
  /**
   * The WebP bytes, already stripped of every metadata block.
   *
   * Spelled with `ArrayBuffer` rather than the default `ArrayBufferLike`, because that is what
   * Prisma's `Bytes` input accepts (a `SharedArrayBuffer`-backed view is not one) and what sharp's
   * `toBuffer` returns.
   */
  readonly webp: Uint8Array<ArrayBuffer>;
  /** Width of `webp`, in pixels, after orientation and resize. */
  readonly width: number;
  /** Height of `webp`, in pixels, after orientation and resize. */
  readonly height: number;
}

/**
 * The byte length a validated base64 string decodes to, computed without allocating the bytes.
 *
 * `ProfileUpdate.photoBase64` is `z.base64()`, so the string is well formed and its length is a
 * multiple of four: this is the exact decoded length, which is what lets {@link processPhoto}
 * refuse an over-limit payload before `Buffer.from` allocates it.
 */
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Re-encodes an uploaded photo for storage: orientation applied, scaled to fit the stored edge,
 * written as WebP, with every metadata block dropped (AAP 0.5.2).
 *
 * Called by `me/profile.ts` before its transaction opens. Above `PHOTO_MAX_BYTES` (5 MiB, as
 * `packages/shared/src/constants.ts` defines it) the answer is `413 photo_too_large` (AAP 0.5.4);
 * a format outside {@link ACCEPTED_FORMATS}, or bytes sharp cannot decode, is `400 invalid_field`.
 *
 * @param base64 - The caller's photo as base64, already validated by `ProfileUpdate`.
 * @returns The WebP bytes and the dimensions of *that* image.
 * @throws AppError `photo_too_large` or `invalid_field`.
 */
export async function processPhoto(base64: string): Promise<ProcessedPhoto> {
  // Two checks: the first reads the length off the string, so an over-limit payload never becomes a
  // Buffer at all, and the second confirms the bytes that were actually allocated.
  if (decodedByteLength(base64) > PHOTO_MAX_BYTES) {
    throw new AppError('photo_too_large', TOO_LARGE_MESSAGE);
  }

  const input = Buffer.from(base64, 'base64');

  if (input.byteLength > PHOTO_MAX_BYTES) {
    throw new AppError('photo_too_large', TOO_LARGE_MESSAGE);
  }

  try {
    const image = sharp(input, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
    });
    const { format } = await image.metadata();

    if (!ACCEPTED_FORMATS.has(format)) {
      throw new AppError('invalid_field', FORMAT_MESSAGE);
    }

    // `.rotate()` applies the EXIF orientation to the pixels and drops the tag with the rest of the
    // metadata. Nothing below re-attaches any: `withMetadata`, `keepMetadata`, `keepExif`,
    // `keepXmp`, `keepIccProfile` and `withExif*` are all deliberately absent, because calling one
    // would write the GPS position and the capture timestamp through into the stored photo, which
    // AAP 0.5.2 forbids. Resizing "inside" a `PHOTO_MAX_EDGE_PX` square never upscales a smaller
    // photo, and the returned info describes the buffer that was produced.
    const { data, info } = await image
      .rotate()
      .resize({
        width: PHOTO_MAX_EDGE_PX,
        height: PHOTO_MAX_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });

    return { webp: data, width: info.width, height: info.height };
  } catch (error) {
    // An AppError is this function's own verdict and keeps its code, message and status.
    if (isAppError(error)) {
      throw error;
    }

    // Anything sharp raises — a corrupt or truncated image, an unsupported input, the pixel ceiling
    // — is the caller's payload being unusable. The original rides along as the cause for the log
    // alone; the envelope carries neither it nor its text.
    throw new AppError('invalid_field', UNDECODABLE_MESSAGE, { cause: error });
  }
}

/**
 * Writes or clears the caller's stored photo (AAP 0.5.2, 0.5.4).
 *
 * `photo === null` is the `photoBase64: null` of `ProfileUpdate` and removes the row, so the caller
 * has no tier-2 photo and `GET /users/:userId/photo` answers `404 user_not_found` for every viewer
 * (AAP 0.5.4). Otherwise the row is created or replaced in place: `ProfilePhoto` is keyed by
 * `userId`, so one traveler has exactly one photo. Runs only inside the transaction `me/profile.ts`
 * opens, and opens none of its own, so the photo and the profile fields commit together or not at
 * all (AAP 0.3.2).
 */
export async function storePhoto(
  tx: DbTx,
  userId: string,
  photo: ProcessedPhoto | null,
): Promise<void> {
  if (photo === null) {
    await tx.profilePhoto.deleteMany({ where: { userId } });
    return;
  }

  const fields = { webp: photo.webp, width: photo.width, height: photo.height };

  await tx.profilePhoto.upsert({
    where: { userId },
    create: { userId, ...fields },
    update: fields,
  });
}
