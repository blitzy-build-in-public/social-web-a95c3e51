/**
 * Pair chat — the meetup's history over REST, its live messages over the app's one chat socket, and
 * the Block and Report actions the chat header offers (AAP 0.5.8, AAP 0.7.1 rows 9 and 12).
 *
 * Nothing here decides who may chat: `GET /meetups/:id/messages` and the socket answer `403
 * messaging_locked` until both deposits are held, and `403 blocked` when a block exists in either
 * direction (AAP 0.5.4). The first renders as the locked state, with no composer and no retry.
 *
 * Three invariants hold structurally. History is the server's: the pages arrive newest first, a
 * live frame is merged by id only when that id is absent, and nothing is inserted optimistically —
 * the API echoes every accepted message to both participants, and that echo is what this client
 * renders. Every time is the venue city's, because the meeting is at the venue. And nothing logs: a
 * failure arrives as a code, is shown in the app's own sentence for it, and no message body reaches
 * a log, an announcement or a crash report (AAP 0.11.1).
 *
 * The row, the composer and the More menu live in this file because every file under
 * `app/meetups/[id]/` is a route of its own (AAP 0.8.1): none of it can move to a sibling route, so
 * the two access states, the connection line and the Block flow put this file above the ≈300-line
 * guide for a route of its scope. Client-safe: `react`, `react-native`, `expo-router`,
 * `@tanstack/react-query`, `@tablemate/shared` and the app's own modules, with no Node built-in and
 * no effect at module load.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
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
import { getConnectionState, send, subscribe, subscribeConnectionState } from '../../../src/api/ws';
import type { ConnectionState } from '../../../src/api/ws';
import { MESSAGES_EMPTY } from '../../../src/copy/strings';
import { queryClient, queryKeys, useMeetup } from '../../../src/state/meetup-store';
import { useSession } from '../../../src/state/session-store';
import { Avatar, Banner, Button, Screen, TextField, announce } from '../../../src/ui';

/** The navigator header's title and the page heading (AAP 0.5.8: Meetups → meetup → Chat). */
const SCREEN_TITLE = 'Chat';

/** The header owns the top inset; a route pushed above the tabs owns the bottom one. */
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;

/** The city list changes only when the pilot adds a city, so one answer an hour serves the zone. */
const CITIES_STALE_TIME_MS = 60 * MINUTE_MS;

/** How often the device clock is re-read, so a message stops reading as today's after midnight. */
const CLOCK_TICK_MS = MINUTE_MS;

/** The count appears from here, before the contract's own limit is reached (AAP 0.5.2). */
const COUNTER_VISIBLE_FROM = 900;

/** The counterpart avatar's side in points on native and CSS px on web. */
const AVATAR_SIZE = 40;

/** The labels this screen places; none of them carries a rule's own number. */
const MESSAGE_LABEL = 'Message';
const SEND_LABEL = 'Send';
const MORE_LABEL = 'More';
const MORE_HINT = 'Shows block and report options';
const REPORT_LABEL = 'Report';
const BLOCK_LABEL = 'Block';
const CANCEL_LABEL = 'Cancel';
const TRY_AGAIN_LABEL = 'Try again';
const BACK_TO_MEETUPS_LABEL = 'Back to meetups';

/** What a sender reads as. A deleted writer keeps the peer's copy of the message (AAP 0.5.2). */
const YOU_LABEL = 'You';
const DELETED_LABEL = 'Deleted traveler';
const TRAVELER_LABEL = 'Traveler';

/** The socket's state in words, so a traveller waiting on a dropped connection is told (AAP 0.3.3). */
const CONNECTION_TEXT = {
  idle: 'Offline',
  connecting: 'Reconnecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
} satisfies Record<ConnectionState, string>;

/** Shown while the history has not answered yet. */
const LOADING = 'Loading…';

