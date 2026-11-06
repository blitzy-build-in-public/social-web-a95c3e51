/**
 * The sign-in screen at `/sign-in` (AAP 0.5.8, AAP 0.7.1 row 1, AAP 0.8.1): the one way into
 * Tablemate, and the first of the four WCAG 2.1 AA core flows.
 *
 * The address is used for nothing but the one-time link. `POST /auth/magic-link` answers `202`
 * whatever the account state of the address, so this screen learns nothing from a success and
 * nothing can be enumerated through it (AAP 0.5.4); the link it mails is single use and expires in
 * 15 minutes (AAP 0.5.2). The address lives in this component's state alone — never in the URL,
 * never in storage, never in the query cache, never logged — and `announce()` is passed the app's
 * own sentence for a failure, never a field value or a server message.
 *
 * There is deliberately no redirect here: `apps/mobile/app/_layout.tsx` owns the gate, so this file
 * reads no session and routes only where its own success leads — `/check-email`, with no parameter,
 * because a query string is the last place an address may end up.
 *
 * Both failures are stated twice over and neither relies on colour alone (WCAG 1.4.1): a rejected
 * address is an inline field error linked to the input by `TextField`, every other failure is a
 * `Banner` whose live region speaks it on Android and web, and each is also announced through
 * `announce()` for iOS, which has no live region to speak a mounted notice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { TextInputProps } from 'react-native';
import { Stack, router } from 'expo-router';
import { MagicLinkRequest, colors, typography } from '@tablemate/shared';

import { isApiError, userMessageFor } from '../../src/api/errors';
import { requestMagicLink } from '../../src/auth/session';
import { Banner, Button, ListItem, Screen, TextField, announce } from '../../src/ui';

// --- Constants ----------------------------------------------------------------------------------

/**
 * The safe-area edges this screen claims: the `(auth)` navigator's header owns the top inset, so
 * claiming it here as well would add its height twice. The sides and the bottom belong to the page.
 */
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;

/** The header title, which the `(auth)` layout sets too and which is the page's heading. */
const TITLE = 'Sign in';

/** What signing in does, before the field: one link, no password. */
const INTRO = "Sign in with your email. We'll send you a one-time link — no password needed.";

/** What a first sign-in creates, in the terms the product is built on: no identity is asked for. */
const PRIVACY =
  "You'll get an auto-generated handle and avatar. We never ask for your real name, photo or " +
  'phone number.';

/** The field's visible label, which is also the input's accessible name. */
const EMAIL_LABEL = 'Email';

/** The screen's one action. */
const SUBMIT_LABEL = 'Email me a sign-in link';

/** The pages a traveler may read before signing in: both are public in the root gate. */
const TERMS_LABEL = 'Terms';
const SAFETY_LABEL = 'Safety tips';
const TERMS_ROUTE = '/legal/terms';
const SAFETY_ROUTE = '/legal/safety';

/** Where a successful request hands off. No parameter: the address never enters a URL (AAP 0.5.4). */
const CHECK_EMAIL_ROUTE = '/check-email';

/** The SMTP limit on a full address, matching `MagicLinkRequest` and the API's own bound. */
const EMAIL_MAX_LENGTH = 254;

/** The test handles the e2e flows and the accessibility checks use (AAP 0.12.1). */
const EMAIL_TEST_ID = 'sign-in-email';
const SUBMIT_TEST_ID = 'sign-in-submit';

/**
 * The attributes the field passes straight to the `TextInput`: the platform keyboards, the
 * autofill and the submit key that sends the form from the field itself (AAP 0.5.8), typed once so
 * the group is checked against `TextInputProps` rather than inline.
 */
const EMAIL_INPUT_PROPS: TextInputProps = {
  autoCapitalize: 'none',
  autoComplete: 'email',
  autoCorrect: false,
  inputMode: 'email',
  keyboardType: 'email-address',
  maxLength: EMAIL_MAX_LENGTH,
  returnKeyType: 'send',
  textContentType: 'emailAddress',
};

// --- Copy and error mapping ---------------------------------------------------------------------

/**
 * The wait a `429` asks for, as a sentence of its own, or null when the answer carried no usable
 * `Retry-After`. Seconds below a minute are counted, a longer wait is rounded up to whole minutes so
 * the sentence never understates it; `retryAfterSeconds` is only ever a hint, because the header is
 * unreadable cross-origin unless the answer exposes it (AAP 0.5.4).
 */
