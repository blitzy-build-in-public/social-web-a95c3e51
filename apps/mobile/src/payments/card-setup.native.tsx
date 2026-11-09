/**
 * Saved-card setup on iOS and Android: the native half of a platform pair, and the type source for both halves
 * (AAP 0.3.4, AAP 0.5.1).
 *
 * Metro resolves an extensionless `./card-setup` here and to `card-setup.web.tsx` on the web, which types its exports
 * against this file's. This file imports `@stripe/stripe-react-native`, a native module no web bundle can hold.
 * The card is entered inside Stripe's own PaymentSheet and nowhere else, so no card number, expiry or CVC reaches this
 * app's code, the API or a log line. The publishable key is the only Stripe credential the client holds and may
 * legitimately be absent: the credential-free default stack runs `STRIPE_MODE=mock`, where the card step says payments
 * are not configured rather than pretending. A saved card reaches the API only through Stripe's
 * `setup_intent.succeeded` webhook, after which the caller retries its hold through `POST /v1/meetups/:id/hold` or
 * `.../accept`.
 */
import { useCallback, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  PaymentSheetError,
  StripeProvider,
  initPaymentSheet,
  presentPaymentSheet,
} from '@stripe/stripe-react-native';
import type { PaymentSetupResponse } from '@tablemate/shared';
import { apiClient } from '../api/client';
import { isApiError, userMessageFor } from '../api/errors';
import type { ClientErrorCode } from '../api/errors';
import { CARD_PAYMENTS_UNAVAILABLE } from '../copy/strings';
import { Banner, Button, announce } from '../ui';
export const STRIPE_RETURN_URL = 'tablemate://stripe-redirect';
const ADD_CARD_LABEL = 'Add a card';

function readPublishableKey(): string | null {
  const configured: unknown = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value === '' ? null : value;
}

const PUBLISHABLE_KEY = readPublishableKey();

export function isPaymentsConfigured(): boolean {
  return PUBLISHABLE_KEY !== null;
}

export type CardSetupErrorCode = ClientErrorCode | 'payments_unconfigured' | 'stripe_failed';

export type CardSetupResult =
  { status: 'saved' } | { status: 'cancelled' } | { status: 'failed'; code: CardSetupErrorCode };

export interface CardSetupProps {
  onDone: (result: CardSetupResult) => void;
  testID?: string;
}

export interface PaymentsProviderProps {
  children: ReactNode;
}

export interface UseCardSetupResult {
  setupCard: () => Promise<CardSetupResult>;
  configured: boolean;
}

function messageFor(code: CardSetupErrorCode): string {
  return code === 'stripe_failed' || code === 'payments_unconfigured'
    ? userMessageFor('payment_unavailable')
    : userMessageFor(code);
}

async function runSetupCard(): Promise<CardSetupResult> {
  if (!isPaymentsConfigured()) return { status: 'failed', code: 'payments_unconfigured' };
  let setup: PaymentSetupResponse;
  try {
    // The API creates the Customer when the traveller has none, the SetupIntent and the ephemeral
    // key (AAP 0.3.3).
    setup = await apiClient.createPaymentSetup();
  } catch (err) {
    // `ApiError` is the only error the API client raises and it has already classified the failure
    // — `network_error`, carried with status 0, included (AAP 0.11.1). Anything else is an answer
    // this client could not read.
    return { status: 'failed', code: isApiError(err) ? err.code : 'invalid_response' };
  }
  // The SetupIntent's client secret and the ephemeral key live in these locals for the length of
  // this call and nowhere else: never in state, storage, a log line or the result.
  const { customerId, setupIntentClientSecret, ephemeralKeySecret } = setup;
  try {
    const initialised = await initPaymentSheet({
      merchantDisplayName: 'Tablemate',
      customerId,
      customerEphemeralKeySecret: ephemeralKeySecret,
      setupIntentClientSecret,
      returnURL: STRIPE_RETURN_URL,
    });
    if (initialised.error !== undefined) return { status: 'failed', code: 'stripe_failed' };
    const presented = await presentPaymentSheet();
    if (presented.error === undefined) return { status: 'saved' };
    // Closing the sheet is the traveller changing their mind, not a failure: it shows nothing.
    return presented.error.code === PaymentSheetError.Canceled
      ? { status: 'cancelled' }
      : { status: 'failed', code: 'stripe_failed' };
  } catch {
    // Stripe resolves an error result rather than throwing; a throw here is a native failure it
    // reported no other way, which reads to the traveller as a card that could not be saved.
    return { status: 'failed', code: 'stripe_failed' };
  }
}

export function useCardSetup(): UseCardSetupResult {
  const inFlight = useRef<Promise<CardSetupResult> | null>(null);
  const setupCard = useCallback((): Promise<CardSetupResult> => {
    const running = inFlight.current;
    if (running !== null) return running;
    // Cleared on settlement, so the guard covers exactly the attempt in flight rather than the life
    // of the hook.
    inFlight.current = runSetupCard().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, []);
  return { setupCard, configured: isPaymentsConfigured() };
}

export function PaymentsProvider({ children }: PaymentsProviderProps): ReactElement {
  if (PUBLISHABLE_KEY === null) return <>{children}</>;
  return (
    <StripeProvider publishableKey={PUBLISHABLE_KEY} urlScheme="tablemate">
      <>{children}</>
    </StripeProvider>
  );
}

export function CardSetup({ onDone, testID = 'payment-setup' }: CardSetupProps): ReactElement {
  const { setupCard, configured } = useCardSetup();
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const handlePress = useCallback(() => {
    // The previous attempt's failure stops being true the moment a new one starts.
    setErrorMessage(null);
    setBusy(true);
    void (async () => {
      let result: CardSetupResult;
      try {
        result = await setupCard();
      } catch {
        // `setupCard` resolves in every case; this keeps an unforeseen rejection from leaving the
        // control busy for good.
        result = { status: 'failed', code: 'stripe_failed' };
      }
      setBusy(false);
      if (result.status === 'failed') {
        const message = messageFor(result.code);
        setErrorMessage(message);
        // iOS has no live region to speak the banner and Android's does not cover a mounted one, so
        // the lock flow announces in addition to rendering it (AAP 0.5.8).
        announce(message);
      }
      onDone(result);
    })();
  }, [onDone, setupCard]);
  if (!configured) {
    return (
      <>
        <Banner
          tone="warning"
          message={CARD_PAYMENTS_UNAVAILABLE}
          testID={`${testID}-unavailable`}
        />
        <Button label={ADD_CARD_LABEL} onPress={handlePress} disabled testID={testID} />
      </>
    );
  }
  return (
    <>
      {errorMessage === null ? null : (
        <Banner tone="error" message={errorMessage} testID={`${testID}-error`} />
      )}
      <Button label={ADD_CARD_LABEL} onPress={handlePress} busy={busy} testID={testID} />
    </>
  );
}
