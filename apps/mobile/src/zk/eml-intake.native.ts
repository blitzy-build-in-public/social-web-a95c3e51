/**
 * `.eml` intake on iOS and Android: the picked or shared booking confirmation as in-memory bytes, and the app's own
 * copy of it deleted again (AAP 0.5.5, AAP 0.3.4).
 *
 * The URI and the file name are as confidential as the bytes — a confirmation email is commonly named after its
 * booking reference, and a share-sheet path carries the sender's details — so nothing here is logged, stored or put
 * into an error. An app-owned copy lives for exactly one attempt: `release` deletes it on success, on failure and on
 * cancellation alike, and a failed read deletes it before throwing; a URI this app does not own is never deleted or
 * written, because it is the traveller's original. Platform modules are the only imports.
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

/**
 * Base64 is what reaches a `file://` URI and an Android `content://` one alike, and the literal is the value
 * `FileSystem.EncodingType.Base64` carries, so the read never depends on the module object exposing the enum.
 */
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

/**
 * Read from `expo-file-system` on each call rather than at module load, so the value a running app reports is the one
 * used and a test's mock applies (AAP 0.5.5).
 *
 * Android has no separate temporary directory, so its cache directory covers that case; the temporary and inbox roots
 * appear only where `documentDirectory` has the `Documents/` form they are derived from. The three roots come from how
 * a file reaches the app: the picker and the share extension stage copies under the cache directory on Android and
 * under the shared App Group container on iOS, an "Open in" file is copied into `Inbox/`, and a pick made "as a copy"
 * lands in the container's `tmp/`.
 */
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

/**
 * Only a `file://` URI can be app-owned: a `content://` or `ph://` URI names the traveller's own document or an
 * asset-library entry, which is never deleted or written, and a decoded path that leaves its directory is refused
 * (AAP 0.5.5).
 */
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

/**
 * The read is the one step that can leave a copy behind, so a failure deletes an app-owned copy before reporting
 * `eml_read_failed`: a file the app made but could not read must not stay on disk. The bytes are base64 in transit
 * only and are decoded here, so no platform codec is needed under Hermes.
 */
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

/**
 * `copyToCacheDirectory` is false on purpose: copying is the one thing that would create an app-owned `.eml` for this
 * flow to delete, and the picked file is read where it lies instead. The wildcard type is accepted beside
 * `message/rfc822`, because some document providers label an `.eml` as `application/octet-stream`. A cancelled pick,
 * or a success carrying no asset, is `null` rather than a failure (AAP 0.3.4).
 */
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

/**
 * The document picker plus share-sheet and "Open in" intake, which the web build has no equivalent of (AAP 0.3.4).
 */
export const emlIntake = { pickEml, fromShareIntent } satisfies EmlIntake;
