/**
 * The web client's route metadata: the title and the description every route answers with.
 *
 * Two things are checked here. The table's own wording is pinned row by row, so a title that stops
 * mirroring the header its screen shows, or a description edited into something the screen does not
 * hold, fails by name -- the spellings a link arrives in included, a query and a trailing slash. And
 * every route file under `app/` is walked from this file's own location and matched to a sample URL,
 * so a screen added without an entry in the table fails the suite rather than shipping with the
 * app's fallback title.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_NAME, routeMeta } from '../src/seo/route-meta.ts';

/** A pinned row: the pathname a link spells, and the title and description that route answers with. */
type MetaCase = readonly [pathname: string, title: string, description: string];

/** The pinned rows: every tab, each kind of dynamic route, the operator and legal areas, and the
 * spellings of the same route a query or a trailing slash produces. */
const CASES: readonly MetaCase[] = [
  [
    '/discover',
    'Discover',
    'Travelers with a verified stay in your city, and every city you can browse.',
  ],
  [
    '/meetups',
    'Meetups',
    'Your proposals and locked meetups, with each deposit status and the next step.',
  ],
  [
    '/lodgings',
    'Lodgings',
    'Lodgings in your city, ranked by witnessed meetups among their guests.',
  ],
  ['/profile', 'Profile', 'Your handle, proof status, counters, stay, Table Credit and settings.'],
  ['/', APP_NAME, 'Sends you to Discover when you are signed in and to sign-in when you are not.'],
  ['/sign-in', 'Sign in', 'Signs you in with a one-time email link, and no password.'],
  ['/auth/verify', 'Sign in', 'Exchanges the one-time link from your email for a session.'],
  [
    '/proof/import',
    'Verify my stay',
    'Imports the booking confirmation that proves your stay, on this device.',
  ],
  [
    '/proof/generate',
    'Verify my stay',
    'Proves your booking on this device and sends only the proof to the server.',
  ],
  [
    '/meetups/propose',
    'Propose a meetup',
    'Proposes a meetup at a partner venue, with a start time and a deposit.',
  ],
  [
    '/meetups/sample-id',
    'Meetup',
    'One meetup: the counterpart, the venue, the holds on both sides.',
  ],
  [
    '/meetups/sample-id/chat',
    'Chat',
    'Messages with your meetup partner, once both deposits are locked.',
  ],
  [
    '/meetups/sample-id/check-in',
    'Check in',
    "Check in at the venue with the console's six-digit code.",
  ],
  [
    '/meetups/sample-id/suggestions',
    'Plan the day',
    'Places near the venue that fit a shared budget.',
  ],
  ['/users/sample-id', 'Traveler', "Another traveler's profile, as far as your tier reaches."],
  ['/cities/lisbon', 'City', "One city's name, and the partner venues you can meet at."],
  ['/lodgings/sample-id', 'Lodging', "One lodging's standing, and the guests who chose to appear."],
  [
    '/lodgings/claim',
    "I'm staying here",
    'Claims your stay, from the verification-call notice to its booking details.',
  ],
  ['/ops', 'Operator dashboard', "The pilot's meetup completion rate and every figure behind it."],
  [
    '/ops/queues',
    'Operator queues',
    'The operator queues: disputes, calls, price jobs and lodging claims.',
  ],
  ['/legal/terms', 'Terms', 'What a card hold is, when it is released, and what a forfeit does.'],
  [
    '/legal/safety',
    'Safety',
    'Why a deposit is not a safety guarantee, with the basic safety tips.',
  ],
  [
    '/settings/delete-account',
    'Delete account',
    'Deletes your account, and says what happens to open meetups and claims.',
  ],
  [
    '/discover/',
    'Discover',
    'Travelers with a verified stay in your city, and every city you can browse.',
  ],
  [
    '/meetups/sample-id/chat?unread=1',
    'Chat',
    'Messages with your meetup partner, once both deposits are locked.',
  ],
];

/** What a pathname the app does not serve answers with: the app's name and what the app is. */
const FALLBACK = {
  title: APP_NAME,
  description:
    'Tablemate is a social app for travelers: meet another verified traveler in your city at a ' +
    'partner venue, with a small refundable deposit holding the seat.',
} as const;

/** A pathname that matches no route: the probe the walk compares every screen's own answer against. */
const UNMATCHED = '/not-a-route-in-this-app';

/** The app directory: every screen Expo Router serves, resolved from this file's own location. */
const APP_DIR = fileURLToPath(new URL('../app', import.meta.url));

/** Expo Router's group parentheses around a segment that is not part of the path: `(tabs)/x.tsx`. */
const GROUP = /^\(.+\)$/;

/** Expo Router's brackets around a parameter: `[id]`, `[cityId]`, `[...rest]`. */
const PARAMETER = /^\[.*\]$/;

/** The value a parameter takes in a sample URL. */
const SAMPLE_PARAM = 'sample-id';

/** The files that hold a route: Expo Router's `_layout.tsx` and its `+`-prefixed platform files
 * (`+native-intent.tsx`) are not screens, and a route is a `.tsx` file under `app/`. */
function routeFiles(): readonly string[] {
  return readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((entry) => entry.endsWith('.tsx'))
    .filter((entry) => path.basename(entry) !== '_layout.tsx')
    .filter((entry) => !path.basename(entry).startsWith('+'))
    .sort();
}

/** The URL a route file answers on: groups dropped, a trailing `index` dropped, parameters sampled. */
function sampleUrl(relativeFile: string): string {
  const directories = relativeFile
    .split('/')
    .slice(0, -1)
    .filter((segment) => !GROUP.test(segment));
  const name = path.basename(relativeFile, '.tsx');
  const route = name === 'index' ? directories : [...directories, name];
  return `/${route.map((segment) => (PARAMETER.test(segment) ? SAMPLE_PARAM : segment)).join('/')}`;
}

describe('routeMeta', () => {
  it.each(CASES)(
    'answers %s with the title and description of that route',
    (pathname, title, description) => {
      expect(routeMeta(pathname)).toEqual({ title, description });
    },
  );

  it.each([
    '/nope',
    '/meetups/sample-id/no-such-screen',
    '/ops/registry/extra',
    'nonsense',
    '/constructor',
  ])('falls back for the unknown pathname %s', (pathname) => {
    expect(routeMeta(pathname)).toEqual(FALLBACK);
  });

  it('reads a pathname that matches no route as the fallback the walk compares against', () => {
    expect(routeMeta(UNMATCHED)).toEqual(FALLBACK);
  });
});

describe('every screen under app/', () => {
  const FILES = routeFiles();

  it('finds the route files', () => {
    expect(FILES).toContain('(tabs)/discover.tsx');
    expect(FILES).toContain('meetups/[id]/chat.tsx');
    expect(FILES.length).toBeGreaterThan(20);
  });

  it.each(FILES)('answers %s with its own title and description', (file) => {
    expect(routeMeta(sampleUrl(file))).not.toEqual(FALLBACK);
  });
});
