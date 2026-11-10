/**
 * Criterion 8 on the web client: every capability of the AAP 0.5.8 navigation table is reached from navigation
 * — the tabs, list rows and buttons of a screen a reader starts from — in both traveler states the product has,
 * with a valid proof and without one (AAP 0.12.1, 0.8.1). The capabilities that need a locked meetup run only
 * where both sides can hold a card, so the second group is skipped with `BLOCKED_REASON` on a stack without
 * Stripe test-mode keys — the same words `scripts/e2e.ts` writes into `docs/acceptance.md` (AAP 0.11.2) — and
 * no mocked payment adapter stands in for them.
 *
 * Four rules the walk obeys: no `page.goto` to a deep path (every screen is reached by clicking, and a stack
 * route the app gives no back control of its own is left with the browser's Back, the destination asserted so a
 * mis-navigation fails at the row that made it); one page per hand-off context, strictly serial, because
 * `contextFor` refuses a second one and `releaseContext` carries the refresh-token chain (AAP 0.11.2); no Block
 * is ever confirmed between the two actors, the product having no unblock route (AAP 0.7.2); and every selector
 * is a test id from the screens' own contract or copy imported from `src/copy/strings.ts` and
 * `@tablemate/shared`, never a string retyped here (AAP 0.11.1).
 */
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import {
  AdminDisputeDto,
  AdminDisputesResponse,
  CitiesResponse,
  DEFAULT_DEPOSIT_CENTS,
  LodgingDetail,
  LodgingsResponse,
  MeDto,
  MeetupDto,
  ProposeResponse,
  ResolveDispute,
  AnyTierProfile,
  depositCopy,
  isDepositLevel,
} from '@tablemate/shared';
import type { DepositCents, Variant } from '@tablemate/shared';

import {
  IMPORT_BANNER,
  OSM_ATTRIBUTION,
  SAFETY_NOTICE,
  guestCountText,
  guestListWarning,
  lodgingCallNotice,
} from '../../src/copy/strings.ts';
import {
  ApiCallError,
  BLOCKED_REASON,
  actorInfo,
  api,
  apiRequest,
  clearPairMeetups,
  contextFor,
  e2eEnv,
  ensureActors,
  ensureCard,
  ensureNoActiveClaim,
  ensureOperator,
  nextMeetupDay,
  operatorApi,
  partnerVenue,
  releaseContext,
  signInViaUi,
  throwawayEmail,
} from './support/api-actor.ts';
import type { MeetupDay } from './support/api-actor.ts';
/**
 * How long one screen, one navigation or one provider round trip may take. It is the bound the
 * harness uses for a page it opened itself, and the card holds it waits for are provider calls.
 */
const SCREEN_TIMEOUT_MS = 30_000;
/** The longest stack a row walks back out of before asserting where it landed. */
const BACK_STEPS = 3;
/**
 * How long one capability group may take, hooks included.
 *
 * `ensureActors()` imports a booking confirmation through the proof screen once per stack, and the
 * harness bounds that single step at fifteen minutes because a proof of this circuit takes minutes
 * even with the key cached. The runner's default of thirty seconds is far below it, so the group sets
 * its own bound rather than depending on the project's configuration for it.
 */
const WALK_TIMEOUT_MS = 30 * 60_000;
/** The report's free text. It is the row's own sentence, never a fixed string of the product's. */
const REPORT_REASON = 'Reachability walk: the report form is reachable.';
/** The chat line the messaging row sends, and the proof that the pair's room carried it. */
const CHAT_LINE = 'Reachability walk: hello from the spec.';
/** The dispute row's free text, inside the 500 characters `DisputeRequest` allows (AAP 0.5.4). */
const DISPUTE_REASON = 'Reachability walk: the dispute form is reachable.';
/** The booking name the claim row types, which is what arms the call notice the screen gates on. */
const BOOKING_NAME = 'Reachability Walker';
/** The throwaway traveler, signed in through the sign-in screen and never verified. */
interface Guest {
  readonly context: BrowserContext;
  readonly page: Page;
  /** The last access token its page sent, which the deletion row asserts is refused afterwards. */
  readonly token: () => string | null;
}
/** What a capability of the open walk needs. */
interface OpenVisit {
  /** Actor A's page: a traveler with a valid proof for one launch city. */
  readonly pageA: Page;
  /** The unverified traveler's page, whose access token the deletion row asserts is revoked. */
  readonly guest: Guest;
}
/** What a capability behind the lock needs: actor B's page and the meetup the two of them locked. */
interface LockedVisit {
  readonly pageB: Page;
  readonly meetupId: string;
}
/** One capability of the AAP 0.5.8 table, with the walk that reaches it. */
interface Capability<Visit> {
  /** The table row's name, as the report prints it. */
  readonly capability: string;
  readonly walk: (visit: Visit) => Promise<void>;
}
/**
 * The visible element carrying one test id.
 *
 * React Navigation keeps a hidden copy of every screen it has mounted — a `display: none` twin of
 * each `data-testid` — so a plain `getByTestId` resolves to an element that is not on screen and a
 * click on it never lands. `:visible` is what selects the live copy.
 */
