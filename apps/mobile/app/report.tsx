/**
 * The safety screen a traveler's profile or a chat header opens: report a traveler, in free text
 * (AAP 0.5.8, AAP 0.7.1 row 12, AAP 0.8.1).
 *
 * The screen is a modal of the root Stack, so it is presented over whatever route it was opened
 * from and it leaves the traveler on that route again. It carries three states and nothing else:
 * the form, the confirmation, and — when the route names no traveler whose id the API could have
 * issued — a notice with a way back. Reporting does not block anyone: the More menu offers Block
 * separately (`POST /users/:id/block`), and nothing here combines the two.
 *
 * Four invariants hold here structurally. The reported traveler is named only by the route's
 * `userId`, which is validated against the shared id schema before a request is built, so no
 * profile field ever travels through a route parameter; the handle shown beside the field is read
 * from the cache of a profile the traveler just looked at and never fetched for this screen. The
 * request body is `{ reason }` alone — the shared `ReportRequest` is strict, and the only other
 * parameter, `meetupId`, is context for the way back rather than part of the report. The reason is
 * kept while a send fails so it can be retried, and it is never logged, announced or shown anywhere
 * but in the field the traveler typed it into. And every outcome is both painted and spoken: the
 * banner carries the live region on Android and web, and `announce` speaks it on iOS, which has
 * none.
 *
 * The interface is English only (AAP 0.7.2). The sentences here are this screen's own; the fixed
 * strings of AAP 0.5.8 belong to the deposit, safety, lodging and proof screens.
 */
import { useMutation } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { REASON_MAX_CHARS, Uuid, colors, typography } from '@tablemate/shared';
import type { AnyTierProfile, ReportRequest } from '@tablemate/shared';

import { apiClient } from '../src/api/client';
import { isApiError, userMessageFor } from '../src/api/errors';
import { queryClient, queryKeys } from '../src/state/meetup-store';
import { Banner, Button, Screen, TextField, announce } from '../src/ui';

// --- Constants -----------------------------------------------------------------------------------

/**
 * The safe-area edges: the modal's own header insets the top, and a modal sits over the tabs rather
 * than beside a tab bar, so the bottom inset is claimed here.
 */
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;

/** The modal header's title. */
const TITLE = 'Report';

/** The reason field's visible label, which is also its accessible name. */
const REASON_LABEL = 'What happened?';

/** The form's submit control. */
const SEND_LABEL = 'Send report';

/** The confirmation the whole screen turns into once the report is stored (a `204`). */
const SUCCESS_MESSAGE = 'Thanks. Our team will review this report.';

/** The control that leaves the screen after a report was stored. */
const DONE_LABEL = 'Done';

/** The control that leaves the screen when the route named no traveler to report. */
const BACK_LABEL = 'Back';

/**
 * The notice a route that names no reportable traveler shows: the app's own sentence for
 * `user_not_found`, which is what the API answers for an unknown, deleted or blocked traveler, so
 * a mistyped link reads the same as a profile that is no longer there.
 */
const NO_TARGET_MESSAGE = userMessageFor('user_not_found');

/** Reason the guarded mutation rejects with; unreachable from the UI, and never shown as itself. */
const NO_TARGET = 'no_report_target';

// --- Pure helpers --------------------------------------------------------------------------------

/**
 * The single value a route parameter carries, or `undefined` for one that is absent or repeated.
 *
 * Expo Router's hook types a parameter as a string but hands a repeated query parameter on as an
 * array, so the value is narrowed before it is used as an id.
 */
export function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The traveler this screen reports: the route's `userId` when it is an id the API issues — the
 * shared `Uuid` schema is the same one the API's own `:userId` parameter is validated with — and
 * `null` otherwise, which is the state that shows the notice instead of the form.
 */
export function reportTarget(userId: string | string[] | undefined): string | null {
  const candidate = singleParam(userId);
  return candidate !== undefined && Uuid.safeParse(candidate).success ? candidate : null;
}

/**
 * The client's own code for a failed report. An error that is not an `ApiError` never came from the
 * API's envelope, so it reads as the answer this client refused.
 */
export function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'invalid_response';
}

/** Where leaving the screen goes: one step back, or a route to replace the current one with. */
export type Exit = { readonly kind: 'back' } | { readonly kind: 'replace'; readonly path: string };

/**
 * The exit the Done and Back controls take.
 *
 * A screen opened from a profile or a chat header has history, and going back one step returns the
 * traveler to whichever of the two it was. A deep link has none: the meetup the report was made
 * about is then the closest route to where the traveler came from, and without one — or with a
 * value that is not an id — Discover, which every session may open (AAP 0.5.8).
 */
