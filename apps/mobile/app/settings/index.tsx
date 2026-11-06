/**
 * Settings (`/settings`, AAP 0.5.8, AAP 0.8.1): the hop between the Profile tab and account
 * deletion, and the sign-out the Profile tab's own docblock says this screen holds.
 *
 * AAP 0.5.8's navigation map reads "Account deletion | Profile → Settings → Delete account
 * (`app/settings/delete-account.tsx`)", and its Profile line keeps "settings, account deletion"
 * reachable without a valid proof. This screen is that hop: it carries the two rows and nothing
 * else. It reads nothing from the API and gates nothing on proof status, so an unverified traveler
 * reaches both rows exactly as a verified one does (AAP 0.5.8). The rows the Profile tab already
 * carries — profile editing, My stay and the visibility toggle, Table Credit, the saved card, and
 * the three legal pages — are not repeated here (AAP 0.5.8).
 *
 * Sign-out is the session module's default remote logout — `POST /auth/logout` revokes the session
 * and the local teardown follows whether or not the server answered (AAP 0.1.1, AAP 0.5.4) — so
 * there is no failure this screen could report and it renders no banner for one.
 *
 * Nothing here logs: not a session field, not the route it leaves for (AAP 0.11.1).
 */
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Stack, router } from 'expo-router';

import { signOut } from '../../src/auth/session';
import { ListItem, Screen } from '../../src/ui';

/** The header title. The navigator's header is the page's one heading, so `Screen` gets no title. */
const TITLE = 'Settings';

/** The root Stack's header owns the status-bar inset, so claiming `top` here would add it twice. */
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

/** The child route of this one: the next hop of the AAP 0.5.8 path, which owns the confirmation. */
const DELETE_ACCOUNT_ROUTE = '/settings/delete-account';

/** Where a sign-out leaves the traveler. The address is never a parameter (AAP 0.5.4). */
const SIGN_IN_ROUTE = '/sign-in';

/** The visible labels of the controls, each of which is also its control's accessible name. */
const DELETE_LABEL = 'Delete account';
const SIGN_OUT_LABEL = 'Sign out';

/** The deletion row's second line, announced after the label as part of the row's name. */
const DELETE_SUBTITLE = 'Permanently removes your account and your profile.';

/** The test ids the e2e flows use (AAP 0.12.1). */
const DELETE_TEST_ID = 'settings-delete-account';
const SIGN_OUT_TEST_ID = 'settings-sign-out';

/**
 * Settings.
 *
 * @returns The screen: the row that opens account deletion, then the row that ends the session.
 */
export default function SettingsScreen(): ReactElement {
  const [busy, setBusy] = useState(false);
  // Kept beside `busy` on purpose, because they are separate locks: the ref stops a second press
  // reaching `signOut` before React has re-rendered, and `busy` shows the first press running.
  const inFlight = useRef(false);

  /** Opens the deletion screen, which carries the consequences and the two-step confirmation. */
  function openDeletion(): void {
    router.push(DELETE_ACCOUNT_ROUTE);
  }

  /**
   * Ends the session once and hands the traveler to sign-in, whatever the server or the teardown
   * says: `signOut()` asks the API to revoke the session by default (AAP 0.5.4) and ends the local
   * session in every case, so there is nothing here to report. The latch stays closed once the
   * sign-out has started, because the screen is on its way out.
   */
  function endSession(): void {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void (async () => {
      try {
        await signOut();
      } finally {
        router.replace(SIGN_IN_ROUTE);
      }
    })();
  }

  return (
    <>
      <Stack.Screen options={{ title: TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="settings">
        {/* Source order is reading and focus order: deletion first, sign-out second (AAP 0.5.8). */}
        <ListItem
          label={DELETE_LABEL}
          subtitle={DELETE_SUBTITLE}
          onPress={openDeletion}
          role="link"
          testID={DELETE_TEST_ID}
        />
        <ListItem
          label={SIGN_OUT_LABEL}
          onPress={endSession}
          role="button"
          disabled={busy}
          testID={SIGN_OUT_TEST_ID}
        />
      </Screen>
    </>
  );
}
