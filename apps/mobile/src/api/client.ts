/**
 * The Tablemate REST client: one named function per route of AAP 0.5.4 on top of a single `request`. Every response is
 * parsed with the `@tablemate/shared` Zod schema this client names for that route, so a contract change surfaces here
 * as a type error rather than at runtime; the client never filters a payload, because disclosure is enforced at field
 * level by the API; and nothing sensitive passes through — coordinates only in the check-in body, the proof body
 * exactly `{ proof, publicSignals }`, card details only inside Stripe's own components, and no logging at all.
 */
import {
  API_PATH_PREFIX,
  AcceptResponse,
  AdminCallTasksResponse,
  AdminCrawlDomainDto,
  AdminCrawlDomainsResponse,
  AdminDisputesResponse,
  AdminLlmSuspension,
  AdminLodgingClaimsResponse,
  AdminLodgingDto,
  AdminLodgingsResponse,
  AdminReportsResponse,
  AdminVenueDto,
  AdminVenuesResponse,
  AnyTierProfile,
  BookingDetailsDto,
  CancelResponse,
  CheckInResponse,
  CitiesResponse,
  DeclineResponse,
  DisputeResponse,
  HoldRetryResponse,
  LodgingClaimCreated,
  LodgingClaimStatusDto,
  LodgingDetail,
  LodgingsResponse,
  MeDto,
  MeetupDto,
  MeetupListResponse,
  MessageHistoryResponse,
  MetricsDto,
  PaymentSetupResponse,
  PriceJobResponse,
  ProofAccepted,
  ProposeResponse,
  RefreshResponse,
  SecretIssued,
  SuggestionsResponse,
  TravelersResponse,
  VenuesResponse,
  VerifyResponse,
  VisibilityResponse,
  ZkConfig,
} from '@tablemate/shared';
import type {
  AdminCallTasksQuery,
  AdminLodgingsQuery,
  AdminVenuesQuery,
  CheckInRequest,
  ClientEventRequest,
  ConsentsRequest,
  CrawlDomainDecisionUpdate,
  CreateLodgingRequest,
  CreateVenueRequest,
  DisputeRequest,
  LodgingClaimRequest,
  LodgingSort,
  MagicLinkRequest,
  MeetupListQuery,
  MetricsQuery,
  PriceJobRequest,
  ProfileUpdate,
  ProofSubmission,
  ProposeMeetup,
  PushTokenRequest,
  RefreshRequest,
  ReportRequest,
  ResolveCallTask,
  ResolveDispute,
  ResolveLodgingClaim,
  UpdateVenueRequest,
  VerifyRequest,
  VisibilityRequest,
} from '@tablemate/shared';
import { invalidResponse, isApiError, networkError, parseError } from './errors';
import type { ApiError } from './errors';
import { recordServerDate } from './server-clock';

/** How long a request waits unless the route asks for longer, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 20_000;
const NO_AUTH_HOOKS = 'configureAuth must be called before an authenticated request';
const enc = encodeURIComponent;
/**
 * The API base every route is resolved against: the configured origin plus `/v1`.
 *
 * The variable is read by direct static member access on purpose — `babel-preset-expo` inlines only that form — and
 * resolved per call, so importing this module in a Node test with it unset neither throws nor needs an environment.
 * @throws Error when the variable is unset or empty.
 */
export function apiBaseUrl(): string {
  // Kept as one direct member access and the value narrowed by hand: under the Expo types the read arrives as `any`,
  // so an unannotated binding would be unchecked, and `typeof` is what makes an empty string a missing value.
  const configured: unknown = process.env.EXPO_PUBLIC_API_URL;
  const origin = typeof configured === 'string' ? configured.trim().replace(/\/+$/, '') : '';
  if (origin === '') {
    throw new Error('EXPO_PUBLIC_API_URL is not set');
  }
  return `${origin}${API_PATH_PREFIX}`;
}

/**
 * The part of a Zod schema this client uses. Typed structurally because `zod` is not a dependency of
 * `@tablemate/mobile`; every schema shared from `@tablemate/shared` satisfies it.
 */
export interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

/**
 * The auth operations the client needs, installed by `src/auth/session.ts` so that this module never imports the
 * session module: the dependency runs one way, from auth to the API client, which keeps the two out of a cycle.
 */