/** The three access refusals, and the send that found no open socket (AAP 0.5.4, AAP 0.5.8). */
const MESSAGING_LOCKED = "Chat opens once you've both held your seats.";
const BLOCKED_MESSAGE = "You can't message this traveler.";
const MEETUP_UNAVAILABLE = "This meetup isn't available.";
const NOT_CONNECTED = 'Not connected. Try again in a moment.';

/** The block confirmation, and what is announced once the block is stored (AAP 0.5.3, 0.7.2). */
const BLOCK_CONFIRM_TEXT =
  "Blocking cancels any open meetup between you. They won't be able to see or message you.";
const BLOCKED_NOTICE = 'Traveler blocked.';

/**
 * Spoken when the More menu opens: the button primitive exposes no expanded state, so this is what
 * tells a screen reader the menu is there (AAP 0.5.8).
 */
const MENU_OPEN_NOTICE = 'More options: report or block.';

// --- Pure helpers -------------------------------------------------------------------------------

/** The code of a failed request, or `undefined` when nothing has failed. */
function errorCodeOf(error: unknown): ClientErrorCode | undefined {
  if (error === null || error === undefined) return undefined;
  // Anything that is not this client's own error never came from the API's envelope.
  return isApiError(error) ? error.code : 'invalid_response';
}

/** The sentence a chat failure shows; the three access codes word themselves (AAP 0.5.4, 0.5.8). */
export function chatErrorMessage(code: ClientErrorCode): string {
  if (code === 'messaging_locked') return MESSAGING_LOCKED;
  if (code === 'blocked') return BLOCKED_MESSAGE;
  if (code === 'meetup_not_found') return MEETUP_UNAVAILABLE;
  return userMessageFor(code);
}

/** True for the two refusals that close the chat itself: no locked pair, or a block (AAP 0.5.4). */
export function closesChat(code: ClientErrorCode | null | undefined): boolean {
  return code === 'messaging_locked' || code === 'blocked';
}

/** True for a failure a retry could change, which is the only kind this screen offers a retry for. */
function isTransient(code: ClientErrorCode): boolean {
  return code === 'network_error' || code === 'invalid_response' || code === 'service_unavailable';
}

/**
 * The name a message's sender reads as. A `null` sender is a message whose writer erased their
 * account — erasure deletes what the erased traveller wrote and leaves the counterpart's copy, so a
 * retained message has no live sender (AAP 0.5.2).
 */
export function senderLabel(
  senderId: string | null,
  viewerId: string | undefined,
  handle: string | undefined,
): string {
  if (senderId === null) return DELETED_LABEL;
  if (viewerId !== undefined && senderId === viewerId) return YOU_LABEL;
  return handle === undefined || handle === '' ? TRAVELER_LABEL : `@${handle}`;
}

/**
 * The paged history as the one newest-first list the inverted list renders, keeping the first
 * occurrence of a repeated id. Page order is already newest-first, so the dedupe is what keeps the
 * socket's echo and the refetch it triggers from showing one message twice (AAP 0.5.4).
 */
export function messagesInPages(pages: readonly MessageHistoryResponse[]): Message[] {
  const seen = new Set<string>();
  const ordered: Message[] = [];
  for (const page of pages) {
    for (const message of page.items) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      ordered.push(message);
    }
  }
  return ordered;
}

/**
 * The history a pushed message belongs in: the newest page with that message at its head, or the
 * history unchanged when the id is already there, which makes the merge idempotent.
 */
export function withMessage(
  data: InfiniteData<MessageHistoryResponse, string | null> | undefined,
  message: Message,
): InfiniteData<MessageHistoryResponse, string | null> | undefined {
  const newest = data?.pages[0];
  if (data === undefined || newest === undefined) return data;
  if (data.pages.some((page) => page.items.some((item) => item.id === message.id))) return data;
  const pages = [{ ...newest, items: [message, ...newest.items] }, ...data.pages.slice(1)];
  return { ...data, pages };
}

/** How a city-local moment, day and date are printed (AAP 0.5.8). */
const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};
const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

