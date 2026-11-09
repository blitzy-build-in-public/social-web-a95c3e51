/**
 * Saved-card setup in the browser: the web half of the `card-setup` platform pair (AAP 0.3.4, AAP 0.5.1).
 *
 * `tsconfig.json`'s `moduleSuffixes` types an extensionless importer — and this file's own exports — against the native
 * half, whose module doc is the contract for both.
 * The card is entered inside Stripe's own Payment Element and nowhere else, so no card number, expiry or CVC reaches
 * this app's code, the API or a log line, and the publishable key is the only Stripe credential the page holds.
 * Stripe.js is loaded from `@stripe/stripe-js/pure`, whose `loadStripe` injects js.stripe.com on first use rather than at
 * import, so the credential-free `STRIPE_MODE=mock` stack says payments are not configured rather than reaching Stripe at
 * all. This file imports the two Stripe.js packages and never `@stripe/stripe-react-native`; the page's CSP must allow
 * js.stripe.com, api.stripe.com and Stripe's frames, and that policy lives in `infra/nginx/web.conf`.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe, StripeError, StripePaymentElement } from '@stripe/stripe-js';
import { spacing } from '@tablemate/shared';
import { apiClient } from '../api/client';
import { isApiError, userMessageFor } from '../api/errors';
import { CARD_PAYMENTS_UNAVAILABLE } from '../copy/strings';
import { Banner, Button, Screen, announce } from '../ui';
import type * as Native from './card-setup.native';
import type { CardSetupErrorCode, CardSetupResult, UseCardSetupResult } from './card-setup.native';

export type {
  CardSetupErrorCode,
  CardSetupProps,
  CardSetupResult,
  PaymentsProviderProps,
  UseCardSetupResult,
} from './card-setup.native';
export const STRIPE_RETURN_URL: typeof Native.STRIPE_RETURN_URL = 'tablemate://stripe-redirect';
const ADD_CARD_LABEL = 'Add a card';
const SAVE_CARD_LABEL = 'Save card';
const CANCEL_LABEL = 'Cancel';
const ADD_CARD_TITLE = 'Add a card';
const DEFAULT_TEST_ID = 'payment-setup';
const PAYMENT_UNAVAILABLE_MESSAGE = userMessageFor('payment_unavailable');

function readPublishableKey(): string | null {
  const configured: unknown = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value === '' ? null : value;
}

/** This build's Stripe publishable key, or null. The only Stripe credential the page holds. */
const PUBLISHABLE_KEY = readPublishableKey();

export const isPaymentsConfigured: typeof Native.isPaymentsConfigured = () =>
  PUBLISHABLE_KEY !== null;
/** The one Stripe.js instance promise for this page, created by the first {@link getStripe} call. */
let stripePromise: Promise<Stripe | null> | null = null;
/**
 * Web-only: `next-action.web.tsx` imports it through the explicit `./card-setup.web` specifier — an
 * extensionless import would type-check against the native half, which has no `getStripe` — and no screen
 * imports it.
 *
 * Created on first call and reused after that, so Stripe.js is fetched once per page and only by a page that
 * reaches the card step: importing this module contacts nothing, which is what keeps the credential-free
 * stack from reaching Stripe at all (AAP 0.6.2).
 */
export function getStripe(): Promise<Stripe | null> | null {
  if (PUBLISHABLE_KEY === null) return null;
  if (stripePromise === null) {
    stripePromise = loadStripe(PUBLISHABLE_KEY);
  }
  return stripePromise;
}

/**
 * Mirrors the native half: a code the API client raised has its sentence in the shared map, while
 * `stripe_failed` and `payments_unconfigured` have none and both leave the traveller where an unreachable
 * payment route does (AAP 0.5.8).
 */
function messageFor(code: CardSetupErrorCode): string {
  return code === 'stripe_failed' || code === 'payments_unconfigured'
    ? PAYMENT_UNAVAILABLE_MESSAGE
    : userMessageFor(code);
}

function cardErrorMessage(error: StripeError): string | null {
  if (error.type !== 'card_error' && error.type !== 'validation_error') return null;
  const message = error.message?.trim();
  return message === undefined || message === '' ? null : message;
}

type SetupIntentOutcome = { secret: string } | { code: CardSetupErrorCode };
/**
 * The API creates the Customer when the traveller has none, the SetupIntent with it and an ephemeral key;
 * only the secret is this file's business, since the key belongs to PaymentSheet on native. A failure is
 * classified the way every other route's is: an `ApiError`, `network_error` with status 0 included, or
 * `invalid_response` for an answer this client could not read (AAP 0.3.3, AAP 0.11.1).
 */
