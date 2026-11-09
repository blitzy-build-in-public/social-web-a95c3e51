/**
 * Profile-photo re-encoding and storage for `PUT /me/profile` (AAP 0.5.1, 0.5.2, 0.5.4).
 *
 * What is stored is a re-encode, never the uploaded bytes: orientation applied, long edge at most
 * `PHOTO_MAX_EDGE_PX`, written as WebP, and carrying no image metadata, because EXIF is where a device
 * records the GPS position of the shot and location may be used here only for the check-in test
 * (AAP 0.1.1, 0.12.2). {@link processPhoto} reads nothing but its argument, so `me/profile.ts` runs it
 * before opening its fenced transaction; {@link storePhoto} writes inside that transaction, so the
 * profile fields and the photo commit or roll back together (AAP 0.3.2).
 */
import sharp from 'sharp';

import { PHOTO_MAX_BYTES, PHOTO_MAX_EDGE_PX } from '@tablemate/shared';

import type { DbTx } from '@tablemate/db';

import { AppError, isAppError } from '../../plugins/errors.ts';

/**
 * The image formats a profile photo may arrive in: JPEG and PNG (the phone-camera defaults), WebP, AVIF
 * and HEIF, as sharp reports them in `Metadata.format`. An allowlist, so SVG and PDF (documents, not
 * photographs), GIF (one frame), TIFF and raw are refused with `400 invalid_field`, like every other
 * rejected field of `PUT /me/profile` (AAP 0.5.4).
 */
const ACCEPTED_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp', 'avif', 'heif']);

/**
 * The pixel ceiling one decode may produce: `PROFILE_BODY_LIMIT_BYTES` bounds the uploaded bytes, not
 * the pixels they expand to, so a small PNG can still claim a gigapixel canvas.
 */
const MAX_INPUT_PIXELS = 40_000_000;

const TOO_LARGE_MESSAGE = 'That photo is too large. Choose a smaller one.';

const FORMAT_MESSAGE = 'Photo format not supported. Use a JPEG, PNG, WebP, AVIF or HEIF image.';

/**
 * The message for bytes that cannot be decoded at all: truncated, corrupt or not an image. sharp's own
 * text is never answered, because it quotes the input's content and structure (AAP 0.11.1).
 */
const UNDECODABLE_MESSAGE = 'photo could not be decoded';

/**
 * One stored profile photo, in the shape `ProfilePhoto` holds it: the WebP bytes as Prisma's `Bytes`
 * takes them, and the dimensions of *that* image, after orientation and resize (AAP 0.5.2).
 */
export interface ProcessedPhoto {
  /**
   * The WebP bytes, already stripped of every metadata block; spelled with `ArrayBuffer` because that is
   * what Prisma's `Bytes` input accepts and what sharp's `toBuffer` returns.
   */
  readonly webp: Uint8Array<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
}

/**
 * The byte length a validated base64 string decodes to, computed without allocating the bytes: the
 * string is well formed and a multiple of four long, so this is the exact decoded length.
 */
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Re-encodes an uploaded photo for storage: orientation applied, scaled to fit the stored edge, written
 * as WebP, with every metadata block dropped (AAP 0.5.2). Above `PHOTO_MAX_BYTES` the answer is
 * `photo_too_large` with `413`; a format outside {@link ACCEPTED_FORMATS}, or bytes sharp cannot
 * decode, is `400 invalid_field` (AAP 0.5.4).
 */
export async function processPhoto(base64: string): Promise<ProcessedPhoto> {
  // The first check reads the length off the string, so an over-limit payload never becomes a Buffer.
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
    // metadata; `withMetadata`, `keepMetadata`, `keepExif`, `keepXmp`, `keepIccProfile` and `withExif*`
    // are all deliberately absent, because calling one would write the GPS position through into the
    // stored photo, which AAP 0.5.2 forbids.
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
    // Anything sharp raises — a corrupt or truncated image, an unsupported input, the pixel ceiling —
    // is the caller's payload being unusable; the original rides along as the cause for the log alone.
    throw new AppError('invalid_field', UNDECODABLE_MESSAGE, { cause: error });
  }
}

/**
 * Writes or clears the caller's stored photo: `photo === null` removes the row, otherwise the row is
 * created or replaced in place, because `ProfilePhoto` is keyed by `userId`. Runs only inside the
 * transaction `me/profile.ts` opens and opens none of its own (AAP 0.5.2, 0.5.4, 0.3.2).
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
