/**
 * Saved-card setup on iOS and Android: the native half of a platform pair, and the type source for
 * both halves (AAP 0.3.4, AAP 0.5.1, AAP 0.8.1).
 *
 * Metro resolves an extensionless `./card-setup` to this file on iOS and Android and to
 * `card-setup.web.tsx` on the web, which types each of its exports against this file's. So every
 * export below has an identical counterpart there, and this file imports
 * `@stripe/stripe-react-native`, a native module no web bundle can hold: no neutral module may
 * reach it, only the two halves do.
 *
 * The card is entered inside Stripe's own PaymentSheet and nowhere else, so no card number, expiry
 * or CVC reaches this app's code, the API or a log line (AAP 0.12.2). The publishable key is the
 * only Stripe credential the client holds (AAP 0.3.2) and may legitimately be absent: the
 * credential-free default stack runs `STRIPE_MODE=mock`, where no card can be confirmed, so the card
 * step says payments are not configured rather than pretending (AAP 0.6.2, 0.11.2); no mocked
 * payment adapter is built. A saved card reaches the API only through Stripe's
 * `setup_intent.succeeded` webhook (AAP 0.3.3), after which the caller retries its hold through
 * `POST /v1/meetups/:id/hold` or `POST /v1/meetups/:id/accept` (AAP 0.5.4).
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

/**
 * The URL 3-D Secure and bank redirects return to (AAP 0.3.4). `app.config.ts` sets the scheme
 * `tablemate`, and the app root ignores this exact URL so Expo Router does not navigate when Stripe
 * hands the app back to itself.
 */
export const STRIPE_RETURN_URL = 'tablemate://stripe-redirect';

/** The label of the setup control. UI labels are not in the fixed-string table of AAP 0.5.8. */
const ADD_CARD_LABEL = 'Add a card';

/**
 * The publishable key this build was made with, or null when it has none. Read once, on the literal
 * `process.env.EXPO_PUBLIC_*` reference alone, because `babel-preset-expo` inlines only that form at
 * build time. `app.config.ts` has already refused a secret key there.
 */
function readPublishableKey(): string | null {
  const configured: unknown = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value === '' ? null : value;
}

/** This build's Stripe publishable key, or null. The only Stripe credential the client holds. */
const PUBLISHABLE_KEY = readPublishableKey();

/**
 * Whether this build can confirm a card at all (AAP 0.6.2, 0.11.2): false on the credential-free
 * default stack, where `STRIPE_MODE=mock` leaves the app without a publishable key.
 *
 * A screen that only wants to warn reads this instead of mounting a {@link CardSetup}.
 */
export function isPaymentsConfigured(): boolean {
  return PUBLISHABLE_KEY !== null;
}

/**
 * Every code a setup can fail with: the codes this API client can hold ({@link ClientErrorCode} —
 * `payment_unavailable`, `rate_limited`, `network_error` and the rest), plus the two only this flow
 * raises. `payments_unconfigured` is a build with no publishable key; `stripe_failed` is Stripe's
 * sheet refusing to open, failing during card entry, or failing to save the card.
 */
export type CardSetupErrorCode = ClientErrorCode | 'payments_unconfigured' | 'stripe_failed';

/**
 * The outcome of one setup attempt: no card data, no client secret and no Stripe message, so a
 * screen renders a sentence of this app's own for `code` (AAP 0.12.2, AAP 0.11.1). `saved` means
 * Stripe stored the card; the API learns of it from the `setup_intent.succeeded` webhook, so a
 * caller retries its hold instead of assuming the server knows (AAP 0.3.3).
 */
export type CardSetupResult =
  { status: 'saved' } | { status: 'cancelled' } | { status: 'failed'; code: CardSetupErrorCode };

/**
 * Props of {@link CardSetup}.
 */
export interface CardSetupProps {
  /** Called once with the outcome of the attempt the traveller started. */
  onDone: (result: CardSetupResult) => void;
  /** Test id of the primary control. Defaults to `payment-setup`. */
  testID?: string;
}

/**
 * Props of {@link PaymentsProvider}.
 */
export interface PaymentsProviderProps {
  /** The app tree. */
  children: ReactNode;
}

/**
 * What {@link useCardSetup} returns. `configured` is false on a build with no publishable key, in
 * which case `setupCard` resolves `payments_unconfigured` without touching Stripe.
 */
export interface UseCardSetupResult {
  /** Runs one setup attempt, joining one already in flight instead of starting a second. */
  setupCard: () => Promise<CardSetupResult>;
  /** Whether this build can confirm a card at all (AAP 0.6.2). */
  configured: boolean;
}

/**
 * The sentence a failed setup shows, in the app's own words (AAP 0.5.8). A code the API client
 * raised has its sentence in the shared map; `stripe_failed` and `payments_unconfigured` have none
 * and both leave the traveller where an unreachable payment route does, which is what
 * `payment_unavailable` says.
 */
function messageFor(code: CardSetupErrorCode): string {
  return code === 'stripe_failed' || code === 'payments_unconfigured'
    ? userMessageFor('payment_unavailable')
    : userMessageFor(code);
}

/**
 * Prepares and presents Stripe's sheet for one attempt (AAP 0.3.3, AAP 0.3.4). Never rejects: every
 * failure comes back as a {@link CardSetupResult}.
 */
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

/**
 * The setup hook a {@link CardSetup} or any other screen uses. A second call while an attempt runs
 * returns that attempt's promise, held in a ref, so a double press cannot open two PaymentSheets or
 * create two SetupIntents.
 */
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

/**
 * Initialises Stripe for the app, and is the only thing that does: mounted once by
 * `apps/mobile/app/_layout.tsx`, above every screen that can reach a setup or a hold. On a build
 * with no publishable key it renders its children unchanged — every screen that needs no card keeps
 * working and {@link CardSetup} explains the card step — so no screen has to guard it.
 */
export function PaymentsProvider({ children }: PaymentsProviderProps): ReactElement {
  if (PUBLISHABLE_KEY === null) return <>{children}</>;

  return (
    <StripeProvider publishableKey={PUBLISHABLE_KEY} urlScheme="tablemate">
      <>{children}</>
    </StripeProvider>
  );
}

/**
 * The saved-card step: one primary control that opens Stripe's PaymentSheet in setup mode, and the
 * app's own sentence for a failure. Where the build has no publishable key the control is rendered
 * disabled under the `CARD_PAYMENTS_UNAVAILABLE` notice, so it stays discoverable without pretending
 * a card can be added (AAP 0.11.2). Roles, accessible names, the 44x44 pt target, the live region
 * and the focus ring all come from {@link Button} and {@link Banner} and are never overridden here.
 */
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