export interface AuthHooks {
  /** The in-memory access token, or null while signed out. Never persisted. */
  getAccessToken(): string | null;
  /**
   * Awaited before the first authenticated send of a request that holds no access token — a cold start whose restore
   * has not finished, which is the state every screen that reads at mount starts in. It resolves once an access token
   * is held, and rejects with the failure that prevented the restore, so the request is refused rather than sent
   * unauthenticated.
   */
  ensureSession?(): Promise<void>;
  /** Rotates the refresh token and installs the new pair. Rejects when it cannot (AAP 0.11.2). */
  refresh(): Promise<unknown>;
  /**
   * Clears the session after the server refused the refresh token with `401 token_invalid`. MUST be idempotent:
   * several requests can be refused at once, and a second call after the session is already gone has to be harmless.
   */
  onSignedOut(): void | Promise<void>;
}

/** The installed hooks, or null before {@link configureAuth} is called. Module state, no side effect. */
let installed: AuthHooks | null = null;
/** Installs the auth hooks. Called once at client start-up, before the first authenticated read. */
export function configureAuth(hooks: AuthHooks): void {
  installed = hooks;
}

/** The installed auth hooks, or null. Read by `./ws` to authenticate the chat socket (AAP 0.5.4). */
export function authHooks(): AuthHooks | null {
  return installed;
}

/** The rotation currently running, or null. One rotation serves every caller that asks meanwhile. */
let rotationInFlight: Promise<void> | null = null;
/**
 * Rotates the session, single-flight (AAP 0.3.3).
 *
 * While a rotation runs, every caller — a concurrent request that was refused, or `./ws` opening a socket — awaits the
 * same promise, so one refresh token is spent once: a token presented after it was rotated away is read as reuse,
 * which revokes the whole session (AAP 0.11.2).
 * @returns A promise that resolves once the new pair is installed, and rejects otherwise: with a plain `Error` when no
 * hooks are configured, which is a wiring mistake rather than an API answer, and with whatever `AuthHooks.refresh`
 * rejected with otherwise.
 */
export function refreshSession(): Promise<void> {
  const running = rotationInFlight;
  if (running !== null) return running;
  const hooks = installed;
  if (hooks === null) return Promise.reject(new Error(NO_AUTH_HOOKS));

  // The rotation starts on a microtask so the shared promise is stored before `hooks.refresh()`
  // runs: a re-entrant call made from inside the refresh joins this rotation instead of starting a
  // second one.
  const rotation = Promise.resolve()
    .then(() => hooks.refresh())
    .then(() => undefined)
    .finally(() => {
      rotationInFlight = null;
    });
  rotationInFlight = rotation;
  return rotation;
}

/** The access token the hooks hold, or null when signed out or unconfigured. */
function accessToken(): string | null {
  return installed === null ? null : installed.getAccessToken();
}

/** The methods the API is reached with (AAP 0.5.4). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** Everything a route may pass to {@link request} beyond its response schema. */
export interface RequestOptions {
  /** The JSON body. Absent — not `undefined`-valued — on a route that takes none. */
  body?: unknown;
  /** Query parameters; an `undefined` or `null` value is left out rather than sent empty. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Send the bearer token. Defaults to true. */
  auth?: boolean;
  /** Allow one refresh-and-retry on `401 token_invalid`. Defaults to true. */
  refreshOnUnauthorized?: boolean;
  /** How long the request waits. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The caller's signal, forwarded so a cancelled query stays cancelled (AAP 0.5.1). */
  signal?: AbortSignal;
}

/**
 * The part of a fetch answer this client reads. Structural for the same reason `parseError` takes a structural
 * response: both `Response` implementations fit it and a test can pass a literal.
 */
