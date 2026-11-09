/**
 * The web half of the `.eml` intake: the file picker, and no share intake (AAP 0.3.4).
 *
 * Web SDK 52's picker reads the file with `FileReader.readAsDataURL`, so the asset carries a `data:` URL beside the
 * `File`; the bytes are held in memory for the attempt and the URL is revoked, overwritten first, when the attempt ends.
 * No URI on the web names a copy this app made, so nothing here is deleted.
 */
import * as DocumentPicker from 'expo-document-picker';
import type { EmlHandle, EmlIntake, ZkClientErrorCode } from './prover.ts';
type NativeIntake = typeof import('./eml-intake.native.ts');
const ACCEPTED_TYPES = ['message/rfc822', '.eml'];
/** The one scheme naming a URL this page created and must therefore revoke. */
const BLOB_SCHEME = 'blob:';

function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

async function readBytes(asset: DocumentPicker.DocumentPickerAsset): Promise<Uint8Array> {
  if (asset.file !== undefined) return new Uint8Array(await asset.file.arrayBuffer());
  return new Uint8Array(await (await fetch(asset.uri)).arrayBuffer());
}

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

export function fromShareIntent(_uri: string): Promise<EmlHandle> {
  return Promise.reject(fail('share_intake_unsupported'));
}

/** No URI on the web names a copy this app made, so none of them may be deleted or written. */
export const isAppOwnedUri: NativeIntake['isAppOwnedUri'] = () => false;
/** No directory on the web holds an `.eml` copy, so there is no root to report. */
export const appOwnedRoots: NativeIntake['appOwnedRoots'] = () => [];
/** The intake this platform offers: the file picker, and no share intake (AAP 0.3.4). */
export const emlIntake = { pickEml, fromShareIntent } satisfies EmlIntake;
