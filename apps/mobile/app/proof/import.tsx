/**
 * Proof import — the booking confirmation whose proof unlocks meetups (`/proof/import`, AAP 0.5.8,
 * AAP 0.5.5, criterion 3).
 *
 * The first half of the two-screen proof flow: this screen takes one `.eml` — from the file picker,
 * or on native from the share sheet or an "Open in" hand-off — stages it in memory for
 * `app/proof/generate.tsx`, and does nothing else with it. The email is read on the device and never
 * travels: the bytes live in the staged handle for the length of one attempt and reach neither this
 * component's state, a route parameter, a store field nor a log line, and the handle is released on
 * every path, the traveller who leaves before generating included (AAP 0.5.5, AAP 0.12.2).
 *
 * Before anything is chosen the screen states what will happen: the privacy sentence, how to export a
 * confirmation as `.eml`, and the booking sites the published configuration supports — with those
 * still awaiting real confirmation emails named as not yet supported (AAP 0.5.5, AAP 0.5.8). A share
 * URI is as confidential as the bytes it names, so it is read once per value, cleared from the route
 * once used, and never rendered, stored or logged.
 */
import { useQuery } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, Text } from 'react-native';
import { colors, fontWeights, typography } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import {
  EMAIL_STAYS_ON_DEVICE,
  UNSUPPORTED_ISSUER,
  supportedIssuersText,
} from '../../src/copy/strings';
import { queryKeys } from '../../src/state/meetup-store';
import { resetProof, useProofState } from '../../src/state/proof-store';
import type { ProofFlowStatus } from '../../src/state/proof-store';
import { Banner, Button, Card, Screen, announce } from '../../src/ui';
import { fromShareIntent, pickEml } from '../../src/zk/eml-intake';
import {
  discardPendingEml,
  errorCodeOf,
  issuerSupport,
  stagePendingEml,
} from '../../src/zk/prover.ts';
import type { EmlHandle } from '../../src/zk/prover.ts';

// --- Constants -----------------------------------------------------------------------------------

/** The route's header title, and the page's only heading: the Stack renders it (AAP 0.5.8). */
const SCREEN_TITLE = 'Verify my stay';

/** The edges this screen insets by: the Stack header already clears the status bar. */
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

/** What happens to the file, said before one is chosen. It is literally true (AAP 0.5.5, 0.12.2). */
const PRIVACY_EXPLANATION =
  'Tablemate reads the booking confirmation here, on this device, and proves the city and dates you are staying in. Only that proof is sent — the email itself never is.';

/** How to turn a confirmation into a file, plus the native share route where there is one. */
const INSTRUCTION =
  'Export your booking confirmation from your mail app as an .eml file, then choose it here.';
const SHARE_INSTRUCTION = ' You can also share it to Tablemate from your mail app.';

/** The picker's visible label, which is also its accessible name, and its native hint. */
const PICK_LABEL = 'Choose a booking email (.eml)';
const PICK_HINT = 'Opens the file picker. The file is read only on this device.';

/** Shown while `GET /zk/config` is in flight, and the retry offered when that read fails. */
const LOADING_SUPPORT = 'Loading supported booking sites…';
const RETRY_LABEL = 'Try again';

/** The line naming the booking sites that are not supported yet; and the intake failure's sentence. */
const NOT_SUPPORTED_PREFIX = 'Not yet supported: ';
const INTAKE_FAILED =
  "We couldn't read that file. Choose the booking confirmation saved as an .eml file.";

/**
 * The statuses an earlier attempt can leave behind: re-entering the screen after a failed, abandoned
 * or accepted proof must not paint that attempt over a fresh import (AAP 0.5.5).
 */
function isStaleStatus(status: ProofFlowStatus): boolean {
  return status === 'error' || status === 'cancelled' || status === 'accepted';
}

/** The sentence this screen shows for a failed request: this app's copy for its code (AAP 0.11.1). */
function messageFor(error: unknown): string {
  return userMessageFor(errorCodeOf(error));
}

/**
 * A failed intake: the request's own failure — a session that ended, or the `network_error` of a
 * request that never reached the API, which is an `ApiError` too — gets this app's copy for its code,
 * and anything the intake raised this screen's own sentence, so no platform or server error text is
 * ever shown (AAP 0.11.1).
 */
function intakeFailureMessage(error: unknown): string {
  return isApiError(error) ? userMessageFor(error.code) : INTAKE_FAILED;
}

/**
 * The `uri` of a shared or opened file, in the one shape `useLocalSearchParams` can give it: Expo
 * Router hands a repeated query parameter over as `string[]`, so the first entry is taken. Anything
 * else — absent, not a string, whitespace alone — is the empty string the share effect decides on.
 */
