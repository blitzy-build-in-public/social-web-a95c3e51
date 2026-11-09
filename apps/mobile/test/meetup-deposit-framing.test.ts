/**
 * The meetup screen's deposit-framing decision table (`DEPOSIT_FRAMED`): which meetup states carry
 * the framing pair — the viewer's variant sentence about their own amount, then the safety card.
 *
 * The screen frames the deposit wherever the table says the state is a deposit screen and leaves the
 * other states to the sentence each states its money outcome with, so a verdict flipped by accident
 * would silently drop copy AAP 0.5.7 requires "on every deposit screen and deposit notification" and
 * AAP 0.5.8 shows "Always on deposit screens, by the viewer's variant", or frame a deposit that was
 * never held. One table-driven case covers all ten `MeetupStatus` values.
 *
 * The `vi.mock` calls below are a load harness, not part of the assertion: the screen is an Expo
 * module and this project runs in Node, which cannot parse React Native's Flow sources, and the
 * screen's `src/payments/card-setup` and `src/payments/next-action` imports are delivered as
 * `.native`/`.web` halves only, so no platform-neutral file resolves for them. `DEPOSIT_FRAMED` is a
 * module-scope table over `MeetupStatus`, so what the screen's dependencies are stubbed with cannot
 * change the verdict it states.
 */
import { describe, expect, it, vi } from 'vitest';

import { MeetupStatus } from '@tablemate/shared';

import { DEPOSIT_FRAMED } from '../app/meetups/[id]/index.tsx';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown): unknown => styles },
  Text: (): null => null,
  View: (): null => null,
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: (): null => null },
  router: { push: (): undefined => undefined },
  useLocalSearchParams: (): object => ({}),
}));
// The two payment modules are keyed by the specifier the screen writes, the one spelling an
// unresolvable platform split is matched on; the module mocks below are keyed by resolved file id.
vi.mock('../../../src/payments/card-setup', () => ({ CardSetup: (): null => null }));
vi.mock('../../../src/payments/next-action', () => ({
  completeNextAction: (): Promise<object> => Promise.resolve({}),
}));
vi.mock('../src/ui/index.ts', () => ({
  Avatar: (): null => null,
  Banner: (): null => null,
  Button: (): null => null,
  Card: (): null => null,
  ListItem: (): null => null,
  Screen: (): null => null,
  announce: (): undefined => undefined,
  useAppNoticeMessage: (): null => null,
}));
vi.mock('../src/state/meetup-store.ts', () => ({
  queryClient: {
    invalidateQueries: (): Promise<void> => Promise.resolve(),
    fetchQuery: (): Promise<object> => Promise.resolve({}),
  },
  queryKeys: {
    cities: ['cities'],
    me: ['me'],
    meetup: (id: string) => ['meetup', id],
    meetupsAll: ['meetups'],
  },
  useMe: () => ({ data: undefined }),
  useMeetup: () => ({ data: undefined }),
}));

/** The verdict each status must get: the five a deposit was held for frame it, the five others do not. */
const EXPECTED = {
  proposed: true,
  locked: true,
  declined: false,
  lapsed: false,
  cancelled: false,
  completed: true,
  forfeited: true,
  unattended: true,
  lock_lost: false,
  no_fault: false,
} satisfies Record<MeetupStatus, boolean>;

describe("the meetup screen's deposit framing", () => {
  it.each(MeetupStatus.options)('%s is framed as the decision table states', (status) => {
    expect(DEPOSIT_FRAMED[status]).toBe(EXPECTED[status]);
  });
});
