/**
 * The native half of the `.eml` intake: the document picker and the share sheet, the app-owned copy both paths leave on
 * disk, and the deletion that removes it (AAP 0.3.4, AAP 0.5.5).
 *
 * The app owns what it writes: a picked file is copied into the app's own cache and a shared one moved there, so the
 * traveller's original is never touched, and the copy is deleted — overwritten first — on every path that ends an attempt.
 * Nothing here logs a path, a name or a byte of a booking confirmation.
 */
import { base64ToBytes } from '@tablemate/circuits';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import type { EmlHandle, EmlIntake, ZkClientErrorCode } from './prover.ts';
/** The only scheme whose files the app can own; anything else is the traveller's or a provider's. */
const FILE_SCHEME = 'file://';
const DOCUMENTS_SEGMENT = 'Documents/';
const TEMP_SEGMENT = 'tmp/';
const INBOX_SEGMENT = 'Inbox/';
const APP_GROUP_SEGMENT = '/Shared/AppGroup/';
const PARENT_SEGMENT = '..';
const BASE64 = 'base64';
/**
 * `name` is what `errorCodeOf` reads, and `message` is the code alone, so no path or file name can travel out of an
 * attempt.
 */
function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

/** One directory as a prefix: absolute, and always ending in `/` so no sibling name matches it. */
function asRoot(directory: string | null | undefined): string | null {
  if (typeof directory !== 'string' || directory === '') return null;
  return directory.endsWith('/') ? directory : `${directory}/`;
}

export function appOwnedRoots(): string[] {
  const roots: string[] = [];
  const cache = asRoot(FileSystem.cacheDirectory);
  if (cache !== null) roots.push(cache);
  const documents = asRoot(FileSystem.documentDirectory);
  if (documents !== null) {
    roots.push(`${documents}${INBOX_SEGMENT}`);
    if (documents.endsWith(DOCUMENTS_SEGMENT)) {
      roots.push(`${documents.slice(0, -DOCUMENTS_SEGMENT.length)}${TEMP_SEGMENT}`);
    }
  }
  return roots;
}

export function isAppOwnedUri(uri: string): boolean {
  if (!uri.startsWith(FILE_SCHEME)) return false;
  let path: string;
  try {
    path = decodeURI(uri);
  } catch {
    // A malformed escape sequence names no path this app can classify, so it is not ours.
    return false;
  }
  if (path.split('/').includes(PARENT_SEGMENT)) return false;
  if (path.includes(APP_GROUP_SEGMENT)) return true;
  return appOwnedRoots().some((root) => path.startsWith(root));
}

/** Deletes an app-owned copy, swallowing a failure: cleanup is best-effort and never the outcome. */
async function deleteQuietly(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Intentionally ignored: a storage error must not replace the failure the caller is handling.
  }
}

async function readHandle(uri: string): Promise<EmlHandle> {
  const owned = isAppOwnedUri(uri);
  let encoded: string;
  try {
    encoded = await FileSystem.readAsStringAsync(uri, { encoding: BASE64 });
  } catch {
    if (owned) await deleteQuietly(uri);
    throw fail('eml_read_failed');
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(encoded);
  } catch {
    if (owned) await deleteQuietly(uri);
    throw fail('eml_read_failed');
  }
  let released = false;
  return {
    bytes,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Overwrite before deleting, so the bytes are gone even if the deletion itself fails.
      bytes.fill(0);
      if (owned) await deleteQuietly(uri);
    },
  };
}

export async function pickEml(): Promise<EmlHandle | null> {
  let result: DocumentPicker.DocumentPickerResult;
  try {
    result = await DocumentPicker.getDocumentAsync({
      type: ['message/rfc822', '*/*'],
      copyToCacheDirectory: false,
      multiple: false,
    });
  } catch {
    throw fail('eml_read_failed');
  }
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset === undefined) return null;
  return readHandle(asset.uri);
}

/**
 * The two platforms hand over different forms — an iOS `file://` URI, an Android bare file path beside its
 * `content://` sibling — so a bare absolute path is given the scheme it is missing and every other form is passed
 * through untouched: a `content://` URI is readable where it stands and is not an app-owned copy (AAP 0.3.4).
 *
 * Throws `share_intake_unsupported` when no file was handed over, and `eml_read_failed` when it cannot be read.
 */
export async function fromShareIntent(uri: string): Promise<EmlHandle> {
  const trimmed = uri.trim();
  if (trimmed === '') throw fail('share_intake_unsupported');
  return readHandle(trimmed.startsWith('/') ? `${FILE_SCHEME}${trimmed}` : trimmed);
}

export const emlIntake = { pickEml, fromShareIntent } satisfies EmlIntake;
