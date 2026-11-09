/**
 * The client's server-state layer: one React Query client, the query keys every screen shares, the
 * meetup reads, and the binding that turns chat-socket frames into refetches (AAP 0.3.3, AAP 0.5.4,
 * AAP 0.8.1).
 *
 * The cache stores server answers as they arrived and never filters one, because disclosure is
 * enforced at field level by the API: a field above the viewer's tier was already dropped by the
 * response schema that parsed it (AAP 0.5.4, criterion 5). Nothing is persisted, so no profile
 * field, message body or proof date reaches disk (AAP 0.5.2), and `src/auth/session.ts` clears this
 * client when a session ends. Only a request that never reached the API is retried, and no write
 * ever is, because repeating a hold or a check-in POST is not the client's decision: the two answers
 * that mean "try again shortly", `503 payment_unavailable` and `409 hold_pending`, are recovered by
 * polling the meetup reads (AAP 0.3.2, AAP 0.5.4). The dependency runs one way — `src/auth` imports
 * this folder, so importing `src/auth` here would close a cycle (AAP 0.5.1) — and nothing here logs,
 * a frame's message body included (AAP 0.11.1).
 *
 * Client-safe: `@tanstack/react-query`, `@tablemate/shared` and the modules above, with no Node
 * built-in, no DOM global and one inert `QueryClient` as its only top-level effect.
 */