interface HttpAnswer {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * Sends one API request and returns the parsed answer (AAP 0.3.3).
 *
 * `path` starts with `/` and is relative to `/v1`. A success answers either the payload the response schema parsed or
 * nothing when the route's answer is ignored; a failure is always an `ApiError` carrying the envelope's code and the
 * response's status, with `Retry-After` on a `429`, and no part of a failing body leaves `./errors`.
 * One `401 token_invalid` — an expired 15-minute access token, a rotated refresh token, or the refusal a deleted
 * account receives (AAP 0.5.3) — is recovered from: (1) when the in-memory token already changed, another request
 * refreshed while this one was in flight, so this one is simply retried with what that refresh installed; (2)
 * otherwise the session is rotated once through {@link refreshSession}, where a rotation refused with
 * `401 token_invalid` signs the traveler out and rethrows the original refusal, while any other rotation failure is
 * reported as itself and signs nobody out; (3) the request is retried exactly once, and a second `401 token_invalid`
 * signs the traveler out.
 * The request only ever reaches the API authenticated: when the route sends the bearer token and none is held, the
 * installed `AuthHooks.ensureSession` is awaited before the first send and the token it installs is read again and
 * sent; its rejection propagates, which refuses the request instead of sending it without a token. Repeating a
 * mutating request after a `401` is safe: the API authenticates and authorizes before it handles anything.
 */
export function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions & { response: ResponseSchema<T> },
): Promise<T>;
export function request(
  method: HttpMethod,
  path: string,
  options: RequestOptions & { response: null },
): Promise<void>;
export async function request(
  method: HttpMethod,
  path: string,
  options: RequestOptions & { response: ResponseSchema<unknown> | null },
): Promise<unknown> {
  const sendAuth = options.auth ?? true;
  const refreshOnUnauthorized = options.refreshOnUnauthorized ?? true;
  const url = `${apiBaseUrl()}${path}${buildQuery(options.query)}`;
  let token = sendAuth ? accessToken() : null;
  let retried = false;

  if (sendAuth && token === null) {
    const hooks = installed;
    if (hooks !== null && hooks.ensureSession !== undefined) {
      await hooks.ensureSession();
      token = accessToken();
    }
  }

  for (;;) {
    const answer = await send(method, url, options, token);
    // Read once: a Response body can be consumed only once, and the failure path needs the text.
    const text = await answer.text();

    if (answer.ok) {
      if (options.response === null) return undefined;
      return decode(answer.status, text, options.response);
    }

    const failure = parseError(answer, text);
    const refused = failure.status === 401 && failure.code === 'token_invalid';
    if (!refused || !sendAuth || !refreshOnUnauthorized) throw failure;
    if (retried) {
      // The retry carried a freshly rotated token and was refused anyway: the session is gone.
      await signOut();
      throw failure;
    }

    const rotated = accessToken();
    if (rotated !== null && rotated !== token) {
      token = rotated;
      retried = true;
      continue;
    }

    token = await rotateSession(failure);
    retried = true;
  }
}

/**
 * Rotates the session after a request was refused with `401 token_invalid`, and returns the token to retry with
 * (AAP 0.3.3).
 *
 * The rotation's own failure decides what happens next: a refusal means the refresh token is spent or revoked — reuse
 * detection revokes the session that presented a rotated token (AAP 0.11.2) — so the traveler is signed out and the
 * original refusal is rethrown, while anything else, a `network_error` above all, is thrown as itself and signs nobody
 * out.
 */
async function rotateSession(refusal: ApiError): Promise<string | null> {
  try {
    await refreshSession();
  } catch (error) {
    if (isApiError(error) && error.status === 401 && error.code === 'token_invalid') {
      await signOut();
      throw refusal;
    }
    throw error;
  }
  return accessToken();
}

/** Clears the session, swallowing a hook failure: signing out must never mask the refusal. */
async function signOut(): Promise<void> {
  const hooks = installed;
  if (hooks === null) return;
  try {
    await hooks.onSignedOut();
  } catch {
    // `onSignedOut` is idempotent, so a failed call is not retried and nothing else is done.
  }
}

/**
 * Sends one request and returns the answer before its body is read.
 *
 * The timeout gets an `AbortController` of its own and the caller's signal is forwarded to it, because Hermes has no
 * `AbortSignal.any`. A caller-driven abort is rethrown unchanged, so a cancelled React Query request stays its own
 * cancellation, while every other `fetch` rejection — offline, DNS, timeout — becomes `networkError`.
 * `Content-Type: application/json` is sent only alongside a body: Fastify 5 answers `400` to a body-less request that
 * declares a JSON type, so a body-less POST sends neither header nor body.
 */
