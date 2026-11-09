/**
 * The session store's record of a restore that ran, failed and proved nothing (AAP 0.5.1, AAP 0.5.8).
 *
 * The store is what this suite drives, because it is platform-free: it imports React and
 * `@tablemate/shared` alone. `src/auth/session.ts`, the one writer of the record, cannot be imported
 * here — its extensionless `./storage` import has only `storage.native.ts` and `storage.web.ts`
 * halves, which Metro resolves per platform and Node does not, which is why
 * `session-hydration.test.ts` exercises the client against fake hooks instead.
 *
 * Every case imports its own store, because the snapshot is module state and the setter refuses to
 * record a failure once the session has settled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientErrorCode } from '../src/api/errors.ts';
import type {
  SessionIdentity,
  SessionSnapshot,
  SessionStatus,
} from '../src/state/session-store.ts';

/** The store as one case sees it: the module, re-imported after a cold start. */
type Store = typeof import('../src/state/session-store.ts');

/** A signed-in identity, in the shape `setSignedIn` accepts. */
const IDENTITY: SessionIdentity = { userId: 'user-1', role: 'traveler', consented: true };

/** The failures a restore ends with while proving nothing — one per kind of cause (AAP 0.5.4). */
const CODES: readonly ClientErrorCode[] = [
  'network_error',
  'service_unavailable',
  'rate_limited',
  'internal_error',
];

/** One way an unknown session is answered, with the snapshot it publishes. */
type SettledCase = readonly [label: string, settle: (store: Store) => void, status: SessionStatus];

/** The two answers that end an unknown session, neither of them a failure. */
const SETTLED: readonly SettledCase[] = [
  ['a sign-in', (store) => store.setSignedIn(IDENTITY), 'signed_in'],
  ['a sign-out', (store) => store.setSignedOut(), 'signed_out'],
];

beforeEach(() => {
  // A cold start: the snapshot lives in the module, so each case reads a freshly imported one.
  vi.resetModules();
});

describe("the session store's failed-restore code", () => {
  it('is absent while no restore has run', async () => {
    const store = await import('../src/state/session-store.ts');

    expect(store.getSessionSnapshot()).toEqual({ status: 'loading' });
  });

  it.each(CODES)('republishes the snapshot carrying %s when a restore fails', async (code) => {
    const store = await import('../src/state/session-store.ts');
    const published: SessionSnapshot[] = [];
    const unsubscribe = store.subscribeSession(() => {
      published.push(store.getSessionSnapshot());
    });

    store.setRestoreFailure(code);
    unsubscribe();

    expect(store.getSessionSnapshot()).toEqual({ status: 'loading', restoreFailureCode: code });
    expect(published).toEqual([{ status: 'loading', restoreFailureCode: code }]);
  });

  it('notifies no subscriber when the same failure is recorded twice', async () => {
    const store = await import('../src/state/session-store.ts');
    let notifications = 0;
    const unsubscribe = store.subscribeSession(() => {
      notifications += 1;
    });

    store.setRestoreFailure('network_error');
    store.setRestoreFailure('network_error');
    unsubscribe();

    expect(notifications).toBe(1);
  });

  it.each(CODES)('clears %s again when a later attempt answers otherwise', async (code) => {
    const store = await import('../src/state/session-store.ts');
    store.setRestoreFailure(code);
    expect(store.getSessionSnapshot().restoreFailureCode).toBe(code);

    store.setRestoreFailure(null);

    expect(store.getSessionSnapshot()).toEqual({ status: 'loading' });
  });

  it.each(SETTLED)('clears the code on %s', async (_label, settle, status) => {
    const store = await import('../src/state/session-store.ts');
    store.setRestoreFailure('network_error');

    settle(store);

    expect(store.getSessionSnapshot().status).toBe(status);
    expect(store.getSessionSnapshot().restoreFailureCode).toBeUndefined();
  });

  it.each(SETTLED)(
    'leaves the published snapshot alone when a failure arrives after %s',
    async (_label, settle) => {
      const store = await import('../src/state/session-store.ts');
      settle(store);
      const settled = store.getSessionSnapshot();

      store.setRestoreFailure('network_error');

      expect(store.getSessionSnapshot()).toBe(settled);
    },
  );
});