import { QueryClient, onlineManager, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { isFinalMeetupStatus } from '@tablemate/shared';
import type {
  LodgingSort,
  MeetupDto,
  MeetupListQuery,
  MeetupListResponse,
  MeetupStatus,
  MetricsQuery,
  ParticipantRole,
  ServerFrame,
} from '@tablemate/shared';

import { apiClient } from '../api/client';
import { isNetworkError } from '../api/errors';
import { subscribe } from '../api/ws';
import { useSession } from './session-store';

/** How long a cached answer stays fresh, in milliseconds (AAP 0.8.1). */
const STALE_TIME_MS = 30_000;

/** How many times a request that never reached the API is retried before the query fails. */
const NETWORK_RETRIES = 3;

/**
 * The one client for the whole app, built at module load and inert until something mounts it.
 *
 * `networkMode: 'always'` is why an attempt made with no connection fails here instead of never
 * starting. React Query's default, `'online'`, refuses to call the request function at all while
 * `onlineManager` reports the runtime offline, which leaves a query pending for ever — a screen
 * stuck on its spinner with no error to report and no retry to offer — and a mutation paused before
 * its function runs, which leaves a control frozen in its pending state with no outcome either. With
 * `'always'` the request is really made and `../api/client` turns the fetch rejection into its own
 * `network_error`, the code every screen already maps through `userMessageFor`: the dispute form's
 * "No connection. Check your network and try again." beside its Retry, and the same copy in the
 * bootstrap notice, are that pattern (AAP 0.5.4, AAP 0.5.8).
 *
 * `retry` retries only a `network_error` — a request that never reached the API (AAP 0.5.4) — and
 * never an `ApiError` that carries a status, so a `4xx` or `5xx` answer is final: the screen shows
 * `userMessageFor(error.code)` and the traveler decides what to do. It requires a connection as
 * well, because a request that cannot leave the device has the same answer on its first attempt as
 * on its fourth: failing where it stands is what lets the screen report it at once rather than after
 * the 1 s + 2 s + 4 s backoff. `staleTime` keeps a freshly read list from refetching on every mount
 * while the socket's frames keep it current, and mutation retries are off, because one could repeat
 * a hold or a check-in POST (AAP 0.3.2, AAP 0.5.4).
 *
 * No persister is installed, so nothing here survives the process (AAP 0.5.2), and
 * `src/auth/session.ts` calls `queryClient.clear()` on sign-out and after account deletion, so the
 * cache never outlives the session that filled it.
 *
 * The offline check-in path is a different mechanism and is unaffected by anything set here: a code
 * entered with no connection is held and resubmitted by `src/checkin/offline-code.ts`, which reads
 * connectivity itself through NetInfo (AAP 0.5.7).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always',
      retry: (failureCount, error) =>
        isNetworkError(error) && onlineManager.isOnline() && failureCount < NETWORK_RETRIES,
      staleTime: STALE_TIME_MS,
      refetchOnWindowFocus: true,
    },
    mutations: { networkMode: 'always', retry: false },
  },
});

/**
 * Every key the app caches under, one factory per server resource.
 *
 * The roots are chosen so an invalidation reaches exactly what it should: `['meetups']` is every
 * meetup list whatever filter it was read with, and `['meetup', id]` is one meetup with its messages
 * and suggestions beneath it — React Query matches a key by prefix, so invalidating
 * {@link queryKeys.meetup} also refreshes {@link queryKeys.messages} and
 * {@link queryKeys.suggestions} for that meetup, while the two roots never match each other.
 * `['cities']`, `['lodgings']` and `['admin']` follow the same rule. An absent filter is held as
 * `null`, never `undefined`, so a key compares by value under `exactOptionalPropertyTypes`, and the
 * types are the shared ones, never redeclared: a filter the API would refuse with `400
 * invalid_field` cannot be typed into a key (AAP 0.11.1).
 *
 * There is deliberately no key for the audited booking-details read: its answer holds a decrypted
 * booking name and is never cached (AAP 0.5.4).
 */
export const queryKeys = {
  /** `GET /me` — the caller's own account, consents, proof state and Table Credit balance. */
  me: ['me'] as const,
  /** `GET /zk/config` — issuers, registry root, nullifier salt and artefact URLs (AAP 0.5.5). */
  zkConfig: ['zk-config'] as const,
  /** `GET /cities` — the configured launch cities. */
  cities: ['cities'] as const,
  /** `GET /cities/:cityId/venues` — a city's active partner venues. */
  venues: (cityId: string) => ['cities', cityId, 'venues'] as const,
  /** `GET /cities/:cityId/travelers` — discovery, paged over a keyset cursor (AAP 0.5.4). */
  travelers: (cityId: string) => ['cities', cityId, 'travelers'] as const,
  /** `GET /users/:userId` — one profile, already filtered to the caller's tier by the API. */
  user: (userId: string) => ['users', userId] as const,
  /** Every meetup list, whatever filter it was read with. */
  meetupsAll: ['meetups'] as const,
  /** `GET /meetups` under one filter; both filters are closed sets the API validates. */
  meetups: (role?: ParticipantRole, status?: MeetupStatus) =>
    ['meetups', { role: role ?? null, status: status ?? null }] as const,
  /** `GET /meetups/:id` — one meetup, with its messages and suggestions beneath this root. */
  meetup: (id: string) => ['meetup', id] as const,
  /** `GET /meetups/:id/messages` — the pair's chat history. */
  messages: (meetupId: string) => ['meetup', meetupId, 'messages'] as const,
  /** `GET /meetups/:id/suggestions`, keyed by the per-person budget it was read with. */
  suggestions: (meetupId: string, budgetCents?: number) =>
    ['meetup', meetupId, 'suggestions', budgetCents ?? null] as const,
  /** `GET /cities/:cityId/lodgings` — the directory, under one sort order. */
  lodgings: (cityId: string, sort: LodgingSort) => ['lodgings', cityId, sort] as const,
  /** `GET /lodgings/:id` — one lodging with its opted-in guests. */
  lodging: (id: string) => ['lodging', id] as const,
  /** `GET /me/lodging-claims/:id` — the caller's own claim, polled while a call is in flight. */
  lodgingClaim: (id: string) => ['lodging-claim', id] as const,
  /** Every operator read, so one refresh can drop them together. */
  adminAll: ['admin'] as const,
  /** `GET /admin/metrics` for one city, variant pairing and date range (AAP 0.5.7). */
  adminMetrics: (query: MetricsQuery) => ['admin', 'metrics', query] as const,
  /**
   * The four operator queues and the two registries, each one `/admin` route of AAP 0.5.4:
   * `adminDisputes` is `GET /admin/disputes`, `adminReports` `GET /admin/reports`, `adminCallTasks`
   * `GET /admin/call-tasks`, `adminLodgingClaims` `GET /admin/lodging-claims`, `adminCrawlDomains`
   * `GET /admin/crawl-domains`, `adminVenues` `GET /admin/venues` and `adminLodgings`
   * `GET /admin/lodgings`.
   */
  adminDisputes: ['admin', 'disputes'] as const,
  adminReports: ['admin', 'reports'] as const,
  adminCallTasks: ['admin', 'call-tasks'] as const,
  adminLodgingClaims: ['admin', 'lodging-claims'] as const,
  adminCrawlDomains: ['admin', 'crawl-domains'] as const,
  adminVenues: ['admin', 'venues'] as const,
  adminLodgings: ['admin', 'lodgings'] as const,
} as const;

// --- Meetup reads (AAP 0.5.4) ------------------------------------------------------------------

/**
 * The `GET /meetups` query string: only the filters that are set, because the API validates the
 * query with a strict schema and answers `400 invalid_field` for a filter it does not know, while
 * `exactOptionalPropertyTypes` forbids sending `cursor: undefined`.
 */
function meetupListQuery(
  role: ParticipantRole | undefined,
  status: MeetupStatus | undefined,
  cursor: string | undefined,
): Partial<MeetupListQuery> {
  const query: Partial<MeetupListQuery> = {};
  if (role !== undefined) query.role = role;
  if (status !== undefined) query.status = status;
  if (cursor !== undefined) query.cursor = cursor;
  return query;
}

/** Flattens the pages {@link useMeetups} holds into the one list a list view renders (AAP 0.5.8). */
export function meetupsInPages(pages: readonly MeetupListResponse[]): MeetupDto[] {
  return pages.flatMap((page) => page.items);
}

/**
 * The caller's own account (AAP 0.5.4): the consents the age gate records, the proof state behind
 * the unverified browsing states, the Table Credit balance, the counters and the lodging claim.
 *
 * Settlement moves the balance and the counters, so {@link bindRealtimeInvalidation} refreshes this
 * read whenever a meetup reaches a final status (AAP 0.5.3, AAP 0.5.7). Enabled only for a
 * signed-in session, as the two meetup reads below are: with no access token there is nothing to
 * authenticate with, and a request sent anyway would be refused and drive the refresh path for
 * nothing (AAP 0.3.3).
 */
export function useMe() {
  const signedIn = useSession().status === 'signed_in';
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiClient.getMe(),
    enabled: signedIn,
  });
}