async function send(
  method: HttpMethod,
  url: string,
  options: RequestOptions,
  token: string | null,
): Promise<HttpAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const callerSignal = options.signal;
  const forwardAbort = (): void => controller.abort();

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', forwardAbort);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const init: RequestInit = {
    method,
    headers,
    // Bearer only: the API issues no cookie, and a cookie is never sent (AAP 0.3.3).
    credentials: 'omit',
    signal: controller.signal,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const sentAtMs = Date.now();
  try {
    const answer = await fetch(url, init);
    // Every answer, a refusal included, carries the API's own clock in its `Date` header, which CORS exposes to the web
    // origin for exactly this reading, so one response is enough to correct the device's skew.
    recordServerDate(answer.headers.get('Date'), sentAtMs, Date.now());
    return answer;
  } catch (error) {
    if (callerSignal !== undefined && callerSignal.aborted) throw error;
    throw networkError();
  } finally {
    clearTimeout(timer);
    if (callerSignal !== undefined) callerSignal.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Parses a 2xx body with the route's schema. An empty body, text that is not JSON and a payload the schema refuses are
 * one failure: `invalid_response` carrying the status. No part of the body is kept and nothing is logged.
 */
function decode<T>(status: number, text: string, schema: ResponseSchema<T>): T {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw invalidResponse(status);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw invalidResponse(status);
  return parsed.data;
}

/**
 * Builds a query string by hand: React Native 0.76's `URLSearchParams` is incomplete and no Node built-in is in the
 * bundle, so key and value are both escaped and an `undefined` or `null` value is left out rather than sent empty.
 */
function buildQuery(query: RequestOptions['query']): string {
  if (query === undefined) return '';
  const pairs: string[] = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

/**
 * Every route the client calls, one named function per route (AAP 0.5.4), each answering the shared DTO or nothing.
 *
 * Deposit routes — propose, accept, hold and cancel — wait 45 s because the API confirms the card hold inside the
 * request, and the own-profile edit waits 60 s for a base64 photo. The recovery rules their screens apply are stated
 * once here: `402 hold_failed` leaves the meetup `proposed` and carries no meetup id, so the initiator recovers it
 * from `listMeetups({ role: 'initiator', status: 'proposed' })` and retries through `retryHold`;
 * `503 payment_unavailable` means Stripe's answer was lost and the API is recovering it, so the client polls
 * `listMeetups` and that side's hold reads `pending` until it resolves; and a `MeetupDto` carries no client secret, so
 * for `nextAction: 'confirm_hold'` the client repeats `acceptMeetup` or `retryHold` and receives its own current
 * attempt's secret.
 */
export const apiClient = {
  /** `POST /auth/magic-link` — always `202`, so an address cannot be enumerated. */
  magicLink: (body: MagicLinkRequest): Promise<void> =>
    request('POST', '/auth/magic-link', { body, response: null, auth: false }),
  /** `POST /auth/verify` — the 15-minute single-use link, which creates the account on first use. */
  verify: (body: VerifyRequest): Promise<VerifyResponse> =>
    request('POST', '/auth/verify', { body, response: VerifyResponse, auth: false }),

  refresh: (body: RefreshRequest): Promise<RefreshResponse> =>
    request('POST', '/auth/refresh', { body, response: RefreshResponse, auth: false }),

  logout: (): Promise<void> =>
    request('POST', '/auth/logout', { response: null, refreshOnUnauthorized: false }),
  getMe: (): Promise<MeDto> => request('GET', '/me', { response: MeDto }),

  postConsents: (body: ConsentsRequest): Promise<MeDto> =>
    request('POST', '/me/consents', { body, response: MeDto }),

  updateProfile: (body: ProfileUpdate): Promise<MeDto> =>
    request('PUT', '/me/profile', { body, response: MeDto, timeoutMs: 60_000 }),

  registerPushToken: (body: PushTokenRequest): Promise<void> =>
    request('POST', '/me/push-tokens', { body, response: null }),

  createPaymentSetup: (): Promise<PaymentSetupResponse> =>
    request('POST', '/me/payment-setup', { response: PaymentSetupResponse, timeoutMs: 45_000 }),
  deleteMe: (): Promise<void> => request('DELETE', '/me', { response: null }),

  getZkConfig: (): Promise<ZkConfig> =>
    request('GET', '/zk/config', { response: ZkConfig, auth: false }),
  /**
   * The body is built key by key and never spread, so exactly `{ proof, publicSignals }` leaves the device: no email
   * byte, guest name, booking reference, address or price travels with it (AAP 0.12.2, criterion 3).
   */
  submitProof: (input: ProofSubmission): Promise<ProofAccepted> =>
    request('POST', '/itinerary-proofs', {
      body: { proof: input.proof, publicSignals: input.publicSignals },
      response: ProofAccepted,
    }),

  listCities: (): Promise<CitiesResponse> =>
    request('GET', '/cities', { response: CitiesResponse }),

  listVenues: (cityId: string): Promise<VenuesResponse> =>
    request('GET', `/cities/${enc(cityId)}/venues`, { response: VenuesResponse }),
  /** `GET /cities/:cityId/travelers` — 20 travelers per page; `403 no_valid_proof` without one. */
  listTravelers: (cityId: string, cursor?: string): Promise<TravelersResponse> =>
    request('GET', `/cities/${enc(cityId)}/travelers`, {
      response: TravelersResponse,
      query: { cursor },
    }),
  /** `GET /users/:userId` — the profile filtered to the caller's disclosure tier. */
  getUser: (userId: string): Promise<AnyTierProfile> =>
    request('GET', `/users/${enc(userId)}`, { response: AnyTierProfile }),
  /** `POST /users/:id/block` — blocks the pair, cancelling any open meetup with them. */
  blockUser: (userId: string): Promise<void> =>
    request('POST', `/users/${enc(userId)}/block`, { response: null }),

  reportUser: (userId: string, body: ReportRequest): Promise<void> =>
    request('POST', `/users/${enc(userId)}/report`, { body, response: null }),
  /** `GET /meetups` — the caller's own meetups, 20 per page, filtered by role and status. */
  listMeetups: (query: Partial<MeetupListQuery>): Promise<MeetupListResponse> =>
    request('GET', '/meetups', {
      response: MeetupListResponse,
      query: { role: query.role, status: query.status, cursor: query.cursor },
    }),
  /** `GET /meetups/:id` — proposal detail; the recipient's first read records the view. */
  getMeetup: (id: string): Promise<MeetupDto> =>
    request('GET', `/meetups/${enc(id)}`, { response: MeetupDto }),
  /** `POST /meetups` — proposes a meetup and places the initiator's card hold. */
  proposeMeetup: (body: ProposeMeetup): Promise<ProposeResponse> =>
    request('POST', '/meetups', { body, response: ProposeResponse, timeoutMs: 45_000 }),
  /** `POST /meetups/:id/accept` — the recipient locks; `locked` once the hold is authorized. */
  acceptMeetup: (id: string): Promise<AcceptResponse> =>
    request('POST', `/meetups/${enc(id)}/accept`, { response: AcceptResponse, timeoutMs: 45_000 }),

  declineMeetup: (id: string): Promise<DeclineResponse> =>
    request('POST', `/meetups/${enc(id)}/decline`, { response: DeclineResponse }),
  /** `POST /meetups/:id/hold` — the initiator retries a failed hold; initiator only. */
  retryHold: (id: string): Promise<HoldRetryResponse> =>
    request('POST', `/meetups/${enc(id)}/hold`, { response: HoldRetryResponse, timeoutMs: 45_000 }),
  /** `POST /meetups/:id/cancel` — free at or before `startsAt - 2 h`, otherwise a forfeit. */
  cancelMeetup: (id: string): Promise<CancelResponse> =>
    request('POST', `/meetups/${enc(id)}/cancel`, { response: CancelResponse, timeoutMs: 45_000 }),

  checkIn: (id: string, body: CheckInRequest): Promise<CheckInResponse> =>
    request('POST', `/meetups/${enc(id)}/check-in`, { body, response: CheckInResponse }),
  /** `POST /meetups/:id/dispute` — opens a dispute that gates settlement until it is resolved. */
  fileDispute: (id: string, body: DisputeRequest): Promise<DisputeResponse> =>
    request('POST', `/meetups/${enc(id)}/dispute`, { body, response: DisputeResponse }),
  /** `GET /meetups/:id/messages` — the pair's chat history, 20 per page, newest first. */
  listMessages: (meetupId: string, cursor?: string): Promise<MessageHistoryResponse> =>
    request('GET', `/meetups/${enc(meetupId)}/messages`, {
      response: MessageHistoryResponse,
      query: { cursor },
    }),

  getSuggestions: (id: string, perPersonBudgetCents?: number): Promise<SuggestionsResponse> =>
    request('GET', `/meetups/${enc(id)}/suggestions`, {
      response: SuggestionsResponse,
      query: { perPersonBudgetCents },
    }),

  listLodgings: (cityId: string, sort: LodgingSort): Promise<LodgingsResponse> =>
    request('GET', `/cities/${enc(cityId)}/lodgings`, {
      response: LodgingsResponse,
      query: { sort },
    }),

  getLodging: (id: string): Promise<LodgingDetail> =>
    request('GET', `/lodgings/${enc(id)}`, { response: LodgingDetail }),
  /** `POST /me/lodging-claims` — claims a stay, with the call notice consented to. */
  createLodgingClaim: (body: LodgingClaimRequest): Promise<LodgingClaimCreated> =>
    request('POST', '/me/lodging-claims', { body, response: LodgingClaimCreated }),
  /** `GET /me/lodging-claims/:id` — the caller's own claim, never another traveler's. */
  getLodgingClaim: (id: string): Promise<LodgingClaimStatusDto> =>
    request('GET', `/me/lodging-claims/${enc(id)}`, { response: LodgingClaimStatusDto }),
  /** `DELETE /me/lodging-claims/:id` — deletes the claim and its booking details. */
  deleteLodgingClaim: (id: string): Promise<void> =>
    request('DELETE', `/me/lodging-claims/${enc(id)}`, { response: null }),
  /** `PUT /me/lodging-visibility` — the staying-on toggle; needs a verified, active claim. */
  setLodgingVisibility: (body: VisibilityRequest): Promise<VisibilityResponse> =>
    request('PUT', '/me/lodging-visibility', { body, response: VisibilityResponse }),
  /** `POST /events` — client analytics for the one allowlisted name, `suggestion_place_opened`. */
  postEvent: (body: ClientEventRequest): Promise<void> =>
    request('POST', '/events', { body, response: null }),

  admin: {
    getMetrics: (query: MetricsQuery): Promise<MetricsDto> =>
      request('GET', '/admin/metrics', {
        response: MetricsDto,
        query: { from: query.from, to: query.to, cityId: query.cityId, variant: query.variant },
      }),

    /**
     * `GET /admin/cities` — the launch-city catalogue as the operator area reads it.
     *
     * The operator area is entered by role alone and lies outside the age gate, so it reads the
     * catalogue here rather than through `GET /cities`, which the age gate guards (AAP 0.5.4). Both
     * routes answer the same list.
     */
    listCities: (): Promise<CitiesResponse> =>
      request('GET', '/admin/cities', { response: CitiesResponse }),

    /** `GET /admin/disputes` — the open disputes, nearest deadline first. */
    listDisputes: (): Promise<AdminDisputesResponse> =>
      request('GET', '/admin/disputes', { response: AdminDisputesResponse }),
    /** `POST /admin/disputes/:id/resolve` — `settle_by_checkins` or `no_fault`. */
    resolveDispute: (id: string, body: ResolveDispute): Promise<void> =>
      request('POST', `/admin/disputes/${enc(id)}/resolve`, { body, response: null }),

    listReports: (): Promise<AdminReportsResponse> =>
      request('GET', '/admin/reports', { response: AdminReportsResponse }),

    listCallTasks: (query: AdminCallTasksQuery = {}): Promise<AdminCallTasksResponse> =>
      request('GET', '/admin/call-tasks', {
        response: AdminCallTasksResponse,
        query: {
          status: query.status,
          kind: query.kind,
          q: query.q,
          limit: query.limit,
          cursor: query.cursor,
        },
      }),
    /** `POST /admin/call-tasks/:id/resolve` — an operator outcome, with prices when completed. */
    resolveCallTask: (id: string, body: ResolveCallTask): Promise<void> =>
      request('POST', `/admin/call-tasks/${enc(id)}/resolve`, { body, response: null }),
    /** `GET /admin/lodging-claims` — the claim queue, never the booking details themselves. */
    listLodgingClaims: (): Promise<AdminLodgingClaimsResponse> =>
      request('GET', '/admin/lodging-claims', { response: AdminLodgingClaimsResponse }),
    /** `POST /admin/lodging-claims/:id/resolve` — `verified`, `rejected` or `unreachable`. */
    resolveLodgingClaim: (id: string, body: ResolveLodgingClaim): Promise<void> =>
      request('POST', `/admin/lodging-claims/${enc(id)}/resolve`, { body, response: null }),
    /** `GET /admin/lodging-claims/:id/booking-details` — audited; never cached, never logged. */
    getBookingDetails: (id: string): Promise<BookingDetailsDto> =>
      request('GET', `/admin/lodging-claims/${enc(id)}/booking-details`, {
        response: BookingDetailsDto,
      }),

    listCrawlDomains: (): Promise<AdminCrawlDomainsResponse> =>
      request('GET', '/admin/crawl-domains', { response: AdminCrawlDomainsResponse }),
    /** `PATCH /admin/crawl-domains/:domain` — records `allowed` or `prohibited` for a domain. */
    setCrawlDomainDecision: (
      domain: string,
      body: CrawlDomainDecisionUpdate,
    ): Promise<AdminCrawlDomainDto> =>
      request('PATCH', `/admin/crawl-domains/${enc(domain)}`, {
        body,
        response: AdminCrawlDomainDto,
      }),

    listVenues: (query: AdminVenuesQuery = {}): Promise<AdminVenuesResponse> =>
      request('GET', '/admin/venues', {
        response: AdminVenuesResponse,
        query: { cityId: query.cityId, q: query.q, limit: query.limit, cursor: query.cursor },
      }),

    createVenue: (body: CreateVenueRequest): Promise<AdminVenueDto> =>
      request('POST', '/admin/venues', { body, response: AdminVenueDto }),
    /** `PATCH /admin/venues/:id` — edits the editable venue fields; `lat` and `lng` in pairs. */
    updateVenue: (id: string, body: UpdateVenueRequest): Promise<AdminVenueDto> =>
      request('PATCH', `/admin/venues/${enc(id)}`, { body, response: AdminVenueDto }),
    /** `POST /admin/venues/:id/secret` — issues the console secret, shown once and never again. */
    issueVenueSecret: (id: string): Promise<SecretIssued> =>
      request('POST', `/admin/venues/${enc(id)}/secret`, { response: SecretIssued }),

    listLodgings: (query: AdminLodgingsQuery = {}): Promise<AdminLodgingsResponse> =>
      request('GET', '/admin/lodgings', {
        response: AdminLodgingsResponse,
        query: { cityId: query.cityId, q: query.q, limit: query.limit, cursor: query.cursor },
      }),
    /** `POST /admin/lodgings` — manual lodging entry, stored with `phoneSource = operator`. */
    createLodging: (body: CreateLodgingRequest): Promise<AdminLodgingDto> =>
      request('POST', '/admin/lodgings', { body, response: AdminLodgingDto }),
    /** `POST /admin/lodgings/:id/secret` — issues the lodging console secret; shown once. */
    issueLodgingSecret: (id: string): Promise<SecretIssued> =>
      request('POST', `/admin/lodgings/${enc(id)}/secret`, { response: SecretIssued }),

    enqueuePriceJob: (body: PriceJobRequest): Promise<PriceJobResponse> =>
      request('POST', '/admin/price-jobs', { body, response: PriceJobResponse }),

    reEnableLanguageModel: (): Promise<AdminLlmSuspension> =>
      request('POST', '/admin/language-model/re-enable', { response: AdminLlmSuspension }),
  },
} as const;
/** The shape of {@link apiClient}, for a screen or a store that holds it behind a parameter. */
export type ApiClient = typeof apiClient;
/** The shape of {@link apiClient}, for a screen or a store that holds it behind a parameter. */
export function userPhotoRequest(userId: string): {
  url: string;
  headers: Record<string, string>;
} {
  const token = accessToken();
  return {
    url: `${apiBaseUrl()}/users/${enc(userId)}/photo`,
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  };
}
