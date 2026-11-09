/**
 * The client's server-state layer: one React Query client, the query keys every screen shares, the meetup reads, and the
 * binding that turns chat-socket frames into refetches.
 *
 * The cache stores server answers as they arrived and never filters one, because disclosure is enforced at field level
 * by the API; nothing is persisted; and only a request that never reached the API is retried, never a write — repeating
 * a hold or a check-in POST is not the client's decision, and `503 payment_unavailable` and `409 hold_pending` are
 * recovered by polling the meetup reads. The dependency runs one way: `src/auth` imports this folder, so importing
 * `src/auth` here would close a cycle. Nothing here logs, a frame's message body included.
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
const STALE_TIME_MS = 30_000;
const NETWORK_RETRIES = 3;
/**
 * The one client for the whole app, built at module load and inert until something mounts it.
 *
 * `networkMode: 'always'`: React Query's default, `'online'`, refuses to call the request function while `onlineManager`
 * reports the runtime offline, which leaves a query pending for ever — a screen stuck on its spinner with no error to
 * report — and a mutation paused before its function runs. With `'always'` the request is really made and
 * `../api/client` turns the fetch rejection into its own `network_error`, the code every screen maps through
 * `userMessageFor`.
 * `retry` retries only a `network_error` and never an `ApiError` carrying a status, so a `4xx` or `5xx` answer is final,
 * and it requires a connection: a request that cannot leave the device has the same answer on its fourth attempt as on
 * its first. `staleTime` keeps a freshly read list from refetching on every mount while the socket's frames keep it
 * current, and mutation retries are off, because one could repeat a hold or a check-in POST.
 * No persister is installed, so nothing here survives the process, and `src/auth/session.ts` clears the client on
 * sign-out and after account deletion (AAP 0.5.2). The offline check-in path is separate: a code entered with no
 * connection is held and resubmitted by `src/checkin/offline-code.ts`, which reads connectivity itself through NetInfo.
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
 * The roots are chosen so an invalidation reaches exactly what it should: `['meetups']` is every meetup list whatever
 * filter it was read with, and `['meetup', id]` is one meetup with its messages and suggestions beneath it, because
 * React Query matches a key by prefix, while the two roots never match each other. An absent filter is held as `null`,
 * never `undefined`, so a key compares by value under `exactOptionalPropertyTypes`, and the types are the shared ones,
 * never redeclared. There is deliberately no key for the audited booking-details read: its answer holds a decrypted
 * booking name and is never cached (AAP 0.5.4).
 */