function visible(page: Page, testID: string): Locator {
  return page.locator(`[data-testid="${testID}"]:visible`);
}
/**
 * The control inside one of the screens' switches.
 *
 * `Switch` gives its `testID` to the control itself — on web one element carrying `role="switch"`,
 * the caller's label and its state on `aria-checked` — so the enabled and checked states are
 * properties of the element the test id names.
 */
function switchControl(page: Page, testID: string): Locator {
  return visible(page, testID);
}
/**
 * Leaves stack routes the way a browser does, until `testID` is on screen again.
 *
 * Screens that own a back control are left with it (the check-in outcome card, the chat, the report
 * confirmation); the rest — the proof screens, the proposal form, the check-in form — have none of
 * their own, and the web client's reader uses the browser's Back for exactly those. The destination
 * is asserted, so a mis-navigation fails here rather than in the row that follows, and no deep link
 * is ever issued.
 */
async function backTo(page: Page, testID: string): Promise<void> {
  for (let step = 0; step < BACK_STEPS; step += 1) {
    if ((await visible(page, testID).count()) > 0) return;
    await page.goBack();
    await page.waitForTimeout(200);
  }
  await expect(visible(page, testID)).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
}
/**
 * The last bearer one context's pages sent to the API.
 *
 * The deletion row proves that the erased account's access token is refused, and that token exists
 * only in the page's own requests: the session store keeps the refresh token in `localStorage` and
 * the access token in memory, where nothing else can read it. The listener is attached to the
 * context rather than to a page, because the sign-in screen issues the first authenticated requests
 * and its page is created inside the harness's sign-in helper.
 */
function trackBearer(context: BrowserContext): () => string | null {
  let bearer: string | null = null;
  context.on('request', (request) => {
    if (!request.url().startsWith(e2eEnv().apiUrl)) return;
    const header = request.headers()['authorization'];
    if (header?.startsWith('Bearer ') === true) bearer = header.slice('Bearer '.length);
  });
  return () => bearer;
}
/** The city one actor's valid proof names, refusing an actor the harness has not hydrated. */
function provedCity(role: 'a' | 'b'): string {
  const city = actorInfo(role).cityId;
  if (city === null)
    throw new Error(`actor ${role} holds no valid proof: call ensureActors() first`);
  return city;
}
/** The experiment variant a deposit screen's framing copy is rendered from (AAP 0.5.7). */
async function variantOf(role: 'a' | 'b'): Promise<Variant> {
  const me = await api(role).get('/me', MeDto);
  if (me.variant === null) throw new Error(`actor ${role} holds no experiment assignment`);
  return me.variant;
}
/** One meetup's deposit as the copy's own type, refusing a value no deposit can hold. */
function depositLevelOf(cents: number): DepositCents {
  if (!isDepositLevel(cents)) {
    throw new Error(`the meetup's deposit ${String(cents)} is not a deposit level`);
  }
  return cents;
}
/**
 * One instant as the proposal form spells it, in the meetup city's own zone: `YYYY-MM-DD HH:mm`,
 * the one format the field parses and prints back (AAP 0.5.8).
 */
function startTextFor(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(new Date(instant));
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')} ${field('hour')}:${field('minute')}`;
}
/** The first page of a list the API answered with no items is a stack that was never seeded. */
function firstOf<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined) throw new Error('the route answered no items: reseed the stack');
  return first;
}
/**
 * The city's first listed lodging with its detail, which is what the directory row and the claim row
 * both start from: the list is what the directory renders and the detail is what the claim's notice
 * names, so the two rows never disagree about which lodging they are looking at.
 */