async function createSetupIntent(): Promise<SetupIntentOutcome> {
  try {
    const setup = await apiClient.createPaymentSetup();
    return { secret: setup.setupIntentClientSecret };
  } catch (err) {
    return { code: isApiError(err) ? err.code : 'invalid_response' };
  }
}

interface SetupFormProps {
  /** The SetupIntent's client secret from `POST /v1/me/payment-setup`. Never rendered or logged. */
  clientSecret: string;
  testID: string;
  onDone: (result: CardSetupResult) => void;
}

function SetupForm({ clientSecret, testID, onDone }: SetupFormProps): ReactElement {
  // Kept stable per secret: `Elements` accepts `clientSecret` and `fonts` as later updates only, and
  // the key above is what actually replaces the group.
  const options = useMemo(() => ({ clientSecret }), [clientSecret]);
  return (
    <Elements stripe={getStripe()} options={options} key={clientSecret}>
      <SetupFields testID={testID} onDone={onDone} />
    </Elements>
  );
}

interface SetupFieldsProps {
  testID: string;
  onDone: (result: CardSetupResult) => void;
}

function SetupFields({ testID, onDone }: SetupFieldsProps): ReactElement {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Set when the last attempt failed for a reason re-entering the card cannot fix: the traveller's
  // next press of Cancel then reports that failure instead of a change of mind.
  const unrecoverable = useRef(false);
  const handleReady = useCallback((element: StripePaymentElement) => {
    // The control that revealed this form is gone from the DOM by now, so a keyboard user's focus
    // would otherwise be back at the top of the page while the form waits below it. Stripe reports
    // the element fully rendered right here, which is the documented moment a `focus` call is
    // accepted, so the form takes the focus the step opened with.
    element.focus();
  }, []);
  const fail = useCallback((message: string) => {
    setBusy(false);
    setErrorMessage(message);
    // On the web the banner's own live region speaks first; this keeps the core flows' path
    // identical to the native half, where iOS has no live region at all (AAP 0.5.8).
    announce(message);
  }, []);
  const handleSubmit = useCallback(() => {
    if (stripe === null || elements === null) return;
    setErrorMessage(null);
    setBusy(true);
    void (async () => {
      try {
        // Card only, because the API creates the SetupIntent with
        // `allowed_payment_method_types: ['card']`, so `if_required` never leaves this page.
        const confirmed = await stripe.confirmSetup({
          elements,
          redirect: 'if_required',
          confirmParams: { return_url: window.location.href },
        });
        if (confirmed.error === undefined) {
          setBusy(false);
          onDone({ status: 'saved' });
          return;
        }
        const stripeMessage = cardErrorMessage(confirmed.error);
        if (stripeMessage === null) unrecoverable.current = true;
        fail(stripeMessage ?? PAYMENT_UNAVAILABLE_MESSAGE);
      } catch {
        // Stripe resolves an error result rather than throwing; a throw here is a Stripe.js failure
        // it reported no other way, which reads to the traveller as a card that could not be saved.
        unrecoverable.current = true;
        fail(PAYMENT_UNAVAILABLE_MESSAGE);
      }
    })();
  }, [elements, fail, onDone, stripe]);
  const handleCancel = useCallback(() => {
    onDone(
      unrecoverable.current ? { status: 'failed', code: 'stripe_failed' } : { status: 'cancelled' },
    );
  }, [onDone]);
  return (
    <View style={styles.form}>
      {errorMessage === null ? null : (
        <Banner tone="error" message={errorMessage} testID={`${testID}-error`} />
      )}
      <PaymentElement onReady={handleReady} />
      <Button
        label={SAVE_CARD_LABEL}
        onPress={handleSubmit}
        busy={busy}
        disabled={stripe === null || elements === null}
        testID={`${testID}-submit`}
      />
      <Button
        label={CANCEL_LABEL}
        variant="secondary"
        onPress={handleCancel}
        testID={`${testID}-cancel`}
      />
    </View>
  );
}