export const queryKeys = {
  me: ['me'] as const,
  zkConfig: ['zk-config'] as const,
  cities: ['cities'] as const,
  venues: (cityId: string) => ['cities', cityId, 'venues'] as const,
  /** `GET /cities/:cityId/travelers` — discovery, paged over a keyset cursor (AAP 0.5.4). */
  travelers: (cityId: string) => ['cities', cityId, 'travelers'] as const,
  user: (userId: string) => ['users', userId] as const,
  meetupsAll: ['meetups'] as const,
  meetups: (role?: ParticipantRole, status?: MeetupStatus) =>
    ['meetups', { role: role ?? null, status: status ?? null }] as const,
  meetup: (id: string) => ['meetup', id] as const,
  /** `GET /meetups/:id/messages` — the pair's chat history. */
  messages: (meetupId: string) => ['meetup', meetupId, 'messages'] as const,
  suggestions: (meetupId: string, budgetCents?: number) =>
    ['meetup', meetupId, 'suggestions', budgetCents ?? null] as const,
  lodgings: (cityId: string, sort: LodgingSort) => ['lodgings', cityId, sort] as const,
  lodging: (id: string) => ['lodging', id] as const,
  /** `GET /me/lodging-claims/:id` — the caller's own claim, polled while a call is in flight. */
  lodgingClaim: (id: string) => ['lodging-claim', id] as const,
  adminAll: ['admin'] as const,
  /** `GET /admin/metrics` for one city, variant pairing and date range (AAP 0.5.7). */
  adminMetrics: (query: MetricsQuery) => ['admin', 'metrics', query] as const,
  /**
   * `GET /admin/cities` — the operator's own read of the launch-city catalogue, which labels the
   * dashboard's city filter, its per-city rows and the registry's city selects (AAP 0.5.4). Held
   * apart from {@link queryKeys.cities} on purpose: that root belongs to the age-gated traveler route,
   * which an operator who has recorded no consents may not read.
   */
  adminCities: ['admin', 'cities'] as const,
  /**
   * The four operator queues and the two registries, each one `/admin` route of AAP 0.5.4:
   * `adminDisputes` is `GET /admin/disputes`, `adminReports` `GET /admin/reports`, `adminCallTasks`
   * `GET /admin/call-tasks`, `adminLodgingClaims` `GET /admin/lodging-claims`, `adminCrawlDomains`
   * `GET /admin/crawl-domains`, `adminVenues` `GET /admin/venues`, `adminLodgings`
   * `GET /admin/lodgings` and `adminCities` `GET /admin/cities`.
   */
  adminDisputes: ['admin', 'disputes'] as const,
  adminReports: ['admin', 'reports'] as const,
  adminCallTasks: ['admin', 'call-tasks'] as const,
  adminLodgingClaims: ['admin', 'lodging-claims'] as const,
  adminCrawlDomains: ['admin', 'crawl-domains'] as const,
  adminVenues: ['admin', 'venues'] as const,
  adminLodgings: ['admin', 'lodgings'] as const,
} as const;
/** The `GET /meetups` query string: only the filters that are set, because the API validates the query with a strict
 * schema and answers `400 invalid_field` for a filter it does not know. */
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

export function meetupsInPages(pages: readonly MeetupListResponse[]): MeetupDto[] {
  return pages.flatMap((page) => page.items);
}

/**
 * The caller's own account (AAP 0.5.4): the consents the age gate records, the proof state, the Table Credit balance and
 * the counters. Settlement moves the balance and the counters, so {@link bindRealtimeInvalidation} refreshes this read
 * whenever a meetup reaches a final status. Enabled only for a signed-in session, as the meetup reads below are: with no
 * access token a request sent anyway would be refused and drive the refresh path for nothing (AAP 0.3.3).
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
 * The caller's own meetups: 20 per read over a keyset cursor, both sides included (AAP 0.5.4). `role` selects the
 * caller's own side and `status` one lifecycle value; an unset filter is left out of the request rather than sent empty.
 *
 * This is also the deposit screens' recovery path: `402 hold_failed` carries no meetup id, so `app/meetups/propose.tsx`
 * invalidates {@link queryKeys.meetupsAll} and reads `useMeetups('initiator', 'proposed')` to find the meetup to hand to
 * `apiClient.retryHold`, and the same read is what a screen polls while `503 payment_unavailable` resolves a lost hold
 * answer, where that side's hold reads `pending` until it does.
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
 * The hook returns what the API sent and filters nothing: which profile fields exist here is the API's decision, made by
 * tier. No client secret is part of the answer, so for `nextAction: 'confirm_hold'` a screen repeats
 * `apiClient.acceptMeetup` or `apiClient.retryHold` and receives its own current attempt's secret. The recipient's first
 * read sets `recipientViewedAt` server-side and is idempotent. Enabled for a non-empty id and a signed-in session.
 */
export function useMeetup(id: string) {
  const signedIn = useSession().status === 'signed_in';
  return useQuery({
    queryKey: queryKeys.meetup(id),
    queryFn: () => apiClient.getMeetup(id),
    enabled: signedIn && id.length > 0,
  });
}

let unbindRealtime: (() => void) | null = null;

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
 * `src/auth/session.ts` calls when the session ends.
 *
 * Idempotent both ways: a second call while a binding is installed returns that same unbind and subscribes nothing more,
 * and a handle removes only its own listener, so one left over from an earlier session can never detach the binding that
 * replaced it. Listeners survive a reconnect, which `../api/ws` owns.
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
