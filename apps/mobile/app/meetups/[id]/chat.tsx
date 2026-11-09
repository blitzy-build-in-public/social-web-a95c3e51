/** Pair chat — the meetup's history over REST, its live messages over the app's one chat socket, and
 * the Block and Report actions the chat header offers (AAP 0.5.8, AAP 0.7.1 rows 9 and 12). */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentProps, ReactElement } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import {
  MESSAGE_MAX_CHARS,
  MINUTE_MS,
  colors,
  fontWeights,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { Message, MessageHistoryResponse } from '@tablemate/shared';

import { apiClient } from '../../../src/api/client';
import { isApiError, userMessageFor } from '../../../src/api/errors';
import type { ClientErrorCode } from '../../../src/api/errors';
import {
  getConnectionState,
  isOnline,
  send,
  subscribe,
  subscribeConnectionState,
} from '../../../src/api/ws';
import type { ConnectionState } from '../../../src/api/ws';
import { CHAT_MENU_ANNOUNCEMENT, MESSAGES_EMPTY } from '../../../src/copy/strings';
import { queryClient, queryKeys, useMeetup } from '../../../src/state/meetup-store';
import { useSession } from '../../../src/state/session-store';
import { Avatar, Banner, Button, Screen, TextField, announce } from '../../../src/ui';
type History = InfiniteData<MessageHistoryResponse, string | null>;

const SCREEN_TITLE = 'Chat';
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;
const BEHAVIOR = Platform.OS === 'ios' ? 'padding' : undefined;
const COUNTER_VISIBLE_FROM = 900;
const AVATAR_SIZE = 40;
// A message takes at most this share of the thread: without a cap, a long paragraph's bubble fills
// the whole column and stops reading as its sender's side, and one unbreakable token's bubble grows
// wider than the thread, whose hidden overflow hides most of it. A share scales with the font size.
const BUBBLE_MAX_WIDTH = '80%' as const;
const MORE_HINT = 'Shows block and report options';
const BLOCK_CONFIRM_TEXT =
  "Blocking cancels any open meetup between you. They won't be able to see or message you.";
const CONNECTION_TEXT = {
  idle: 'Offline',
  connecting: 'Reconnecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
} satisfies Record<ConnectionState, string>;
const MORE = { testID: 'user-more', label: 'More', variant: 'secondary' as const };
const REPORT = { testID: 'user-report', label: 'Report', variant: 'secondary' as const };
const BLOCK = { testID: 'user-block', label: 'Block', variant: 'danger' as const };
const CANCEL = { testID: 'user-block-cancel', label: 'Cancel', variant: 'secondary' as const };
const CONFIRM = { testID: 'user-block-confirm', variant: 'danger' as const };
const BACK = { testID: 'chat-back', label: 'Back to meetups', variant: 'secondary' as const };
const FIELD = { multiline: true, returnKeyType: 'send' as const, blurOnSubmit: false } as const;
const closeText = (code: ClientErrorCode | null | undefined): string | undefined =>
  code === null || code === undefined ? undefined : chatErrorMessage(code);

function errorCodeOf(error: unknown): ClientErrorCode | undefined {
  if (error === null || error === undefined) return undefined;
  return isApiError(error) ? error.code : 'invalid_response';
}
export function chatErrorMessage(code: ClientErrorCode): string {
  if (code === 'messaging_locked') return "Chat opens once you've both held your seats.";
  if (code === 'blocked') return "You can't message this traveler.";
  if (code === 'meetup_not_found') return "This meetup isn't available.";
  return userMessageFor(code);
}
export function closesChat(code: ClientErrorCode | null | undefined): boolean {
  return code === 'messaging_locked' || code === 'blocked';
}
function isTransient(code: ClientErrorCode): boolean {
  return code === 'network_error' || code === 'invalid_response' || code === 'service_unavailable';
}
export function senderLabel(
  senderId: string | null,
  viewerId: string | undefined,
  handle: string | undefined,
): string {
  if (senderId === null) return 'Deleted traveler';
  if (viewerId !== undefined && senderId === viewerId) return 'You';
  return handle === undefined || handle === '' ? 'Traveler' : `@${handle}`;
}
export function messagesInPages(pages: readonly MessageHistoryResponse[]): Message[] {
  const first = new Map<string, Message>();
  for (const message of pages.flatMap((page) => page.items)) {
    if (!first.has(message.id)) first.set(message.id, message);
  }
  return [...first.values()];
}

/** The history a pushed message belongs in, unchanged when the id is already there. */
export function withMessage(data: History | undefined, message: Message): History | undefined {
  const newest = data?.pages[0];
  if (data === undefined || newest === undefined) return data;
  if (data.pages.some((page) => page.items.some((item) => item.id === message.id))) return data;
  const pages = [{ ...newest, items: [message, ...newest.items] }, ...data.pages.slice(1)];
  return { ...data, pages };
}
type DateFormat = Intl.DateTimeFormatOptions;
const FORMATS = {
  time: { hour: 'numeric', minute: '2-digit' } satisfies DateFormat,
  day: { year: 'numeric', month: '2-digit', day: '2-digit' } satisfies DateFormat,
  date: { month: 'short', day: 'numeric' } satisfies DateFormat,
};

/** Formats in the venue city's zone, falling back to the device's own; `undefined` is neither. */
function formatInZone(at: Date, zone: string | undefined, format: DateFormat): string | undefined {
  for (const candidate of zone === undefined ? [undefined] : [zone, undefined]) {
    try {
      const options = candidate === undefined ? format : { ...format, timeZone: candidate };
      return new Intl.DateTimeFormat('en', options).format(at);
    } catch {}
  }
  return undefined;
}
export function formatMessageMoment(iso: string, zone: string | undefined, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = formatInZone(at, zone, FORMATS.time);
  if (time === undefined) return iso;
  const day = formatInZone(at, zone, FORMATS.day);
  if (day !== undefined && day === formatInZone(new Date(now), zone, FORMATS.day)) return time;
  const date = formatInZone(at, zone, FORMATS.date);
  return date === undefined ? time : `${date}, ${time}`;
}

type MessageRowProps = { message: Message; label: string; moment: string; mine: boolean };
function MessageRow({ message, label, moment, mine }: MessageRowProps): ReactElement {
  return (
    <View accessible accessibilityLabel={`${label}, ${moment}: ${message.body}`} style={styles.row}>
      <Text style={styles.sender}>{label}</Text>
      <View style={[styles.bubble, mine ? styles.bubbleMine : null]}>
        <Text selectable style={styles.body}>
          {message.body}
        </Text>
      </View>
      <Text style={styles.moment}>{moment}</Text>
    </View>
  );
}
type ComposerProps = ComponentProps<typeof TextField> & { canSend: boolean; onSend: () => void };
function Composer({ canSend, onSend, ...field }: ComposerProps): ReactElement {
  return (
    <View style={styles.composer}>
      <View style={styles.grow}>
        <TextField {...field} />
      </View>
      <Button label="Send" testID="chat-send" disabled={!canSend} onPress={onSend} />
    </View>
  );
}

/** Enter sends on web and Shift+Enter starts a new line; the two extra fields belong to the DOM event. */
function sendOnEnter(onSend: () => void) {
  return (event: NativeSyntheticEvent<TextInputKeyPressEventData>): void => {
    if (Platform.OS !== 'web') return;
    const pressed: Readonly<{ key?: string; shiftKey?: boolean }> = event.nativeEvent;
    if (pressed.key !== 'Enter' || pressed.shiftKey === true) return;
    event.preventDefault();
    onSend();
  };
}
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export default function ChatScreen(): ReactElement {
  const params = useLocalSearchParams<{ id: string }>();
  const meetupId = typeof params.id === 'string' ? params.id : '';
  const session = useSession();
  const meetupQ = useMeetup(meetupId);
  const citiesQ = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: 60 * MINUTE_MS,
  });
  const history = useInfiniteQuery({
    queryKey: queryKeys.messages(meetupId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => apiClient.listMessages(meetupId, pageParam ?? undefined),
    getNextPageParam: (last) => last.nextCursor,
    enabled: session.status === 'signed_in' && meetupId.length > 0,
  });
  const [draft, setDraft] = useState('');
  const [frameError, setFrameError] = useState<ClientErrorCode | null>(null);
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const now = useNow(MINUTE_MS);
  const connection = useSyncExternalStore(
    subscribeConnectionState,
    getConnectionState,
    getConnectionState,
  );
  useEffect(() => {
    if (meetupId === '') return undefined;
    return subscribe((frame) => {
      if (frame.type === 'message') {
        if (frame.message.meetupId !== meetupId) return;
        queryClient.setQueryData(queryKeys.messages(meetupId), (current: History | undefined) =>
          withMessage(current, frame.message),
        );
        return;
      }
      if (frame.type === 'error' && (frame.meetupId === undefined || frame.meetupId === meetupId)) {
        setFrameError(frame.code);
      }
    });
  }, [meetupId]);
  const block = useMutation({
    mutationFn: (targetId: string) => apiClient.blockUser(targetId),
    onSuccess: (_data, targetId): void => {
      queryClient.removeQueries({ queryKey: queryKeys.user(targetId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cities });
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) });
      announce('Traveler blocked.');
      router.replace('/meetups');
    },
  });
  const announced = useRef<string | undefined>(undefined);
  const counterpart = meetupQ.data?.counterpart;
  const venueCityId = meetupQ.data?.venue.cityId;
  const cityZone = citiesQ.data?.items.find((city) => city.id === venueCityId)?.timezone;
  const meetupCode = errorCodeOf(meetupQ.error);
  const refusal = meetupCode ?? errorCodeOf(history.error);
  const failure = errorCodeOf(block.error) ?? frameError ?? refusal;
  const accessClosed = closesChat(refusal) || closesChat(frameError);
  const errorText = sendFailure ?? closeText(failure);
  const unreadable = meetupCode === undefined || isTransient(meetupCode) ? undefined : meetupCode;
  const closedText = meetupId === '' ? "This meetup isn't available." : closeText(unreadable);
  const rows = messagesInPages(history.data?.pages ?? []);
  const body = draft.trim();
  const canSend = body.length > 0 && body.length <= MESSAGE_MAX_CHARS && connection === 'open';
  const hasPhoto =
    counterpart !== undefined && 'hasPhoto' in counterpart && counterpart.hasPhoto === true;
  const retry = () => void Promise.all([meetupQ.refetch(), history.refetch()]);
  const retryable = failure !== null && failure !== undefined && isTransient(failure);
  const retryAction = { label: 'Try again', onPress: retry, testID: 'chat-retry' };
  const retryProp = retryable ? { action: retryAction } : {};
  const composer = {
    ...FIELD,
    label: 'Message',
    value: draft,
    onChangeText: setDraft,
    hint: body.length > COUNTER_VISIBLE_FROM ? `${body.length}/${MESSAGE_MAX_CHARS}` : undefined,
    maxLength: MESSAGE_MAX_CHARS,
    testID: 'chat-input',
    onSubmitEditing: onSend,
    onKeyPress: sendOnEnter(onSend),
  };
  const handle = counterpart?.handle;
  const confirmProps = { ...CONFIRM, label: `Block @${handle}`, busy: block.isPending };
  // A failure is spoken once per distinct sentence, and a recovery clears the sentence.
  useEffect(() => {
    if (announced.current !== errorText && errorText !== undefined) announce(errorText);
    announced.current = errorText;
  }, [errorText]);
  useEffect(() => {
    if (!menuOpen) return;
    announce(CHAT_MENU_ANNOUNCEMENT);
    requestAnimationFrame(() => {
      if (Platform.OS !== 'web') return;
      try {
        document.querySelector<HTMLElement>('[data-testid="user-report"]')?.focus();
      } catch {}
    });
  }, [menuOpen]);
  function onSend(): void {
    if (body === '' || body.length > MESSAGE_MAX_CHARS) return;
    setSendFailure(null);
    // The socket validates the frame with the shared schema; with no open socket the text is kept.
    if (send(meetupId, body)) {
      setDraft('');
      setFrameError(null);
      return;
    }
    // Refused, so nothing was written and nothing is queued: the draft stays in the composer and the
    // sentence says which refusal it was. An offline send is reported rather than buffered, because
    // the socket keeps answering as open while the connection is gone and would drop the frame with
    // the tab — hence the network sentence the product shows everywhere else for that case.
    setSendFailure(
      isOnline() ? 'Not connected. Try again in a moment.' : userMessageFor('network_error'),
    );
  }
  const openReport = (userId: string) =>
    void router.push({ pathname: '/report', params: { userId, meetupId } });
  const loadMore = (): void => {
    if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
  };
  const renderRow = ({ item }: { item: Message }): ReactElement => (
    <MessageRow
      message={item}
      label={senderLabel(item.senderId, session.userId, counterpart?.handle)}
      moment={formatMessageMoment(item.createdAt, cityZone, now)}
      mine={item.senderId !== null && item.senderId === session.userId}
    />
  );
  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen edges={SCREEN_EDGES} scroll={false} testID="chat">
        {closedText !== undefined ? (
          <>
            <Banner tone="error" message={closedText} testID="chat-error" />
            <Button {...BACK} onPress={() => router.replace('/meetups')} />
          </>
        ) : (
          <KeyboardAvoidingView behavior={BEHAVIOR} style={styles.fill}>
            {counterpart === undefined ? null : (
              <View style={styles.identity}>
                <Avatar
                  avatarSeed={counterpart.avatarSeed}
                  handle={counterpart.handle}
                  size={AVATAR_SIZE}
                  {...(hasPhoto ? { userId: counterpart.id, hasPhoto: true } : {})}
                />
                <Text style={styles.handle}>{`@${counterpart.handle}`}</Text>
                <Button {...MORE} hint={MORE_HINT} onPress={() => setMenuOpen((open) => !open)} />
              </View>
            )}
            {menuOpen && counterpart !== undefined ? (
              <View style={styles.menu}>
                <Button {...REPORT} onPress={() => openReport(counterpart.id)} />
                {confirmingBlock ? (
                  <View style={styles.confirm}>
                    <Text style={styles.body}>{BLOCK_CONFIRM_TEXT}</Text>
                    <Button {...confirmProps} onPress={() => block.mutate(counterpart.id)} />
                    <Button {...CANCEL} onPress={() => setConfirmingBlock(false)} />
                  </View>
                ) : (
                  <Button {...BLOCK} onPress={() => setConfirmingBlock(true)} />
                )}
              </View>
            ) : null}
            {errorText === undefined ? null : (
              <Banner tone="error" message={errorText} testID="chat-error" {...retryProp} />
            )}
            {rows.length === 0 ? (
              errorText === undefined ? (
                <Text style={styles.muted}>{history.isPending ? 'Loading…' : MESSAGES_EMPTY}</Text>
              ) : null
            ) : (
              <FlatList
                data={rows}
                inverted
                keyExtractor={(message) => message.id}
                renderItem={renderRow}
                onEndReached={loadMore}
                onEndReachedThreshold={0.5}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                style={styles.fill}
                testID="chat-messages"
              />
            )}
            {counterpart === undefined || accessClosed ? null : (
              <>
                <Text accessibilityLiveRegion="polite" style={styles.connection}>
                  {CONNECTION_TEXT[connection]}
                </Text>
                <Composer {...composer} canSend={canSend} onSend={onSend} />
              </>
            )}
          </KeyboardAvoidingView>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  handle: { flexShrink: 1, ...typography.label, fontWeight: fontWeights.bold, color: colors.text },
  menu: { gap: spacing.sm },
  confirm: { gap: spacing.sm },
  row: { gap: spacing.xs },
  sender: { ...typography.caption, fontWeight: fontWeights.medium, color: colors.textMuted },
  bubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    maxWidth: BUBBLE_MAX_WIDTH,
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
  },
  bubbleMine: { alignSelf: 'flex-end' },
  body: { ...typography.body, color: colors.text },
  moment: { ...typography.caption, color: colors.textMuted },
  muted: { ...typography.body, color: colors.textMuted },
  connection: { ...typography.caption, color: colors.textMuted },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  listContent: { gap: spacing.md, paddingBlock: spacing.sm },
});