async function firstLodgingOf(cityId: string) {
  const listed = await api('a').get(`/cities/${cityId}/lodgings`, LodgingsResponse);
  const lodging = firstOf(listed.items);
  const detail = await api('a').get(`/lodgings/${lodging.id}`, LodgingDetail);
  return { detail, lodging };
}
/**
 * Opens the More menu on one traveler's profile, whether or not it is already open.
 *
 * The screen's menu is a toggle whose block confirmation is drawn inside it, and cancelling that
 * confirmation leaves the menu open, so a row that reports after cancelling has to ask rather than
 * press again.
 */
async function openMoreMenu(page: Page): Promise<void> {
  if ((await visible(page, 'user-report').count()) === 0) await visible(page, 'user-more').click();
  await expect(visible(page, 'user-report')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
}
/** One answer from the proposal route: the status it carried and its JSON body, unparsed. */
interface ProposalAnswer {
  readonly status: number;
  readonly body: unknown;
}
/**
 * Selects a venue, a start and a deposit on the proposal screen and presses Send proposal,
 * answering the response it was given (AAP 0.5.4).
 */
async function sendProposal(
  page: Page,
  venueId: string,
  start: string,
  depositCents: DepositCents,
): Promise<ProposalAnswer> {
  await visible(page, `propose-venue-${venueId}`).click();
  await visible(page, 'propose-start').fill(start);
  await visible(page, `propose-deposit-${depositCents}`).click();
  const answered = page.waitForResponse(
    (response) =>
      response.url() === `${e2eEnv().apiUrl}/v1/meetups` &&
      response.request().method() === 'POST' &&
      // The walk moves the API's clock with `nextMeetupDay()`, which can expire the access token the
      // page already holds: the client then refreshes and repeats the request, so the answer that
      // decides anything is the one the refresh produced rather than the 401 it replaced.
      response.status() !== 401,
    { timeout: SCREEN_TIMEOUT_MS },
  );
  await visible(page, 'propose-submit').click();
  const response = await answered;
  const body: unknown = await response.json();
  return { body, status: response.status() };
}
/**
 * The locked-meetup group's prerequisite: A proposes the harness's own fresh day through the
 * proposal screen and the answer's meetup id is returned.
 *
 * The clock is moved by `nextMeetupDay()` before this runs, so the start the row types is ahead of
 * the API's own time and inside the five days the form accepts (AAP 0.5.3, 0.11.2).
 */
async function proposeThroughTheUi(
  browser: Browser,
  day: MeetupDay,
  venueId: string,
  recipientId: string,
): Promise<string> {
  const { context, page } = await contextFor(browser, 'a');
  try {
    await visible(page, 'tab-discover').click();
    await visible(page, `traveler-${recipientId}`).click();
    await expect(visible(page, 'user-profile')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
    await visible(page, 'user-propose').click();
    await expect(visible(page, 'propose-submit')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
    const answer = await sendProposal(
      page,
      venueId,
      startTextFor(day.startsAt, day.timezone),
      DEFAULT_DEPOSIT_CENTS,
    );
    const created = ProposeResponse.parse(answer.body);
    // The screen confirms the initiator's hold itself and replaces to the proposal's own screen, so
    // the detail appearing is what proves the walk reached the state the four rows below start from.
    await expect(visible(page, 'meetup-detail')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
    return created.meetupId;
  } finally {
    await releaseContext('a', context);
  }
}
/*
 * The capability table of AAP 0.5.8, split by what a row needs: the nine capabilities any signed-in
 * traveler reaches, and the five behind a meetup both sides have locked.
 */
/** The two orderings the lodging directory offers, each its own control (AAP 0.5.4). */
const LODGING_SORTS = ['lodgings-sort-activity', 'lodgings-sort-name'] as const;
/** The answer one suggestions read may give: a place card, or the empty reason the route named. */
const SUGGESTION_ANSWER =
  '[data-testid^="suggestion-"]:visible, [data-testid="suggestions-empty"]:visible';

const WITHOUT_A_LOCK: readonly Capability<OpenVisit>[] = [
  {
    capability:
      'proof import: the Discover banner opens the import screen for an unverified traveler',
    walk: async ({ guest }) => {
      const { page } = guest;
      await expect(visible(page, 'tab-discover')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      const banner = visible(page, 'proof-banner');
      await expect(banner).toContainText(IMPORT_BANNER);
      // The banner's action carries no test id of its own, so it is the notice's own button.
      await banner.getByRole('button').click();
      await expect(visible(page, 'proof-import-pick')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      // The pick control itself is never pressed: it opens the operating system's file chooser, which
      // no browser walk can answer, and criterion 1's own spec is what imports a booking.
      await backTo(page, 'tab-discover');
    },
  },
  {
    capability: 'proof import: the Profile row opens the import screen',
    walk: async ({ pageA }) => {
      await visible(pageA, 'tab-profile').click();
      await expect(visible(pageA, 'profile')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(pageA, 'profile-verify-stay').click();
      await expect(visible(pageA, 'proof-import-pick')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await backTo(pageA, 'tab-profile');
    },
  },
  {
    capability: 'discovery: the city page lists the partner venues and the travelers are listed',
    walk: async ({ pageA }) => {
      const cityId = provedCity('a');
      const counterpart = actorInfo('b');
      await visible(pageA, 'tab-discover').click();
      await expect(visible(pageA, `traveler-${counterpart.userId}`)).toBeVisible({
        timeout: SCREEN_TIMEOUT_MS,
      });
      // The city's own page is where one city's partner venues are listed, which needs no proof.
      await visible(pageA, `city-${cityId}`).click();
      const venue = await partnerVenue(cityId);
      await expect(visible(pageA, `venue-${venue.id}`)).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await backTo(pageA, 'tab-discover');
    },
  },
  {
    capability: 'proposal: the framing copy and the safety notice precede the card-hold step',
    walk: async ({ pageA }) => {
      const counterpart = actorInfo('b');
      const variant = await variantOf('a');
      await visible(pageA, 'tab-discover').click();
      await visible(pageA, `traveler-${counterpart.userId}`).click();
      await expect(visible(pageA, 'user-profile')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(pageA, 'user-propose').click();
      await expect(visible(pageA, 'propose-submit')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await expect(visible(pageA, 'deposit-copy')).toHaveText(
        depositCopy(variant, DEFAULT_DEPOSIT_CENTS),
      );
      await expect(visible(pageA, 'safety-notice')).toContainText(SAFETY_NOTICE);
      if (e2eEnv().stripeMode === 'test') {
        // The proposal itself belongs to the locked-meetup group, whose two actors hold cards.
        await backTo(pageA, 'tab-discover');
        return;
      }
      // Mock mode holds no saved card for either side, so the route answers the documented
      // `402 hold_failed` and the screen renders the card step it starts again from (AAP 0.5.4).
      const venue = await partnerVenue(provedCity('a'));
      const day = await nextMeetupDay();
      const answer = await sendProposal(
        pageA,
        venue.id,
        startTextFor(day.startsAt, day.timezone),
        DEFAULT_DEPOSIT_CENTS,
      );
      expect(answer.status).toBe(402);
      await expect(visible(pageA, 'propose-hold-failed')).toBeVisible({
        timeout: SCREEN_TIMEOUT_MS,
      });
      // The proposal the route stored stays open until it is cancelled, and cancelling it is what
      // frees the pair's one open meetup for the next walk (AAP 0.5.3).
      await clearPairMeetups();
      await backTo(pageA, 'tab-discover');
    },
  },
  {
    capability: 'block and report: the block confirmation is cancelled and a report is filed',
    walk: async ({ pageA }) => {
      const counterpart = actorInfo('b');
      await visible(pageA, 'tab-discover').click();
      await visible(pageA, `traveler-${counterpart.userId}`).click();
      await expect(visible(pageA, 'user-profile')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(pageA, 'user-more').click();
      await visible(pageA, 'user-block').click();
      await visible(pageA, 'user-block-cancel').click();
      // No block exists: the profile still answers for the pair, which is the only block check the
      // product has — there is no unblock route for a walk to undo one with (AAP 0.7.2).
      const profile = await api('a').get(`/users/${counterpart.userId}`, AnyTierProfile);
      expect(profile.id).toBe(counterpart.userId);
      await openMoreMenu(pageA);
      await visible(pageA, 'user-report').click();
      await expect(visible(pageA, 'report-submit')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(pageA, 'report-reason').fill(REPORT_REASON);
      await visible(pageA, 'report-submit').click();
      await expect(visible(pageA, 'report-success')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(pageA, 'report-done').click();
      await backTo(pageA, 'tab-discover');
    },
  },
  {
    capability: 'lodging directory: both sorts, the rows and the guest count a lodging reports',
    walk: async ({ pageA }) => {
      const { detail, lodging } = await firstLodgingOf(provedCity('a'));
      await visible(pageA, 'tab-lodgings').click();
      for (const sort of LODGING_SORTS) {
        await visible(pageA, sort).click();
        const row = visible(pageA, `lodging-${lodging.id}`);
        await expect(row).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
        // The count is read through the shared renderer, so a count below three is the shared label
        // rather than a number the server promises never to send (AAP 0.5.4, 0.5.7).
        await expect(row).toContainText(guestCountText(lodging.guestCount));
      }
      await visible(pageA, `lodging-${lodging.id}`).click();
      await expect(visible(pageA, 'lodging-detail')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await expect(visible(pageA, 'lodging-guest-count')).toContainText(
        guestCountText(detail.guestCount),
      );
      await backTo(pageA, 'tab-lodgings');
    },
  },
  {
    capability: 'lodging claim: the call notice is on screen before the consent is operable',
    walk: async ({ pageA }) => {
      const { detail, lodging } = await firstLodgingOf(provedCity('a'));
      const me = await api('a').get('/me', MeDto);
      const { arrivalDate: stayFrom, departureDate: stayTo } = me.proof;
      if (stayFrom === undefined || stayTo === undefined) {
        throw new Error('actor a holds no valid proof: call ensureActors() first');
      }
      await visible(pageA, 'tab-lodgings').click();
      await visible(pageA, `lodging-${lodging.id}`).click();
      await expect(visible(pageA, 'lodging-claim-start')).toBeVisible({
        timeout: SCREEN_TIMEOUT_MS,
      });
      await visible(pageA, 'lodging-claim-start').click();
      // The consent control is inert until the sentence that names the call is on screen, which is
      // the ordering AAP 0.12.2 requires of this one exception to the proof model.
      const consent = switchControl(pageA, 'claim-consent');
      await expect(consent).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await expect(consent).toBeDisabled();
      await expect(visible(pageA, 'claim-notice')).toHaveCount(0);
      await visible(pageA, 'claim-booking-name').fill(BOOKING_NAME);
      await expect(visible(pageA, 'claim-notice')).toHaveText(
        lodgingCallNotice({ bookingName: BOOKING_NAME, lodging: detail.name, stayFrom, stayTo }),
      );
      await expect(consent).toBeEnabled();
      // Nothing is submitted: a claim is what places the verification call (AAP 0.5.3), and this row
      // proves the screen is reachable and its consent gated — not that a call was made.
      await backTo(pageA, 'tab-lodgings');
    },
  },
  {
    capability: 'visibility toggle: the guest-list switch is only offered behind its warning',
    walk: async ({ pageA }) => {
      await visible(pageA, 'tab-profile').click();
      await expect(visible(pageA, 'profile')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(pageA, 'profile-my-stay').click();
      await expect(visible(pageA, 'stay')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      const toggle = visible(pageA, 'stay-toggle');
      const warning = visible(pageA, 'stay-warning');
      if ((await toggle.count()) > 0) {
        // A verified claim is what offers the switch, and the warning is on screen ahead of it.
        const cityId = provedCity('a');
        const cities = await api('a').get('/cities', CitiesResponse);
        const named = cities.items.find((city) => city.id === cityId)?.name ?? cityId;
        await expect(warning).toContainText(guestListWarning(named));
        await expect(switchControl(pageA, 'stay-toggle')).not.toBeChecked();
      } else {
        // No verified claim, so nothing is shared and no switch exists without its warning.
        await expect(visible(pageA, 'stay-find-lodging')).toBeVisible();
        await expect(warning).toHaveCount(0);
      }
      await backTo(pageA, 'tab-profile');
    },
  },
  {
    capability: 'account deletion: the throwaway is erased and its access token is refused',
    walk: async ({ guest }) => {
      const { page } = guest;
      const bearer = guest.token();
      await visible(page, 'tab-profile').click();
      await expect(visible(page, 'profile')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(page, 'profile-settings').click();
      await expect(visible(page, 'settings')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(page, 'settings-delete-account').click();
      // One test id carries both steps of the screen: the review control, then the confirmation.
      const confirm = visible(page, 'delete-account-confirm');
      await expect(confirm).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await confirm.click();
      await expect(visible(page, 'delete-account-cancel')).toBeVisible({
        timeout: SCREEN_TIMEOUT_MS,
      });
      await confirm.click();
      await expect(visible(page, 'sign-in-email')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      // The account is gone: the access token its page held is refused from then on (AAP 0.5.4).
      if (bearer === null) {
        throw new Error('the throwaway page made no authenticated request to capture a token from');
      }
      const refusal = await apiRequest({ method: 'GET', path: '/me', token: bearer }).then(
        () => null,
        (error: unknown) => error,
      );
      if (!(refusal instanceof ApiCallError)) throw new Error('the erased token was not refused');
      expect(refusal.status).toBe(401);
    },
  },
];

const BEHIND_A_LOCK: readonly Capability<LockedVisit>[] = [
  {
    capability: 'accept and lock: the recipient sees the framing and the meetup becomes locked',
    walk: async ({ pageB, meetupId }) => {
      const variant = await variantOf('b');
      const meetup = await api('b').get(`/meetups/${meetupId}`, MeetupDto);
      const cents = depositLevelOf(meetup.depositCents);
      await visible(pageB, 'tab-meetups').click();
      await visible(pageB, `meetup-${meetupId}`).click();
      await expect(visible(pageB, 'meetup-detail')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      // The framing copy and the safety notice are on screen before the control that locks the money.
      await expect(visible(pageB, 'deposit-copy')).toHaveText(depositCopy(variant, cents));
      await expect(visible(pageB, 'safety-notice')).toContainText(SAFETY_NOTICE);
      await visible(pageB, 'meetup-accept').click();
      // A locked meetup is the one that offers check-in, so the control appearing is the screen's own
      // evidence that the accept completed; the API's answer says the same in the contract's terms.
      await expect(visible(pageB, 'meetup-check-in')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      const locked = await api('b').get(`/meetups/${meetupId}`, MeetupDto);
      expect(locked.status).toBe('locked');
      // The status line prints the shared status value as its label, which is what it is matched to.
      await expect(visible(pageB, 'meetup-status')).toHaveText(
        new RegExp(`^${locked.status}$`, 'i'),
      );
    },
  },
  {
    capability: 'check-in: the venue-code form is reachable while the meetup is locked',
    walk: async ({ pageB }) => {
      await visible(pageB, 'meetup-check-in').click();
      await expect(visible(pageB, 'checkin-code')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await expect(visible(pageB, 'checkin-submit')).toBeVisible();
      // Not submitted: outside the window and the 150 m geofence a submission is refused by design
      // (AAP 0.5.7), and this row proves the form the venue's own code is entered into is reachable.
      await backTo(pageB, 'meetup-detail');
    },
  },
  {
    capability: 'messaging: a line is sent to the pair once both holds are locked',
    walk: async ({ pageB }) => {
      await visible(pageB, 'meetup-chat').click();
      const composer = visible(pageB, 'chat-input');
      await expect(composer).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      // The composer sends only on an open socket, so the row waits for the connection it needs.
      const send = visible(pageB, 'chat-send');
      await expect(send).toBeEnabled({ timeout: SCREEN_TIMEOUT_MS });
      await composer.fill(CHAT_LINE);
      await send.click();
      await expect(visible(pageB, 'chat-messages')).toContainText(CHAT_LINE, {
        timeout: SCREEN_TIMEOUT_MS,
      });
      await backTo(pageB, 'meetup-detail');
    },
  },
  {
    capability: 'day-plan suggestions: the attribution and an answer are on screen',
    walk: async ({ pageB }) => {
      await visible(pageB, 'meetup-suggestions').click();
      await expect(visible(pageB, 'suggestions-screen')).toBeVisible({
        timeout: SCREEN_TIMEOUT_MS,
      });
      await expect(visible(pageB, 'osm-attribution')).toContainText(OSM_ATTRIBUTION);
      // The route answers either at least one priced place or the empty reason it named, and both are
      // served states of the screen, so either proves the capability was reached (AAP 0.5.8).
      await expect
        .poll(async () => await pageB.locator(SUGGESTION_ANSWER).count(), {
          timeout: SCREEN_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);
      await backTo(pageB, 'meetup-detail');
    },
  },
  {
    capability: 'dispute: a problem report is filed and an operator closes it no_fault',
    walk: async ({ pageB, meetupId }) => {
      await visible(pageB, 'meetup-dispute').click();
      await expect(visible(pageB, 'dispute-submit')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(pageB, 'dispute-kind-other').click();
      await visible(pageB, 'dispute-reason').fill(DISPUTE_REASON);
      await visible(pageB, 'dispute-submit').click();
      await expect(visible(pageB, 'dispute-submitted')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      // An operator's own session closes it, which is what releases both holds and ends the meetup
      // (AAP 0.5.3): the queue is read and the resolution posted through the operator role, so the
      // pair is left settled and the walk leaves nothing open behind it.
      await ensureOperator();
      const queue = await operatorApi().get('/admin/disputes', AdminDisputesResponse);
      const open = queue.items.find(
        (dispute) => dispute.meetupId === meetupId && dispute.status === 'open',
      );
      if (open === undefined) {
        throw new Error('the dispute the web client filed is not in the operator queue');
      }
      await operatorApi().post(
        `/admin/disputes/${open.id}/resolve`,
        AdminDisputeDto,
        ResolveDispute.parse({ outcome: 'no_fault' }),
      );
      await expect
        .poll(async () => (await api('a').get(`/meetups/${meetupId}`, MeetupDto)).status, {
          timeout: SCREEN_TIMEOUT_MS,
        })
        .toBe('no_fault');
    },
  },
];
/*
 * Two serial groups in one file: the open walk runs on any stack, and the locked walk runs only
 * where both actors can hold a card.
 *
 * The timeout is the walk's own, not the runner's default: `ensureActors()` imports a booking through
 * the proof screen, and the harness bounds that one step at fifteen minutes because a device-scale
 * proof takes minutes, so the group that does it needs a bound that fits rather than a 30-second one.
 */
test.describe.configure({ mode: 'serial' });

test.describe('criterion 8 — every capability is reachable from navigation', () => {
  test.beforeAll(async () => {
    // The hook settles both actors in, which imports a booking through the proof screen once: it is
    // the one step of this file whose bound cannot be the runner's default.
    test.setTimeout(WALK_TIMEOUT_MS);
    await ensureActors();
    await clearPairMeetups();
    await ensureNoActiveClaim('a');
  });
  test.afterAll(async () => {
    // What the walks leave behind is cleared the way the harness prescribes, so a second run against
    // the same stack starts with no open meetup between the pair and no claim (AAP 0.5.3, 0.11.2).
    await clearPairMeetups();
    await ensureNoActiveClaim('a');
  });
  test('the capabilities that need no locked meetup', async ({ browser }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    const context = await browser.newContext({ baseURL: e2eEnv().webUrl });
    const token = trackBearer(context);
    const page = await signInViaUi(context, throwawayEmail('reach'), 'reach');
    const guest: Guest = { context, page, token };
    const { context: contextA, page: pageA } = await contextFor(browser, 'a');
    try {
      const visit: OpenVisit = { guest, pageA };
      for (const row of WITHOUT_A_LOCK) {
        await test.step(row.capability, async () => {
          await row.walk(visit);
        });
      }
    } finally {
      // The throwaway's account is gone by the last row, so its context dies with it; A's rotated
      // refresh token is carried back to the registry by the harness.
      await context.close();
      await releaseContext('a', contextA);
    }
  });
  test('the capabilities behind a locked meetup', async ({ browser }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    test.skip(e2eEnv().stripeMode !== 'test', BLOCKED_REASON);
    // Both sides of a proposal need a saved card: a hold cannot be placed without one (AAP 0.3.4).
    await ensureCard('a');
    await ensureCard('b');
    const day = await nextMeetupDay();
    const venue = await partnerVenue(provedCity('a'));
    const meetupId = await proposeThroughTheUi(browser, day, venue.id, actorInfo('b').userId);
    const { context, page } = await contextFor(browser, 'b');
    try {
      const visit: LockedVisit = { meetupId, pageB: page };
      for (const row of BEHIND_A_LOCK) {
        await test.step(row.capability, async () => {
          await row.walk(visit);
        });
      }
    } finally {
      await releaseContext('b', context);
    }
  });
});
