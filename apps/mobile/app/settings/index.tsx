/**
 * Settings (`/settings`, AAP 0.5.8, AAP 0.8.1): the Account section a traveler ends the session or
 * opens account deletion from, and the Legal section that opens the three legal pages. The Profile
 * tab reaches it at `profile-settings`, and account deletion is the hop after it
 * (`/settings/delete-account`), which is the path AAP 0.5.8 routes the safety basics through.
 *
 * Nothing here is gated on proof status and nothing is read from the API, so an unverified traveler
 * reaches every row exactly as a verified one does (AAP 0.5.8). The labels are this screen's own;
 * no string is duplicated from another screen, nothing is logged (AAP 0.11.1).
 */
import { useRef, useState, type ReactElement } from 'react';
import { StyleSheet, Text, View, type TextProps } from 'react-native';
import { Stack, router } from 'expo-router';
import { colors, fontWeights, spacing, typography } from '@tablemate/shared';

import { isApiError, userMessageFor } from '../../src/api/errors';
import { signOut } from '../../src/auth/session';
import { Banner, Button, ListItem, Screen, announce } from '../../src/ui';

const styles = StyleSheet.create({
  section: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  group: { gap: spacing.sm },
});

/**
 * The page heading, shown by the navigation header. `Screen` is given no title of its own: its title
 * renders a second level-1 heading beside the header's, and one page carries one `<h1>`.
 */
const TITLE = 'Settings';

/** The root Stack's header owns the status-bar inset, so claiming `top` here would add it twice. */
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

/** Where a sign-out leaves the traveler. The address is never a parameter (AAP 0.5.4). */
const SIGN_IN_ROUTE = '/sign-in';

/**
 * The two section headings. Level 2, because the navigation header renders the page's single
 * level-1 heading: a body heading at level 1 would be a second `<h1>`, and one below level 2 would
 * skip a level (WCAG 1.3.1) under it.
 */
const HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
  style: styles.section,
};

/** The test ids the e2e flows use (AAP 0.12.1); the two the contract names are never renamed. */
const SIGN_OUT_TEST_ID = 'settings-logout';
const ERROR_TEST_ID = 'settings-error';

/** One row: its test id, its visible label, the route it opens and an optional second line. */
type Row = readonly [testID: string, label: string, href: string, subtitle?: string];

/** Account: the destructive route, whose own screen carries the consequences and the confirmation. */
const ACCOUNT_ROWS: readonly Row[] = [
  [
    'settings-delete-account',
    'Delete account',
    '/settings/delete-account',
    'Permanently delete your profile and data',
  ],
];

/** Legal: the three pages a traveler can read without a proof (AAP 0.5.8). */
const LEGAL_ROWS: readonly Row[] = [
  ['settings-terms', 'Terms', '/legal/terms'],
  ['settings-safety', 'Safety tips', '/legal/safety'],
  ['settings-attribution', 'Data attribution', '/legal/attribution'],
];

/**
 * One row of a group, from its entry in the table above.
 *
 * `subtitle` is spread only for a row that has one, because `exactOptionalPropertyTypes` keeps an
 * absent optional property distinct from one present as `undefined`.
 */
function rowOf([testID, label, href, subtitle]: Row): ReactElement {
  return (
    <ListItem
      key={testID}
      label={label}
      onPress={() => router.push(href)}
      role="link"
      testID={testID}
      {...(subtitle === undefined ? {} : { subtitle })}
    />
  );
}

/**
 * Settings.
 *
 * @returns The screen: the Account section, whose sign-out revokes this session alone — the
 * account's other devices keep theirs until their refresh tokens expire or the account is deleted —
 * and the Legal section, whose three rows open the legal pages.
 */
export default function SettingsScreen(): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Both locks earn their place: the ref refuses a second press that lands before React re-renders,
  // and the state paints the first press as running and blocks the control while it does.
  const inFlight = useRef(false);

  /**
   * Ends the session once and then hands the traveler to sign-in.
   *
   * `signOut()` asks the API to revoke this session by default (`POST /auth/logout`, AAP 0.5.4) and
   * tears the local session down in a `finally`, whatever the server answered and whatever the
   * network did. Its resolution is therefore the evidence that the session store is signed out —
   * the teardown's last step is `setSignedOut()`, which the navigation gate in `app/_layout.tsx`
   * reads — and the navigation is placed after it so no reader is left on a screen of the session
   * they just ended. A rejection means the teardown itself failed and the session may still stand,
   * so the screen stays put, names the failure and leaves the press free to be retried.
   */
  function endSession(): void {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await signOut();
      } catch (caught) {
        inFlight.current = false;
        setBusy(false);
        const message = userMessageFor(isApiError(caught) ? caught.code : 'network_error');
        setError(message);
        announce(message);
        return;
      }
      router.replace(SIGN_IN_ROUTE);
    })();
  }

  return (
    <>
      <Stack.Screen options={{ title: TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="settings">
        <Text {...HEADING}>Account</Text>
        <View style={styles.group}>
          <Button
            busy={busy}
            label="Sign out"
            onPress={endSession}
            testID={SIGN_OUT_TEST_ID}
            variant="secondary"
          />
          {ACCOUNT_ROWS.map(rowOf)}
        </View>
        {error === null ? null : <Banner tone="error" message={error} testID={ERROR_TEST_ID} />}
        <Text {...HEADING}>Legal</Text>
        <View style={styles.group}>{LEGAL_ROWS.map(rowOf)}</View>
      </Screen>
    </>
  );
}
