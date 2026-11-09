/** Expo Router's native-intent hook: where a URL the operating system delivers is answered before the router navigates on it. */
import { getShareExtensionKey } from 'expo-share-intent';

import { STRIPE_RETURN_URL } from '../src/payments/card-setup';

const SHARE_IMPORT_ROUTE = '/proof/import';
const FILE_URL_SCHEMES = ['file://', 'content://'] as const;

function pathOf(url: string): string {
  const schemeSeparator = url.indexOf('://');
  const afterScheme = schemeSeparator === -1 ? url : url.slice(schemeSeparator + '://'.length);
  const queryOrFragment = afterScheme.search(/[?#]/);
  const path = queryOrFragment === -1 ? afterScheme : afterScheme.slice(0, queryOrFragment);
  return path.startsWith('/') ? path : `/${path}`;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

const STRIPE_RETURN_PATH = withoutTrailingSlash(pathOf(STRIPE_RETURN_URL));

export function redirectSystemPath({ path }: { path: string }): string | null {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return SHARE_IMPORT_ROUTE;
    const localFile = FILE_URL_SCHEMES.some((scheme) => path.toLowerCase().startsWith(scheme));
    if (localFile) return `${SHARE_IMPORT_ROUTE}?uri=${encodeURIComponent(path)}`;
    return withoutTrailingSlash(pathOf(path)) === STRIPE_RETURN_PATH ? null : path;
  } catch {
    // Throwing here would strand the traveller on the not-found screen as an unhandled rejection.
    return '/';
  }
}
