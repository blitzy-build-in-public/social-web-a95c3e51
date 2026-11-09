/**
 * Proof import — the booking confirmation whose proof unlocks meetups (`/proof/import`, AAP 0.5.8,
 * AAP 0.5.5, criterion 3).
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
  unsupportedIssuersText,
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

const SCREEN_TITLE = 'Verify my stay';

const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

const PRIVACY_EXPLANATION =
  'Tablemate reads the booking confirmation here, on this device, and proves the city and dates you are staying in. Only that proof is sent — the email itself never is.';
const INSTRUCTION =
  'Export your booking confirmation from your mail app as an .eml file, then choose it here.';
const SHARE_INSTRUCTION = ' You can also share it to Tablemate from your mail app.';

const PICK_LABEL = 'Choose a booking email (.eml)';
const PICK_HINT = 'Opens the file picker. The file is read only on this device.';
const PICK_TEXT = { label: PICK_LABEL, hint: PICK_HINT };

const LOADING_SUPPORT = 'Loading supported booking sites…';
const RETRY_LABEL = 'Try again';

const INTAKE_FAILED =
  "We couldn't read that file. Choose the booking confirmation saved as an .eml file.";

const STALE_STATUSES: readonly ProofFlowStatus[] = ['error', 'cancelled', 'accepted'];

const UNSUPPORTED_BANNER = { tone: 'warning', title: UNSUPPORTED_ISSUER } as const;

export default function ProofImportScreen(): ReactElement {
  const proof = useProofState();
  const initialStatus = useRef(proof.status);
  const params = useLocalSearchParams<{ uri?: string | string[] }>();
  const rawUri: unknown = Array.isArray(params.uri) ? params.uri[0] : params.uri;
  const shareUri = typeof rawUri === 'string' ? rawUri.trim() : '';
  const handledUri = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const config = useQuery({ queryKey: queryKeys.zkConfig, queryFn: () => apiClient.getZkConfig() });
  const { refetch } = config;
  useEffect(() => {
    if (STALE_STATUSES.includes(initialStatus.current)) resetProof();
  }, []);
  useEffect(() => () => void discardPendingEml(), []);
  const handOver = useCallback(async (handle: EmlHandle | null, clear: boolean): Promise<void> => {
    if (handle === null) return;
    await stagePendingEml(handle);
    if (clear) router.setParams({ uri: undefined });
    router.push('/proof/generate');
  }, []);
  const reportFailure = useCallback((error: unknown): void => {
    const message = isApiError(error) ? userMessageFor(error.code) : INTAKE_FAILED;
    setIntakeError(message);
    announce(message);
  }, []);
  const stopBusy = (): void => setBusy(false);
  const guarded = useCallback(
    (run: () => Promise<void>): void => {
      setBusy(true);
      setIntakeError(null);
      void run().catch(reportFailure).finally(stopBusy);
    },
    [reportFailure],
  );
  const chooseEml = useCallback((): void => {
    if (busy) return;
    const picked = pickEml();
    guarded(async () => handOver(await picked, false));
  }, [busy, guarded, handOver]);
  useEffect(() => {
    if (Platform.OS === 'web' || shareUri === '' || handledUri.current === shareUri) return;
    handledUri.current = shareUri;
    guarded(async () => handOver(await fromShareIntent(shareUri), true));
  }, [guarded, handOver, shareUri]);
  const support = config.data === undefined ? null : issuerSupport(config.data);
  const configError = config.error === null ? null : userMessageFor(errorCodeOf(config.error));
  const issuers = support === null ? null : supportedIssuersText(support.supported);
  const instruction = Platform.OS === 'web' ? INSTRUCTION : `${INSTRUCTION}${SHARE_INSTRUCTION}`;
  const sites = support?.unsupported ?? [];
  const unsupported = sites.length > 0 ? unsupportedIssuersText(sites) : null;
  const retry = { label: RETRY_LABEL, onPress: () => void refetch(), testID: 'proof-config-retry' };
  useEffect(() => {
    if (configError !== null) announce(configError);
  }, [configError]);
  return (
    <Screen edges={SCREEN_EDGES} testID="proof-import">
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Card testID="proof-privacy">
        <Text style={styles.statement}>{EMAIL_STAYS_ON_DEVICE}</Text>
        <Text style={styles.body}>{PRIVACY_EXPLANATION}</Text>
      </Card>
      <Text style={styles.body}>{instruction}</Text>
      {config.isPending ? <Text style={styles.muted}>{LOADING_SUPPORT}</Text> : null}
      {configError === null ? null : (
        <Banner tone="error" message={configError} action={retry} testID="proof-config-error" />
      )}
      {issuers === null ? null : <Text style={styles.muted}>{issuers}</Text>}
      {unsupported === null ? null : (
        <Banner {...UNSUPPORTED_BANNER} message={unsupported} testID="proof-unsupported" />
      )}
      <Button {...PICK_TEXT} onPress={chooseEml} busy={busy} testID="proof-import-pick" />
      {intakeError === null ? null : (
        <Banner tone="error" message={intakeError} testID="proof-intake-error" />
      )}
    </Screen>
  );
}

// --- Styles --------------------------------------------------------------------------------------

const styles = StyleSheet.create({
  statement: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted },
});
