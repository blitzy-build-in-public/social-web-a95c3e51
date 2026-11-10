/** The sign-in screen at `/sign-in`: the one way into Tablemate, and the first of the four WCAG 2.1 AA core flows. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { StyleSheet, Text, type TextInputProps } from 'react-native';
import { Stack, router } from 'expo-router';
import { MagicLinkRequest, colors, typography } from '@tablemate/shared';

import { isApiError, userMessageFor } from '../../src/api/errors';
import { requestMagicLink } from '../../src/auth/session';
import { Banner, Button, ListItem, Screen, TextField, announce } from '../../src/ui';

const INTRO = "Sign in with your email. We'll send you a one-time link — no password needed.";
const PRIVACY =
  "You'll get an auto-generated handle and avatar. We never ask for your real name, photo or " +
  'phone number.';
const openTerms = (): void => router.push('/legal/terms');
const openSafety = (): void => router.push('/legal/safety');
const EMAIL_INPUT_PROPS: TextInputProps = {
  autoCapitalize: 'none',
  autoComplete: 'email',
  autoCorrect: false,
  inputMode: 'email',
  keyboardType: 'email-address',
  maxLength: 254,
  returnKeyType: 'send',
  textContentType: 'emailAddress',
};
const SUBMIT_PROPS = { label: 'Email me a sign-in link', testID: 'sign-in-submit' } as const;
const ERROR_BANNER = { tone: 'error', testID: 'sign-in-error' } as const;
/** The sentence for a failed request; never the API's own `message` text. */
function failureMessage(error: unknown): string {
  if (!isApiError(error)) return userMessageFor('network_error');
  const message = userMessageFor(error.code);
  const seconds = error.retryAfterSeconds;
  if (error.code !== 'rate_limited' || seconds === undefined || seconds <= 0) return message;
  const minutes = Math.ceil(seconds / 60);
  const wait =
    seconds < 60
      ? `${seconds} second${seconds === 1 ? '' : 's'}`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${message} Try again in ${wait}.`;
}
export default function SignInScreen(): ReactElement {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    void requestMagicLink(address)
      .then(() => router.navigate('/check-email'))
      .catch((error: unknown) => {
        const message = failureMessage(error);
        if (isApiError(error) && error.code === 'invalid_email') setFieldError(message);
        else setFormError(message);
        announce(message);
      })
      .finally(() => {
        if (mounted.current) setSending(false);
      });
  }, [email, sending]);
  return (
    <>
      <Stack.Screen options={{ title: 'Sign in' }} />
      <Screen edges={['left', 'right', 'bottom']} testID="sign-in">
        <Text style={styles.body}>{INTRO}</Text>
        <Text style={styles.muted}>{PRIVACY}</Text>
        <TextField
          {...EMAIL_INPUT_PROPS}
          label="Email"
          value={email}
          onChangeText={changeEmail}
          onSubmitEditing={submit}
          testID="sign-in-email"
          error={fieldError}
        />
        {formError !== undefined && <Banner {...ERROR_BANNER} message={formError} />}
        <Button {...SUBMIT_PROPS} onPress={submit} busy={sending} disabled={sending} />
        <ListItem label="Terms" role="link" onPress={openTerms} testID="sign-in-terms" />
        <ListItem label="Safety tips" role="link" onPress={openSafety} testID="sign-in-safety" />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted },
});
