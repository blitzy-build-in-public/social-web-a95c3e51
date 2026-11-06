/**
 * Settings (`/settings`, AAP 0.5.8, AAP 0.8.1): the hop between the Profile tab and account
 * deletion, and the sign-out the Profile tab's own docblock says this screen holds.
 */
import { useRef, useState, type ReactElement } from 'react';
import { Stack, router } from 'expo-router';

import { signOut } from '../../src/auth/session';
import { ListItem, Screen } from '../../src/ui';

const TITLE = 'Settings';
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;
/** Where a sign-out leaves the traveler. The address is never a parameter (AAP 0.5.4). */
const SIGN_IN_ROUTE = '/sign-in';

/** The two rows that lead to each setting, with the test ids the e2e flows use (AAP 0.12.1). */
const ROWS = {
  delete: {
    label: 'Delete account',
    subtitle: 'Permanently removes your account and your profile.',
    role: 'link',
    testID: 'settings-delete-account',
  },
  signOut: { label: 'Sign out', role: 'button', testID: 'settings-sign-out' },
} as const;

export default function SettingsScreen(): ReactElement {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  function openDeletion(): void {
    router.push('/settings/delete-account');
  }
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
        <ListItem {...ROWS.delete} onPress={openDeletion} />
        <ListItem {...ROWS.signOut} onPress={endSession} disabled={busy} />
      </Screen>
    </>
  );
}