/**
 * The caller's own meetups: 20 per read over a keyset cursor, both sides included (AAP 0.5.4).
 *
 * `role` selects the caller's own side and `status` one lifecycle value; an unset filter is left
 * out of the request rather than sent empty. Read the pages through {@link meetupsInPages}.
 *
 * This is also the deposit screens' recovery path: `402 hold_failed` carries no meetup id, so
 * `app/meetups/propose.tsx` invalidates {@link queryKeys.meetupsAll} and reads
 * `useMeetups('initiator', 'proposed')` to find the meetup to hand to `apiClient.retryHold`, and the
 * same read is what a screen polls while `503 payment_unavailable` resolves a lost hold answer,
 * where that side's hold reads `pending` until it does (AAP 0.5.4, AAP 0.3.2).
 */
export function useMeetups(role?: ParticipantRole, status?: MeetupStatus) {
  const signedIn = useSession().status === 'signed_in';
  return useInfiniteQuery({
    queryKey: queryKeys.meetups(role, status),
    // React Query 5 requires an explicit first page parameter; the API's first page is the one read
    // without a cursor, so an absent cursor is what starts the list (AAP 0.5.4).
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => apiClient.listMeetups(meetupListQuery(role, status, pageParam)),
    // `nextCursor` is null on the last page, which stops the paging by returning nothing.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: signedIn,
  });
}

