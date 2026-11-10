/**
 * The web client's per-route title and description table.
 *
 * Expo Router mounts its navigation container with `documentTitle: { enabled: false }`, so the `title` a screen passes
 * to `<Stack.Screen>` never reaches the document, and the web export is a single `index.html` whose only title is the
 * app's name — leaving a browser tab, a shared link's preview and a crawler nothing route-specific to read. The title
 * and the description therefore come from the current pathname, which is what this table maps.
 * Every title below mirrors the wording the route's own header already shows, so the tab, the page header and a link
 * preview never disagree about what a screen is called; a dynamic route takes the wording its screen falls back to
 * before the record it names has loaded. Pure by design: no React, no platform module and no I/O.
 */
import { MAGIC_LINK_PATH } from '@tablemate/shared';

/** The app's name: the title of a pathname the table does not match, and the brand it belongs to. */
export const APP_NAME = 'Tablemate';
/**
 * What the document head says about one route.
 */
export interface RouteMeta {
  /** The document title. It mirrors the wording of the route's own on-screen header. */
  readonly title: string;
  /** One sentence on what the screen holds, for a link preview and for a search result. */
  readonly description: string;
}

const EXACT_ROUTES: Readonly<Record<string, RouteMeta>> = {
  '/': {
    title: APP_NAME,
    description: 'Sends you to Discover when you are signed in and to sign-in when you are not.',
  },
  '/age-gate': {
    title: 'Before you start',
    description: 'Confirms you are 18 or older and sets out the terms on holds and forfeits.',
  },
  [MAGIC_LINK_PATH]: {
    title: 'Sign in',
    description: 'Exchanges the one-time link from your email for a session.',
  },
  '/check-email': {
    title: 'Check your email',
    description: 'Confirms the one-time sign-in link was emailed, and how long it lasts.',
  },
  '/dev/zk-bench': {
    title: 'Proving benchmark',
    description: 'The internal benchmark screen that times proof generation on this device.',
  },
  '/discover': {
    title: 'Discover',
    description: 'Travelers with a verified stay in your city, and every city you can browse.',
  },
  '/legal/attribution': {
    title: 'Data sources',
    description: "Where Tablemate's place data and exchange rates come from.",
  },
  '/legal/safety': {
    title: 'Safety',
    description: 'Why a deposit is not a safety guarantee, with the basic safety tips.',
  },
  '/legal/terms': {
    title: 'Terms',
    description: 'What a card hold is, when it is released, and what a forfeit does.',
  },
  '/lodgings': {
    title: 'Lodgings',
    description: 'Lodgings in your city, ranked by witnessed meetups among their guests.',
  },
  '/lodgings/claim': {
    title: "I'm staying here",
    description: 'Claims your stay, from the verification-call notice to its booking details.',
  },
  '/meetups': {
    title: 'Meetups',
    description: 'Your proposals and locked meetups, with each deposit status and the next step.',
  },
  '/meetups/propose': {
    title: 'Propose a meetup',
    description: 'Proposes a meetup at a partner venue, with a start time and a deposit.',
  },
  '/ops': {
    title: 'Operator dashboard',
    description: "The pilot's meetup completion rate and every figure behind it.",
  },
  '/ops/queues': {
    title: 'Operator queues',
    description: 'The operator queues: disputes, calls, price jobs and lodging claims.',
  },
  '/ops/registry': {
    title: 'Operator registry',
    description: 'Operator onboarding for venues and lodgings, with their console secrets.',
  },
  '/profile': {
    title: 'Profile',
    description: 'Your handle, proof status, counters, stay, Table Credit and settings.',
  },
  '/profile/credit': {
    title: 'Table Credit',
    description: 'Your Table Credit balance in USD, and the entries behind it.',
  },
  '/profile/edit': {
    title: 'Edit profile',
    description: 'Edits your profile fields, grouped by the tier each one is shared at.',
  },
  '/profile/payment': {
    title: 'Payment card',
    description: 'Saves the card your meetup deposits are held on.',
  },
  '/profile/stay': {
    title: 'My stay',
    description: 'Your claimed stay, and whether verified travelers can see it.',
  },
  '/proof/generate': {
    title: 'Verify my stay',
    description: 'Proves your booking on this device and sends only the proof to the server.',
  },
  '/proof/import': {
    title: 'Verify my stay',
    description: 'Imports the booking confirmation that proves your stay, on this device.',
  },
  '/report': {
    title: 'Report',
    description: 'Reports a traveler to the Tablemate team in your own words.',
  },
  '/settings': {
    title: 'Settings',
    description: 'The legal pages, signing out, and deleting your account.',
  },
  '/settings/delete-account': {
    title: 'Delete account',
    description: 'Deletes your account, and says what happens to open meetups and claims.',
  },
  '/sign-in': {
    title: 'Sign in',
    description: 'Signs you in with a one-time email link, and no password.',
  },
};
/** One row of {@link PATTERN_ROUTES}: the pathname it matches and the metadata it returns. */
type PatternRow = readonly [pattern: string, meta: RouteMeta];

const PATTERN_ROUTES: readonly PatternRow[] = [
  [
    '/meetups/:id/suggestions',
    { title: 'Plan the day', description: 'Places near the venue that fit a shared budget.' },
  ],
  [
    '/meetups/:id/check-in',
    { title: 'Check in', description: "Check in at the venue with the console's six-digit code." },
  ],
  [
    '/meetups/:id/dispute',
    {
      title: 'Report a problem',
      description: 'Reports a problem with a meetup so an operator can settle it.',
    },
  ],
  [
    '/meetups/:id/chat',
    {
      title: 'Chat',
      description: 'Messages with your meetup partner, once both deposits are locked.',
    },
  ],
  [
    '/cities/:cityId',
    { title: 'City', description: "One city's name, and the partner venues you can meet at." },
  ],
  [
    '/lodgings/:id',
    {
      title: 'Lodging',
      description: "One lodging's standing, and the guests who chose to appear.",
    },
  ],
  [
    '/users/:userId',
    { title: 'Traveler', description: "Another traveler's profile, as far as your tier reaches." },
  ],
  [
    '/meetups/:id',
    {
      title: 'Meetup',
      description: 'One meetup: the counterpart, the venue, the holds on both sides.',
    },
  ],
];
/** What an unmatched pathname gets: the app's name, and one line on what the app is. */
const FALLBACK: RouteMeta = {
  title: APP_NAME,
  description:
    'Tablemate is a social app for travelers: meet another verified traveler in your city at a ' +
    'partner venue, with a small refundable deposit holding the seat.',
};

function withoutQueryOrTrailingSlash(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? '';
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** A pathname's non-empty segments, so `/meetups/42` and `meetups/42` compare alike. */
function segmentsOf(pathname: string): readonly string[] {
  return pathname.split('/').filter((segment) => segment !== '');
}

/** Whether a pattern's every segment is the pathname's, a `:`-prefixed pattern segment standing in. */
function matchesPattern(pattern: readonly string[], pathname: readonly string[]): boolean {
  return (
    pattern.length === pathname.length &&
    pattern.every((segment, index) => segment.startsWith(':') || segment === pathname[index])
  );
}

export function routeMeta(pathname: string): RouteMeta {
  const path = withoutQueryOrTrailingSlash(pathname);
  const exact = Object.hasOwn(EXACT_ROUTES, path) ? EXACT_ROUTES[path] : undefined;
  if (exact !== undefined) return exact;
  const segments = segmentsOf(path);
  for (const [pattern, meta] of PATTERN_ROUTES) {
    if (matchesPattern(segmentsOf(pattern), segments)) return meta;
  }
  return FALLBACK;
}
