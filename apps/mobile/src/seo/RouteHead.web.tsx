/**
 * The web head: the document title and the description of the route in view.
 *
 * The web half of the `RouteHead` platform pair (Metro resolves the extensionless `./RouteHead` to
 * this file on web and to `RouteHead.native.tsx` on iOS and Android, the pattern `src/auth/storage`
 * and `src/payments/card-setup` already follow). `Head` is Expo Router's own head support: on web it
 * writes the `<title>` and `<meta>` elements it is given into `document.head` when it mounts and
 * again whenever they change, and it is a null component on native. It is rendered by the root
 * layout, so the elements below follow the route that layout is showing.
 */
import type { ReactElement } from 'react';
import { usePathname } from 'expo-router';
import Head from 'expo-router/head';

import { routeMeta } from './route-meta';

/**
 * The two Open Graph attributes a `meta` element carries.
 *
 * They are spread rather than written as attributes because React 18's own `meta` attribute list
 * holds `name`, `content`, `httpEquiv`, `media` and `charSet` but not the Open Graph `property`,
 * which is the spelling a link preview reads.
 */
type OgMeta = Readonly<{ property: string; content: string }>;

/**
 * One Open Graph pair.
 *
 * @param property - The Open Graph property, e.g. `og:title`.
 * @param content - Its value.
 * @returns The attributes an element spreads.
 */
function ogMeta(property: string, content: string): OgMeta {
  return { property, content };
}

/**
 * Puts the current route's title and description in the document head.
 *
 * The title is the route's own header wording and the description is one sentence about the screen,
 * both from `route-meta.ts`; the Open Graph pair repeats them so a shared link shows a title and a
 * description rather than the app's name alone. `usePathname` is what makes this follow the route:
 * a navigation re-renders it, and `Head` writes the new values over the old ones. There is no
 * `document.title` write here and no effect to order against React's own rendering, because the
 * framework's head support is the mechanism.
 *
 * @returns The head elements of the route in view.
 */
export function RouteHead(): ReactElement {
  const pathname = usePathname();
  const { title, description } = routeMeta(pathname);
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta {...ogMeta('og:title', title)} />
      <meta {...ogMeta('og:description', description)} />
    </Head>
  );
}