/**
 * One meetup with the counterpart serialized at the caller's disclosure tier (AAP 0.5.4).
 *
 * The hook returns what the API sent and filters nothing: which profile fields exist here is the
 * API's decision, made by tier (AAP 0.3.2, criterion 5). No client secret is part of the answer, so
 * for `nextAction: 'confirm_hold'` a screen repeats `apiClient.acceptMeetup` or `apiClient.retryHold`
 * and receives its own current attempt's secret.
 *
 * The recipient's first read sets `recipientViewedAt` server-side (AAP 0.5.4); it is idempotent, so a
 * refetch from a `meetup_status` frame or a focused window is harmless. Enabled for a non-empty id and
 * a signed-in session, so a screen may call it while its route parameter is still resolving.
 */
export function useMeetup(id: string) {
  const signedIn = useSession().status === 'signed_in';
  return useQuery({
    queryKey: queryKeys.meetup(id),
    queryFn: () => apiClient.getMeetup(id),
    enabled: signedIn && id.length > 0,
  });
}

// --- Realtime invalidation (AAP 0.3.3, AAP 0.5.4) ----------------------------------------------

/** The unbind of the binding currently installed, or null when nothing is bound. */
let unbindRealtime: (() => void) | null = null;

/**
 * Turns one pushed frame into the refetches it implies (AAP 0.3.3, AAP 0.5.4).
 *
 * A frame is a signal, never the answer: it names what changed, and the query is refetched so the
 * screen renders the server's own serialization rather than a patch assembled on the client. Every
 * inbound frame was already parsed with the shared `ServerFrame` by `../api/ws`, and no part of one
 * is logged (AAP 0.11.1).
 */
function handleFrame(frame: ServerFrame): void {
  switch (frame.type) {
    case 'meetup_status': {
      // The frame carries the two hold views, but the meetup itself — status, deadline, next action,
      // counterpart, checked-in flag — is read again, and every list that may contain it with it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetup(frame.meetupId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll });
      if (isFinalMeetupStatus(frame.status)) {
        // Settlement moves the money and the reputation counters, both of which the own profile read
        // carries (AAP 0.5.3, AAP 0.5.7).
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      }
      break;
    }
    case 'message': {
      // The chat screen renders the frame itself for an immediate bubble; this keeps the paged
      // history beneath it consistent. Nothing is appended to the cache, because that history's
      // order belongs to the chat screen.
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages(frame.message.meetupId) });
      break;
    }
    case 'error': {
      // Refusals belong to `../api/ws`, which owns the socket and the `token_invalid` handling.
      break;
    }
  }
}

/**
 * Subscribes the cache to the chat socket's frames and returns the function that unsubscribes, which
 * `src/auth/session.ts` calls when the session ends (AAP 0.3.3, AAP 0.5.4).
 *
 * Idempotent both ways: a second call while a binding is installed returns that same unbind and
 * subscribes nothing more, and a handle removes only its own listener, so one left over from an
 * earlier session can never detach the binding that replaced it. Listeners survive a reconnect,
 * which `../api/ws` performs and owns, so frames arriving after a dropped connection still refresh
 * what is on screen.
 *
 * @returns The function that removes this binding; safe to call more than once.
 */
export function bindRealtimeInvalidation(): () => void {
  const installed = unbindRealtime;
  if (installed !== null) return installed;

  const unsubscribe = subscribe(handleFrame);
  const unbind = (): void => {
    if (unbindRealtime !== unbind) return;
    unbindRealtime = null;
    unsubscribe();
  };
  unbindRealtime = unbind;
  return unbind;
}