export function exitFrom(canGoBack: boolean, meetupId: string | string[] | undefined): Exit {
  if (canGoBack) return { kind: 'back' };

  const meetup = singleParam(meetupId);
  if (meetup !== undefined && Uuid.safeParse(meetup).success) {
    return { kind: 'replace', path: `/meetups/${meetup}/chat` };
  }
  return { kind: 'replace', path: '/discover' };
}

/**
 * How much room is left in the reason, as the field's hint.
 *
 * The cap the API enforces is the only thing that stops a reason being typed, so the remaining
 * count is stated as text rather than as a colour or a counter that has to be compared (WCAG
 * 1.4.1). `maxLength` keeps the count at or above zero.
 */
export function remainingCharsText(reason: string): string {
  const remaining = REASON_MAX_CHARS - reason.length;
  return remaining === 1 ? '1 character left' : `${remaining} characters left`;
}

/**
 * The reported traveler's handle, when their profile is already cached, or `null`.
 *
 * The More menu opens this screen from a profile the traveler has just read, so the profile is
 * usually in the cache already: reading it there names the target without a second `GET /users/:id`
 * and without a profile field ever travelling through a route parameter (AAP 0.5.4). Nothing is
 * fetched for this line, and both a missing cache entry and a failed read render no handle.
 */
function cachedHandle(userId: string): string | null {
  const profile = queryClient.getQueryData<AnyTierProfile>(queryKeys.user(userId));
  return profile === undefined ? null : profile.handle;
}

// --- Screen --------------------------------------------------------------------------------------

/**
 * The report screen.
 *
 * @returns The form with its send control, the confirmation a stored report turns into, or the
 * notice a route without a reportable traveler shows.
 */
export default function ReportScreen(): ReactElement {
  const params = useLocalSearchParams<{ userId?: string; meetupId?: string }>();
  const router = useRouter();
  const [reason, setReason] = useState('');

  const targetId = reportTarget(params.userId);
  const meetupId = singleParam(params.meetupId);

  const submit = useMutation({
    // The form renders only for a target that passed validation, so this guard is unreachable from
    // this screen; it is what keeps a request from ever naming a traveler the route did not
    // identify. The body is built from the typed reason alone: `ReportRequest` is strict, and
    // `meetupId` is context for the way back rather than part of a report.
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

  const sendMessage = submit.isError ? userMessageFor(errorCodeOf(submit.error)) : null;
  const notice = targetId === null ? NO_TARGET_MESSAGE : sendMessage;
  const succeeded = submit.isSuccess;
  const trimmed = reason.trim();

  // iOS has no live region in React Native, so both outcomes are spoken as well as painted
  // (AAP 0.5.8). `announce` drops an immediate repeat and returns early on web, where the banner's
  // own region speaks the notice once.
  useEffect(() => {
    if (notice !== null) announce(notice);
    else if (succeeded) announce(SUCCESS_MESSAGE);
  }, [notice, succeeded]);

  const handle = targetId === null ? null : cachedHandle(targetId);

  let content: ReactElement;
  if (targetId === null) {
    content = (
      <Banner
        tone="error"
        message={NO_TARGET_MESSAGE}
        action={{ label: BACK_LABEL, onPress: exit, testID: 'report-back' }}
        testID="report-error"
      />
    );
  } else if (succeeded) {
    content = (
      <>
        <Banner tone="success" message={SUCCESS_MESSAGE} testID="report-success" />
        <Button label={DONE_LABEL} onPress={exit} testID="report-done" />
      </>
    );
  } else {
    content = (
      <>
        {handle === null ? null : <Text style={styles.target}>{`Report @${handle}`}</Text>}
        {sendMessage === null ? null : (
          <Banner tone="error" message={sendMessage} testID="report-error" />
        )}
        <TextField
          label={REASON_LABEL}
          value={reason}
          onChangeText={setReason}
          multiline
          maxLength={REASON_MAX_CHARS}
          hint={remainingCharsText(reason)}
          testID="report-reason"
        />
        <Button
          label={SEND_LABEL}
          onPress={() => {
            submit.mutate({ reason: trimmed });
          }}
          disabled={trimmed === ''}
          busy={submit.isPending}
          testID="report-submit"
        />
      </>
    );
  }

  return (
    <Screen edges={SCREEN_EDGES} testID="report">
      <Stack.Screen options={{ title: TITLE }} />
      {content}
    </Screen>
  );
}

const styles = StyleSheet.create({
  target: {
    ...typography.body,
    color: colors.textMuted,
  },
});
