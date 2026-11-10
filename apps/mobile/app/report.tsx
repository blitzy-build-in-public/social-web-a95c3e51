/** The safety screen a traveler's profile or a chat header opens: report a traveler in free text, with the profile's handle read from the cache it is already in. */
import { useMutation } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { REASON_MAX_CHARS, Uuid, colors, typography } from '@tablemate/shared';
import type { AnyTierProfile, ReportRequest } from '@tablemate/shared';

import { apiClient } from '../src/api/client';
import { isApiError, userMessageFor } from '../src/api/errors';
import { REASON_FIELD_LABEL, remainingCharsText } from '../src/copy/strings';
import { queryClient, queryKeys } from '../src/state/meetup-store';
import { Banner, Button, Screen, TextField, announce } from '../src/ui';

const NO_TARGET_MESSAGE = userMessageFor('user_not_found');
const NO_TARGET = 'no_report_target';
const SUCCESS_MESSAGE = 'Thanks. Our team will review this report.';
const SEND_PROPS = { label: 'Send report', testID: 'report-submit' } as const;
const REASON_FIELD = { multiline: true, maxLength: REASON_MAX_CHARS } as const;

export const singleParam = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function reportTarget(userId: string | string[] | undefined): string | null {
  const candidate = singleParam(userId);
  return candidate !== undefined && Uuid.safeParse(candidate).success ? candidate : null;
}
export const errorCodeOf = (error: unknown): string =>
  isApiError(error) ? error.code : 'invalid_response';
export type Exit = { readonly kind: 'back' } | { readonly kind: 'replace'; readonly path: string };

export function exitFrom(canGoBack: boolean, meetupId: string | string[] | undefined): Exit {
  if (canGoBack) return { kind: 'back' };
  const meetup = singleParam(meetupId);
  if (meetup !== undefined && Uuid.safeParse(meetup).success)
    return { kind: 'replace', path: `/meetups/${meetup}/chat` };
  return { kind: 'replace', path: '/discover' };
}

const cachedHandle = (userId: string): string | null =>
  queryClient.getQueryData<AnyTierProfile>(queryKeys.user(userId))?.handle ?? null;

export default function ReportScreen(): ReactElement {
  const params = useLocalSearchParams<{ userId?: string; meetupId?: string }>();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const targetId = reportTarget(params.userId);
  const meetupId = singleParam(params.meetupId);
  // The chat header opens the screen with the meetup the report is filed from and the profile opens it
  // with none, so only an id the shared schema accepts becomes the body's context (AAP 0.5.8).
  const meetupContext =
    meetupId !== undefined && Uuid.safeParse(meetupId).success ? meetupId : undefined;
  const submit = useMutation({
    mutationFn: (body: ReportRequest): Promise<void> =>
      targetId === null
        ? Promise.reject(new Error(NO_TARGET))
        : apiClient.reportUser(targetId, body),
  });
  const exit = useCallback((): void => {
    const target = exitFrom(router.canGoBack(), meetupId);
    if (target.kind === 'back') router.back();
    else router.replace(target.path);
  }, [meetupId, router]);
  const failure = submit.isError ? userMessageFor(errorCodeOf(submit.error)) : null;
  const trimmed = reason.trim();
  const send = (): void =>
    submit.mutate({
      reason: trimmed,
      ...(meetupContext === undefined ? {} : { meetupId: meetupContext }),
    });
  useEffect(() => {
    if (targetId === null) announce(NO_TARGET_MESSAGE);
    else if (failure !== null) announce(failure);
    else if (submit.isSuccess) announce(SUCCESS_MESSAGE);
  }, [failure, submit.isSuccess, targetId]);
  const handle = targetId === null ? null : cachedHandle(targetId);
  const backAction = { label: 'Back', onPress: exit, testID: 'report-back' };
  const content =
    targetId === null ? (
      <Banner tone="error" message={NO_TARGET_MESSAGE} action={backAction} testID="report-error" />
    ) : submit.isSuccess ? (
      <>
        <Banner tone="success" message={SUCCESS_MESSAGE} testID="report-success" />
        <Button label="Done" onPress={exit} testID="report-done" />
      </>
    ) : (
      <>
        {handle === null ? null : <Text style={styles.target}>{`Report @${handle}`}</Text>}
        {failure ? <Banner tone="error" message={failure} testID="report-error" /> : null}
        <TextField
          label={REASON_FIELD_LABEL}
          value={reason}
          onChangeText={setReason}
          hint={remainingCharsText(reason, REASON_MAX_CHARS)}
          {...REASON_FIELD}
          testID="report-reason"
        />
        <Button {...SEND_PROPS} onPress={send} disabled={trimmed === ''} busy={submit.isPending} />
      </>
    );
  return (
    <Screen edges={['left', 'right', 'bottom']} testID="report">
      <Stack.Screen options={{ title: 'Report' }} />
      {content}
    </Screen>
  );
}

const styles = StyleSheet.create({ target: { ...typography.body, color: colors.textMuted } });