/**
 * Formats an instant in the venue city's zone, falling back to the device's own: a zone this runtime
 * does not carry then costs the city's time and never the row (AAP 0.5.8). The city's zone is tried
 * first because a device set to another zone must not date a message the venue and the other
 * traveller do not keep; `undefined` means neither zone could be formatted in.
 */
function formatInZone(
  at: Date,
  timeZone: string | undefined,
  format: Intl.DateTimeFormatOptions,
): string | undefined {
  const zones = timeZone === undefined ? [undefined] : [timeZone, undefined];
  for (const zone of zones) {
    try {
      const options = zone === undefined ? format : { ...format, timeZone: zone };
      return new Intl.DateTimeFormat('en', options).format(at);
    } catch {
      // An unknown zone: the next one, then nothing.
    }
  }
  return undefined;
}

/**
 * A message's moment: the time alone for a message sent today in the venue's zone, and the date with
 * it for an older one (AAP 0.5.8). An unformattable value is returned as it arrived.
 */
export function formatMessageMoment(
  iso: string,
  timeZone: string | undefined,
  now: number,
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;

  const time = formatInZone(at, timeZone, TIME_FORMAT);
  if (time === undefined) return iso;

  const day = formatInZone(at, timeZone, DAY_FORMAT);
  if (day !== undefined && day === formatInZone(new Date(now), timeZone, DAY_FORMAT)) return time;

  const date = formatInZone(at, timeZone, DATE_FORMAT);
  return date === undefined ? time : `${date}, ${time}`;
}

// --- In-file pieces -----------------------------------------------------------------------------

/** What a row needs, all of it already resolved by the screen. */
interface MessageRowProps {
  readonly message: Message;
  /** The sender's name: `You`, a deleted writer, or the counterpart's handle. */
  readonly label: string;
  /** The moment, already formatted in the venue city's zone. */
  readonly moment: string;
  /** Whether the viewer wrote it, which places the bubble on the reading-end side. */
  readonly mine: boolean;
}

/**
 * One message: who wrote it, what it says and when. The three lines are grouped into one element
 * named after all of them, so a screen reader reads a message once, and the body stays selectable.
 */
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

/** What the composer needs from the screen, which owns the draft and the socket. */
interface ComposerProps {
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly onSend: () => void;
  /** False while the draft is empty and while the socket is not open; it disables Send. */
  readonly canSend: boolean;
  /** The character count, shown only near the contract's limit; omitted below it. */
  readonly hint: string | undefined;
}

/**
 * The composer: a labelled multi-line field, the count once the draft nears the limit, and Send.
 *
 * The label is the field's accessible name, the count is visible text rather than colour alone, and
 * Send is a button whose disabled state is announced (AAP 0.5.8). Enter sends on web and Shift+Enter
 * starts a new line; off web the return key starts a new line and Send is the way to send, which
 * keeps a multi-line message typeable on a device keyboard.
 */
function Composer({ value, onChangeText, onSend, canSend, hint }: ComposerProps): ReactElement {
  return (
    <View style={styles.composer}>
      <View style={styles.grow}>
        <TextField
          label={MESSAGE_LABEL}
          value={value}
          onChangeText={onChangeText}
          hint={hint}
          multiline
          maxLength={MESSAGE_MAX_CHARS}
          returnKeyType="send"
          // Keeping the field focused after a send lets the next line be written without a second
          // tap; the field's own submit path and the web key handler both reach `onSend`.
          blurOnSubmit={false}
          testID="chat-input"
          onSubmitEditing={onSend}
          onKeyPress={sendOnEnter(onSend)}
        />
      </View>
      <Button label={SEND_LABEL} testID="chat-send" disabled={!canSend} onPress={onSend} />
    </View>
  );
}

/**
 * The web keyboard shortcut: Enter sends, Shift+Enter starts a new line (AAP 0.5.8).
 *
 * `onKeyPress` fires before react-native-web's own Enter handling, and preventing the default is
 * what stops that handling inserting the newline it inserts for a multi-line field. The two extra
 * fields belong to the DOM event, which React Native's key-event type does not declare.
 */