export const CardSetup: typeof Native.CardSetup = ({ onDone, testID = DEFAULT_TEST_ID }) => {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const handlePress = useCallback(() => {
    setErrorMessage(null);
    setBusy(true);
    void (async () => {
      const outcome = await createSetupIntent();
      setBusy(false);
      if ('code' in outcome) {
        const message = messageFor(outcome.code);
        setErrorMessage(message);
        announce(message);
        onDone({ status: 'failed', code: outcome.code });
        return;
      }
      setClientSecret(outcome.secret);
    })();
  }, [onDone]);
  const handleSetupDone = useCallback(
    (result: CardSetupResult) => {
      setClientSecret(null);
      if (result.status === 'failed') {
        const message = messageFor(result.code);
        setErrorMessage(message);
        announce(message);
      }
      onDone(result);
    },
    [onDone],
  );
  if (!isPaymentsConfigured()) {
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
      {clientSecret === null ? (
        <Button label={ADD_CARD_LABEL} onPress={handlePress} busy={busy} testID={testID} />
      ) : (
        <SetupForm clientSecret={clientSecret} testID={testID} onDone={handleSetupDone} />
      )}
    </>
  );
};

interface CardSetupModalValue {
  /** Opens the modal and resolves with the attempt's outcome, joining one already in flight. */
  open: () => Promise<CardSetupResult>;
}

const CardSetupModalContext = createContext<CardSetupModalValue | null>(null);

interface PendingSetup {
  promise: Promise<CardSetupResult>;
  resolve: (result: CardSetupResult) => void;
}

export const PaymentsProvider: typeof Native.PaymentsProvider = ({ children }) => {
  const [visible, setVisible] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // A ref rather than state: the attempt's promise is never rendered, and a second open() has to
  // read it before React has re-rendered anything.
  const pending = useRef<PendingSetup | null>(null);
  const finish = useCallback((result: CardSetupResult) => {
    const running = pending.current;
    pending.current = null;
    setVisible(false);
    setClientSecret(null);
    if (running !== null) running.resolve(result);
  }, []);
  const requestClose = useCallback(() => {
    finish({ status: 'cancelled' });
  }, [finish]);
  const open = useCallback((): Promise<CardSetupResult> => {
    const running = pending.current;
    if (running !== null) return running.promise;
    if (PUBLISHABLE_KEY === null) {
      return Promise.resolve({ status: 'failed', code: 'payments_unconfigured' });
    }
    // The executor runs synchronously, so `attempt` below holds the real resolver.
    let settle: (result: CardSetupResult) => void = () => undefined;
    const promise = new Promise<CardSetupResult>((resolve) => {
      settle = resolve;
    });
    const attempt: PendingSetup = { promise, resolve: settle };
    pending.current = attempt;
    setClientSecret(null);
    setVisible(true);
    void (async () => {
      const outcome = await createSetupIntent();
      // A cancel during the request has already settled the attempt and closed the modal; its late
      // answer is dropped rather than reopening the form.
      if (pending.current !== attempt) return;
      if ('code' in outcome) {
        finish({ status: 'failed', code: outcome.code });
        return;
      }
      setClientSecret(outcome.secret);
    })();
    return promise;
  }, [finish]);
  const value = useMemo(() => ({ open }), [open]);
  if (PUBLISHABLE_KEY === null) return <>{children}</>;
  return (
    <CardSetupModalContext.Provider value={value}>
      {children}
      <Modal
        animationType="slide"
        onRequestClose={requestClose}
        transparent={false}
        visible={visible}
      >
        {/* The title names the step and leads the reading and focus order a screen reader follows. */}
        <Screen title={ADD_CARD_TITLE}>
          {clientSecret === null ? (
            <Button
              label={CANCEL_LABEL}
              variant="secondary"
              onPress={requestClose}
              testID={`${DEFAULT_TEST_ID}-cancel`}
            />
          ) : (
            <SetupForm clientSecret={clientSecret} testID={DEFAULT_TEST_ID} onDone={finish} />
          )}
        </Screen>
      </Modal>
    </CardSetupModalContext.Provider>
  );
};

export const useCardSetup: typeof Native.useCardSetup = (): UseCardSetupResult => {
  const modal = useContext(CardSetupModalContext);
  const setupCard = useCallback((): Promise<CardSetupResult> => {
    if (modal === null) {
      return Promise.resolve({ status: 'failed', code: 'payments_unconfigured' });
    }
    return modal.open();
  }, [modal]);
  return { setupCard, configured: isPaymentsConfigured() };
};

const styles = StyleSheet.create({
  form: {
    // One spacing step between the notice, the card fields and the two controls, so a screen mounts
    // the form without applying margins around it.
    gap: spacing.lg,
  },
});
