/**
 * `.eml` intake on the web: the booking confirmation the traveller picks, as in-memory bytes (AAP 0.3.4, AAP 0.5.5).
 * The web half of the `./eml-intake` platform pair, which Metro resolves an extensionless import to in a browser and
 * to `eml-intake.native.ts` under Hermes; the `satisfies` checks below hold this half to the same names and the same
 * {@link EmlIntake} contract.
 *
 * Nothing on this platform writes an `.eml` anywhere: the picker reads the chosen file inside the page, the handle's
 * bytes are the only copy this flow holds, and `release()` zero-fills them and revokes the URI when it is a `blob:`
 * URL this page created, so no byte of the email outlives the attempt. Nothing here is logged, stored or put into an
 * error. SDK 52's web picker reads the file with `FileReader.readAsDataURL`, so the asset carries a `data:` URL beside
 * the `File`; the `File` is the primary read path and the in-memory `data:` URL is discarded with the handle.
 */
import * as DocumentPicker from 'expo-document-picker';

import type { EmlHandle, EmlIntake, ZkClientErrorCode } from './prover.ts';

/** The native half's exports, named once so each export here is checked against its counterpart. */
type NativeIntake = typeof import('./eml-intake.native.ts');

/*
 * Browsers often report no MIME type for an `.eml`, so the extension is offered beside the type, and on the web the
 * two become the file input's `accept` list. `copyToCacheDirectory` is deliberately not passed: it is a native
 * option, and the web picker copies nothing to a filesystem (AAP 0.5.5).
 */
const ACCEPTED_TYPES = ['message/rfc822', '.eml'];

/** The one scheme naming a URL this page created and must therefore revoke. */
const BLOB_SCHEME = 'blob:';

/** The client's own error, shaped as `prover.ts` reads it: the code is the entire message. */
function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

/** Reads the picked file into memory, preferring the `File` the web picker returns. */
async function readBytes(asset: DocumentPicker.DocumentPickerAsset): Promise<Uint8Array> {
  if (asset.file !== undefined) return new Uint8Array(await asset.file.arrayBuffer());
  return new Uint8Array(await (await fetch(asset.uri)).arrayBuffer());
}

/**
 * The bytes it hands back are the email; `release()` erases them and must be called on every path of the attempt —
 * success, failure and cancellation alike (AAP 0.5.5). A cancelled pick, or a success carrying no asset, is `null`
 * rather than a failure (AAP 0.3.4).
 */
export async function pickEml(): Promise<EmlHandle | null> {
  let result: DocumentPicker.DocumentPickerResult;
  try {
    result = await DocumentPicker.getDocumentAsync({ type: ACCEPTED_TYPES, multiple: false });
  } catch {
    throw fail('eml_read_failed');
  }
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset === undefined) return null;
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(asset);
  } catch {
    throw fail('eml_read_failed');
  }
  let held: DocumentPicker.DocumentPickerAsset | null = asset;
  let released = false;
  return {
    bytes,
    release(): Promise<void> {
      if (released) return Promise.resolve();
      released = true;
      // Overwritten before the asset is dropped, so the bytes are gone even if revoking throws.
      bytes.fill(0);
      const dropped = held;
      held = null;
      if (dropped !== null && dropped.uri.startsWith(BLOB_SCHEME)) URL.revokeObjectURL(dropped.uri);
      return Promise.resolve();
    },
  };
}

/**
 * A browser has no share target for files, so the import screen reaches this flow through {@link pickEml} instead;
 * the parameter is kept so both halves of the pair are driven the same way (AAP 0.3.4).
 */
export function fromShareIntent(_uri: string): Promise<EmlHandle> {
  return Promise.reject(fail('share_intake_unsupported'));
}

/** No URI on the web names a copy this app made, so none of them may be deleted or written. */
export const isAppOwnedUri: NativeIntake['isAppOwnedUri'] = () => false;

/** No directory on the web holds an `.eml` copy, so there is no root to report. */
export const appOwnedRoots: NativeIntake['appOwnedRoots'] = () => [];

/** The intake this platform offers: the file picker, and no share intake (AAP 0.3.4). */
export const emlIntake = { pickEml, fromShareIntent } satisfies EmlIntake;