function normalizeUri(raw: unknown): string {
  // Annotated `unknown`: `Array.isArray` narrows to `any[]`, and nothing below trusts its element.
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

// --- The screen ----------------------------------------------------------------------------------

/**
 * The proof import screen: the privacy statement, the instruction and the booking sites the
 * configuration supports, then the picker that hands the chosen file to `app/proof/generate.tsx`
 * (AAP 0.5.8). Every failure is shown in a `Banner`'s live region and announced, so a screen-reader
 * user hears it too.
 *
 * @returns The import screen's element.
 */
export default function ProofImportScreen(): ReactElement {
  const proof = useProofState();
  /** The status this mount began with: the one thing the reset effect below reads it for. */
  const initialStatus = useRef(proof.status);

  const params = useLocalSearchParams<{ uri?: string | string[] }>();
  const shareUri = normalizeUri(params.uri);

  /** The URI already read, set before the read so no render or re-run can read one file twice. */
  const handledUri = useRef<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [intakeMessage, setIntakeMessage] = useState<string | null>(null);

  const zkConfig = useQuery({
    queryKey: queryKeys.zkConfig,
    queryFn: () => apiClient.getZkConfig(),
  });

  // A status left by an earlier attempt would otherwise paint that attempt's error or progress over a
  // fresh import, so it is cleared once, on mount (AAP 0.5.5).
  useEffect(() => {
    if (isStaleStatus(initialStatus.current)) resetProof();
  }, []);

  // A file staged and then left behind — the traveller went back before generate read it — is an
  // app-owned copy, so the handle is released here. It is a no-op once generate has taken it, and this
  // screen stays mounted beneath generate while the proof runs (AAP 0.5.5).
  useEffect(
    () => () => {
      void discardPendingEml();
    },
    [],
  );

  /** Stages one chosen or shared file and moves on to the generate screen. The handle travels through
   * `stagePendingEml`, never through a route parameter or this component's state. */
  const handOver = useCallback(
    async (handle: EmlHandle, clearShareParam: boolean): Promise<void> => {
      await stagePendingEml(handle);
      // Cleared before navigating, so returning from generate cannot read the same file a second time.
      if (clearShareParam) router.setParams({ uri: undefined });
      router.push('/proof/generate');
    },
    [],
  );

  /** Reports a failed intake, once: the banner is the live region Android and web read, and `announce`
   * is the announcement iOS has no live region for (AAP 0.5.8). */
  const reportFailure = useCallback((error: unknown): void => {
    const message = intakeFailureMessage(error);
    setIntakeMessage(message);
    announce(message);
  }, []);

  /** Opens the picker for one booking confirmation.
   *
   * `pickEml()` is called here, inside the press and before anything is awaited: a browser opens its
   * file input only while the click is still being handled — Safari especially — and Playwright's file
   * chooser depends on the same rule. */
  const chooseEml = useCallback((): void => {
    if (busy) return;
    setBusy(true);
    setIntakeMessage(null);

    const picked = pickEml();
    void (async () => {
      try {
        const handle = await picked;
        // A cancelled pick is not a failure: nothing is shown and the screen is left as it was.
        if (handle === null) return;
        await handOver(handle, false);
      } catch (error) {
        reportFailure(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, handOver, reportFailure]);

  // The share sheet and "Open in" deliver a native file as a `uri`; the web build has neither, and
  // `app/+native-intent.tsx` rewrites a delivered file URL on native alone, so web never calls
  // `fromShareIntent` (AAP 0.3.4). Each distinct URI is read once — the guard is set before the read,
  // so a re-render, React StrictMode's second effect run or a return to this screen cannot read one
  // file twice — while a newly delivered URI is still handled once.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (shareUri === '' || handledUri.current === shareUri) return;
    handledUri.current = shareUri;

    void (async () => {
      setBusy(true);
      setIntakeMessage(null);
      try {
        await handOver(await fromShareIntent(shareUri), true);
      } catch (error) {
        reportFailure(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [handOver, reportFailure, shareUri]);

  const support = zkConfig.data === undefined ? null : issuerSupport(zkConfig.data);
  const configMessage = zkConfig.error === null ? null : messageFor(zkConfig.error);

  // Each distinct failure is spoken once; a re-render over the same failed read repeats nothing.
  useEffect(() => {
    if (configMessage !== null) announce(configMessage);
  }, [configMessage]);

  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="proof-import">
        {/* The promise the flow rests on, read before the first choice (AAP 0.5.5, 0.12.2). */}
        <Card testID="proof-privacy">
          <Text style={styles.statement}>{EMAIL_STAYS_ON_DEVICE}</Text>
          <Text style={styles.body}>{PRIVACY_EXPLANATION}</Text>
        </Card>

        <Text style={styles.body}>
          {Platform.OS === 'web' ? INSTRUCTION : `${INSTRUCTION}${SHARE_INSTRUCTION}`}
        </Text>

        {zkConfig.isPending ? <Text style={styles.muted}>{LOADING_SUPPORT}</Text> : null}

        {configMessage === null ? null : (
          <Banner
            tone="error"
            message={configMessage}
            action={{
              label: RETRY_LABEL,
              onPress: () => void zkConfig.refetch(),
              testID: 'proof-config-retry',
            }}
            testID="proof-config-error"
          />
        )}

        {support === null ? null : (
          <Text style={styles.muted}>{supportedIssuersText(support.supported)}</Text>
        )}

        {/* Sites awaiting real confirmation emails: a limitation rather than an error, and the visible
            title carries it without relying on the tone's colour (AAP 0.5.5, 0.5.8). */}
        {support === null || support.unsupported.length === 0 ? null : (
          <Banner
            tone="warning"
            title={UNSUPPORTED_ISSUER}
            message={`${NOT_SUPPORTED_PREFIX}${support.unsupported.join(', ')}.`}
            testID="proof-unsupported"
          />
        )}

        <Button
          label={PICK_LABEL}
          onPress={chooseEml}
          busy={busy}
          hint={PICK_HINT}
          testID="proof-import-pick"
        />

        {intakeMessage === null ? null : (
          <Banner tone="error" message={intakeMessage} testID="proof-intake-error" />
        )}
      </Screen>
    </>
  );
}

// --- Styles --------------------------------------------------------------------------------------

/* Only the type differs between these three; every colour is a token whose pair is recorded against
 * the fill it is painted on. */
const styles = StyleSheet.create({
  statement: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  body: {
    ...typography.body,
    color: colors.text,
  },
  muted: {
    ...typography.body,
    color: colors.textMuted,
  },
});