function waitText(seconds: number | undefined): string | null {
  if (seconds === undefined || seconds <= 0) return null;
  if (seconds < 60) return `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/**
 * The sentence this screen shows for a failed request: the copy the app fixes for the API's code,
 * the client's own network sentence for anything that is not an `ApiError`, and the rate-limit
 * sentence with its wait appended. Never the server's `message` text (AAP 0.11.1).
 */
function failureMessage(error: unknown): string {
  if (!isApiError(error)) return userMessageFor('network_error');
  if (error.code !== 'rate_limited') return userMessageFor(error.code);
  const message = userMessageFor('rate_limited');
  const wait = waitText(error.retryAfterSeconds);
  return wait === null ? message : `${message} ${wait}`;
}

// --- The screen ---------------------------------------------------------------------------------

/**
 * Requests a one-time sign-in link for an email address.
 *
 * A press is refused while a request is in flight, and the address is checked against
 * `MagicLinkRequest` before anything is sent, so an address the API would reject is rejected here
 * with no request at all. A `400 invalid_email` is shown on the field, because it is about the
 * address; every other failure — `429 rate_limited` included — is shown in the banner, because it
 * is about the request.
 *
 * @returns The sign-in form and its two public pages.
 */
export default function SignInScreen(): ReactElement {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  /**
   * Whether this component is still mounted. A request that settles after a navigation away would
   * otherwise set state on a screen nobody is looking at; the effect re-arms it on every mount, so a
   * development double-mount leaves the guard on.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Typing clears the field's error: it describes the address that was sent, not the new one. */
  const changeEmail = useCallback((next: string): void => {
    setEmail(next);
    setFieldError(undefined);
  }, []);

  const submit = useCallback((): void => {
    if (sending) return;

    const address = email.trim();
    if (!MagicLinkRequest.safeParse({ email: address }).success) {
      const message = userMessageFor('invalid_email');
      setFieldError(message);
      setFormError(undefined);
      announce(message);
      return;
    }

    setSending(true);
    setFieldError(undefined);
    setFormError(undefined);

    void (async () => {
      try {
        await requestMagicLink(address);
        // `push`, not `replace`: the browser's back control and the platform's back gesture return
        // to the form, which is where a traveler who mistyped their address wants to be.
        router.push(CHECK_EMAIL_ROUTE);
      } catch (error) {
        const message = failureMessage(error);
        if (isApiError(error) && error.code === 'invalid_email') {
          setFieldError(message);
        } else {
          setFormError(message);
        }
        announce(message);
      } finally {
        if (mounted.current) setSending(false);
      }
    })();
  }, [email, sending]);

  return (
    <>
      <Stack.Screen options={{ title: TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="sign-in">
        <Text style={styles.body}>{INTRO}</Text>
        <Text style={styles.muted}>{PRIVACY}</Text>

        <TextField
          {...EMAIL_INPUT_PROPS}
          label={EMAIL_LABEL}
          value={email}
          onChangeText={changeEmail}
          onSubmitEditing={submit}
          testID={EMAIL_TEST_ID}
          error={fieldError}
        />

        {formError === undefined ? null : (
          <Banner tone="error" message={formError} testID="sign-in-error" />
        )}

        {/* `busy` refuses the press while the request is in flight and reports the state to assistive
            technology; `disabled` paints the control as unavailable for the same moment. */}
        <Button
          label={SUBMIT_LABEL}
          onPress={submit}
          busy={sending}
          disabled={sending}
          testID={SUBMIT_TEST_ID}
        />

        <ListItem
          label={TERMS_LABEL}
          role="link"
          onPress={() => router.push(TERMS_ROUTE)}
          testID="sign-in-terms"
        />
        <ListItem
          label={SAFETY_LABEL}
          role="link"
          onPress={() => router.push(SAFETY_ROUTE)}
          testID="sign-in-safety"
        />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  // `text` on the page's `background` fill is a recorded pair at 17.21:1 and `textMuted` on it at
  // 7.07:1, so both readings clear AA normal text. Text keeps React Native's default
  // `allowFontScaling`, and nothing here is fixed in height, so a system font size scales the page.
  body: {
    ...typography.body,
    color: colors.text,
  },
  muted: {
    ...typography.body,
    color: colors.textMuted,
  },
});