function sendOnEnter(
  onSend: () => void,
): (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void {
  return (event) => {
    if (Platform.OS !== 'web') return;
    const pressed: Readonly<{ key?: string; shiftKey?: boolean }> = event.nativeEvent;
    if (pressed.key !== 'Enter' || pressed.shiftKey === true) return;
    event.preventDefault();
    onSend();
  };
}

/**
 * Moves keyboard focus to the menu's first control once the menu opens.
 *
 * The controls are UI primitives and take no ref, so on web the control is found by the `data-testid`
 * react-native-web renders. Off web there is nothing to focus — the opening is announced instead —
 * and a document-less render (the web export's static pass) focuses nothing rather than throwing.
 */
function focusMenuItem(): void {
  if (Platform.OS !== 'web') return;
  try {
    document.querySelector<HTMLElement>('[data-testid="user-report"]')?.focus();
  } catch {
    // No document to focus in: nothing to do.
  }
}

/**
 * Re-reads the device clock on an interval, so a message stops reading as today's once the venue's
 * own day turns over. The timer is cleared with the screen.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// --- Screen -------------------------------------------------------------------------------------

/**
 * The chat screen for the route's meetup.
 *
 * The meetup read supplies the counterpart and the venue, which the city list turns into the zone
 * every moment is shown in. A live `message` frame is merged into the history by id and an `error`
 * frame becomes the screen's error, while `src/state/meetup-store.ts` invalidates the same history
 * on every message frame, which the merge makes idempotent.
 *
 * @returns The pair's chat, with the Block and Report menu, the composer and the access states.
 */
export default function ChatScreen(): ReactElement {
  const params = useLocalSearchParams<{ id: string }>();
  const meetupId = typeof params.id === 'string' ? params.id : '';
  const session = useSession();

  const meetupQ = useMeetup(meetupId);
  // A public read that changes only when the pilot adds a city, so one answer an hour serves the
  // venue's timezone; its failure costs the city-local times and nothing else.
  const citiesQ = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: CITIES_STALE_TIME_MS,
  });

  const history = useInfiniteQuery({
    queryKey: queryKeys.messages(meetupId),
    // React Query 5 needs an explicit first page parameter, and the API's first page is the one read
    // without a cursor; `nextCursor` is then `null` on the last page.
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => apiClient.listMessages(meetupId, pageParam ?? undefined),
    getNextPageParam: (last) => last.nextCursor,
    enabled: session.status === 'signed_in' && meetupId.length > 0,
  });

  const [draft, setDraft] = useState('');
  const [frameError, setFrameError] = useState<ClientErrorCode | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);

  const now = useNow(CLOCK_TICK_MS);
  const connection = useSyncExternalStore(
    subscribeConnectionState,
    getConnectionState,
    getConnectionState,
  );

  // The frames the one socket pushes: a stored message for this pair, or a refusal. The merge is
  // what turns the echo of a message this client sent into the message it renders (AAP 0.5.4).
  useEffect(() => {
    if (meetupId === '') return undefined;
    return subscribe((frame) => {
      if (frame.type === 'message') {
        if (frame.message.meetupId !== meetupId) return;
        queryClient.setQueryData(
          queryKeys.messages(meetupId),
          (current: InfiniteData<MessageHistoryResponse, string | null> | undefined) =>
            withMessage(current, frame.message),
        );
        return;
      }
      // A refusal for this meetup, or one that names none at all: both belong on this screen.
      if (frame.type === 'error' && (frame.meetupId === undefined || frame.meetupId === meetupId)) {
        setFrameError(frame.code);
      }
    });
  }, [meetupId]);

  const block = useMutation({
    mutationFn: (targetId: string) => apiClient.blockUser(targetId),
    onSuccess: (_data, targetId): void => {
      // A block cancels any open meetup between the pair (AAP 0.5.3), so the profile — which answers
      // `404` from now on, and is therefore dropped rather than refetched — the city lists behind
      // discovery, the meetup lists and this meetup with its messages are all read again.
      queryClient.removeQueries({ queryKey: queryKeys.user(targetId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cities });
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) });
      announce(BLOCKED_NOTICE);
      router.replace('/meetups');
    },
  });

  // A failure is spoken once per distinct sentence: a re-render over the same failed answer would
  // otherwise repeat it, and a recovery clears the sentence so a later failure speaks again.
  const announced = useRef<string | undefined>(undefined);

  const counterpart = meetupQ.data?.counterpart;
  const cityZone = citiesQ.data?.items.find(
    (city) => city.id === meetupQ.data?.venue.cityId,
  )?.timezone;

  const meetupCode = errorCodeOf(meetupQ.error);
  const refusal = meetupCode ?? errorCodeOf(history.error);
  const failure = errorCodeOf(block.error) ?? frameError ?? refusal;
  const accessClosed = closesChat(refusal) || closesChat(frameError);
  const errorText = sendFailed
    ? NOT_CONNECTED
    : failure === null || failure === undefined
      ? undefined
      : chatErrorMessage(failure);
  // A meetup that cannot be read at all closes the screen: an unknown id, someone else's meetup, or
  // a refusal no retry can change. A request that never arrived is retried in place instead.
  const unreadable = meetupCode === undefined || isTransient(meetupCode) ? undefined : meetupCode;
  const closedText =
    meetupId === ''
      ? MEETUP_UNAVAILABLE
      : unreadable === undefined
        ? undefined
        : chatErrorMessage(unreadable);
  const rows = messagesInPages(history.data?.pages ?? []);
  const body = draft.trim();
  const canSend = body.length > 0 && body.length <= MESSAGE_MAX_CHARS && connection === 'open';
  const counter =
    body.length > COUNTER_VISIBLE_FROM ? `${body.length}/${MESSAGE_MAX_CHARS}` : undefined;
  const hasPhoto =
    counterpart !== undefined && 'hasPhoto' in counterpart && counterpart.hasPhoto === true;

  useEffect(() => {
    if (errorText === undefined) {
      announced.current = undefined;
      return;
    }
    if (announced.current === errorText) return;
    announced.current = errorText;
    announce(errorText);
  }, [errorText]);

  // Opening the menu is a state change of its own, so it is announced and, on web, focused into.
  useEffect(() => {
    if (!menuOpen) return;
    announce(MENU_OPEN_NOTICE);
    requestAnimationFrame(focusMenuItem);
  }, [menuOpen]);

  function retry(): void {
    // One tap asks both reads again: a meetup that failed while the socket was down and a history
    // that failed come back together, so the screen is never half-recovered.
    void meetupQ.refetch();
    void history.refetch();
  }

  function onSend(): void {
    if (body === '' || body.length > MESSAGE_MAX_CHARS) return;
    setSendFailed(false);
    // The socket validates the frame with the shared schema, so what left was checked. There is no
    // offline queue: a send that found no open socket keeps the text for another attempt.
    if (send(meetupId, body)) {
      setDraft('');
      setFrameError(null);
      return;
    }
    setSendFailed(true);
  }

  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen edges={SCREEN_EDGES} title={SCREEN_TITLE} scroll={false} testID="chat">
        {closedText !== undefined ? (
          <>
            <Banner tone="error" message={closedText} testID="chat-error" />
            <Button
              variant="secondary"
              label={BACK_TO_MEETUPS_LABEL}
              testID="chat-back"
              onPress={() => router.replace('/meetups')}
            />
          </>
        ) : (
          // The list scrolls itself, so this screen does not; the keyboard is claimed here rather
          // than by the screen, and off iOS the window is already resized for it.
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.fill}
          >
            {counterpart === undefined ? null : (
              <View style={styles.identity}>
                <Avatar
                  avatarSeed={counterpart.avatarSeed}
                  handle={counterpart.handle}
                  size={AVATAR_SIZE}
                  {...(hasPhoto ? { userId: counterpart.id, hasPhoto: true } : {})}
                />
                <Text style={styles.handle}>{`@${counterpart.handle}`}</Text>
                <Button
                  testID="user-more"
                  label={MORE_LABEL}
                  variant="secondary"
                  hint={MORE_HINT}
                  onPress={() => setMenuOpen((open) => !open)}
                />
              </View>
            )}

            {menuOpen && counterpart !== undefined ? (
              <View style={styles.menu}>
                <Button
                  testID="user-report"
                  label={REPORT_LABEL}
                  variant="secondary"
                  onPress={() =>
                    router.push({
                      pathname: '/report',
                      params: { userId: counterpart.id, meetupId },
                    })
                  }
                />
                {/* The confirmation replaces the Block control rather than sitting beside it, so
                    one element carries `user-block` at a time and a flow taps it twice. */}
                {confirmingBlock ? (
                  <View style={styles.confirm}>
                    <Text style={styles.body}>{BLOCK_CONFIRM_TEXT}</Text>
                    <Button
                      testID="user-block-confirm"
                      label={`${BLOCK_LABEL} @${counterpart.handle}`}
                      variant="danger"
                      busy={block.isPending}
                      onPress={() => block.mutate(counterpart.id)}
                    />
                    <Button
                      testID="user-block-cancel"
                      label={CANCEL_LABEL}
                      variant="secondary"
                      onPress={() => setConfirmingBlock(false)}
                    />
                  </View>
                ) : (
                  <Button
                    testID="user-block"
                    label={BLOCK_LABEL}
                    variant="danger"
                    onPress={() => setConfirmingBlock(true)}
                  />
                )}
              </View>
            ) : null}

            {errorText === undefined ? null : (
              <Banner
                tone="error"
                message={errorText}
                testID="chat-error"
                {...(failure !== null && failure !== undefined && isTransient(failure)
                  ? { action: { label: TRY_AGAIN_LABEL, onPress: retry, testID: 'chat-retry' } }
                  : {})}
              />
            )}

            {rows.length === 0 ? (
              // The empty state stands outside the inverted list, where it is not drawn upside down,
              // and never contradicts an access notice that is already on screen.
              errorText === undefined ? (
                <Text style={styles.muted}>{history.isPending ? LOADING : MESSAGES_EMPTY}</Text>
              ) : null
            ) : (
              <FlatList
                data={rows}
                // The newest message sits at the bottom, which is where a chat is read from, so the
                // list is inverted and the older pages are fetched as the reader scrolls up.
                inverted
                keyExtractor={(message) => message.id}
                renderItem={({ item }) => (
                  <MessageRow
                    message={item}
                    label={senderLabel(item.senderId, session.userId, counterpart?.handle)}
                    moment={formatMessageMoment(item.createdAt, cityZone, now)}
                    mine={item.senderId !== null && item.senderId === session.userId}
                  />
                )}
                onEndReached={() => {
                  if (history.hasNextPage && !history.isFetchingNextPage) {
                    void history.fetchNextPage();
                  }
                }}
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
                <Composer
                  value={draft}
                  onChangeText={setDraft}
                  onSend={onSend}
                  canSend={canSend}
                  hint={counter}
                />
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
  // Both text colours are pairs the token module records over `surface`: `text` at 15.52:1 and
  // `textMuted` at 6.38:1, so a sender, a moment and a bubble all clear AA (AAP 0.5.8).
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  handle: { flexShrink: 1, ...typography.label, fontWeight: fontWeights.bold, color: colors.text },
  menu: { gap: spacing.sm },
  confirm: { gap: spacing.sm },
  row: { gap: spacing.xs },
  sender: { ...typography.caption, fontWeight: fontWeights.medium, color: colors.textMuted },
  bubble: {
    // The bubble hugs its text: the viewer's messages sit on the reading-end side, the other
    // traveller's on the reading-start one, and padding comes from the token scale.
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
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
