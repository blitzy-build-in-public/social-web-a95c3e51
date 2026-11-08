# Items pending legal review

Three items of this build must not reach production until counsel has reviewed them, and each keeps the
status phrase **Pending legal review** until counsel's written conclusion is on file. Each entry below
states what the build does, the decision still open, and the switch that applies it. To record a
conclusion: put the date, the reviewer's role, a summary of the conclusion and a reference to the
document holding it beside that item, then apply the item's switch in the same change; no item is marked
resolved without that dated reference.

| Item                                                                        | Status                   | Blocks                                           | Switch                                                       |
| --------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ | ------------------------------------------------------------ |
| Table Credit and forfeit mechanics                                          | **Pending legal review** | Captures and forfeits at real-money launch       | Code change in `apps/api/src/modules/settlement/outcomes.ts` |
| Automated voice calls in Portugal, Mexico, Colombia, Thailand and Indonesia | **Pending legal review** | Calls made in production                         | `CALLS_PRODUCTION_APPROVED=true` for the `workers` process   |
| Financial-record retention period                                           | **Pending legal review** | The production data policy for financial records | `FINANCIAL_RETENTION_DAYS` for the `workers` process         |

The three items are independent: a conclusion for one applies only that item's switch. Until then the
pilot runs with the posture its environment already enforces — Stripe in test mode wherever `APP_ENV` is
not `production`, calls reaching only `CALL_ALLOWLIST` numbers, and the retention period of item 3.

## 1. Table Credit and forfeit mechanics

**Status: Pending legal review.**

- Both attendees hold the same deposit on a card saved earlier: a manual-capture PaymentIntent
  (`capture_method: 'manual'`, confirmed from the saved card) for 5, 10 or 20 USD, always in USD. No
  money moves while a meetup is open, and a released hold costs the attendee nothing.
- At settlement, `startsAt + 45 min`, presence comes from a witnessed check-in alone, and
  `apps/api/src/modules/settlement/outcomes.ts` decides the money: both present, both holds released;
  one present, the absent attendee's hold captured and the present attendee's released and granted Table
  Credit equal to the deposit; neither present, both released.
- A cancellation less than two hours before the start is a late cancellation: the canceller's hold is
  captured and the counterpart granted Table Credit without waiting for the settlement window. Exactly
  `startsAt - 2 h` is still free.
- Table Credit is USD, redeemable at partner venues, and has no cash value. No venue redemption flow
  exists in this build, and nothing is paid out to a user or a venue.
- An operator `no_fault` resolution after a forfeit reverses the money rather than keeping it: the
  capture is fenced if it has not run, a `refund` operation reverses it against the PaymentIntent's
  actual state, and the Table Credit grant is voided.

**Alternative to review.** Forfeits retained as platform revenue instead of granted as Table Credit,
which is a code change in `apps/api/src/modules/settlement/outcomes.ts` together with the copy in
`apps/mobile/src/copy/strings.ts` and the terms screen `apps/mobile/app/legal/terms.tsx`.

**Questions for counsel.** How the hold and its capture are characterized between the two attendees;
whether Table Credit is stored value, may expire or needs consumer terms; the refund paths, including the
`no_fault` reversal above and a hold lost before settlement, which captures nothing; and the terms shown
at the age gate and on the terms screen, which state holds, forfeits, Table Credit, lost holds, disputes
and safety only.

**Interim marking.** The terms screen prints the note `Pending legal review` (`TERMS_PENDING_REVIEW_NOTE`,
`apps/mobile/src/copy/strings.ts`) above its sections, and in this build that note is not conditional on
the environment. Stripe runs in test mode in every non-production environment.

## 2. Automated voice calls (Portugal, Mexico, Colombia, Thailand, Indonesia)

**Status: Pending legal review.**

- Calls are made for two purposes only: asking a place for its menu prices (`menu_prices`) and asking a
  lodging whether a named guest is staying there (`lodging_stay_verification`). No call is ever made to
  a user.
- The first spoken line is the disclosure, in the business's own language: "Hello, this is an automated
  assistant calling on behalf of Tablemate to ask about your menu prices." or "… to confirm a guest's
  stay." Every line is a fixed template in `apps/api/src/modules/voice-agent/i18n/` (`en-US`, `pt-PT`,
  `es-US`, `th-TH`, `id-ID`) spoken through Twilio ConversationRelay; the language model only classifies
  the callee's speech and never composes an utterance, and a callee who prefers English is switched to
  `en-US` mid-call.
- Recording is off on every call, no Voice Intelligence service is attached and no audio is stored. A
  `menu_prices` transcript is kept 30 days and then deleted; a `lodging_stay_verification` transcript is
  never stored.
- A call starts only between 09:00 and 20:00 in the business's city time, at most twice per task and at
  least 24 hours apart. A request to stop ends the call (`refused`); a request never to be called again
  sets `doNotCall` on the business and cancels its other tasks.
- A lodging call speaks the guest's booking name and stay dates to reception after the user's explicit
  consent, an exception to the zero-knowledge principle that the app discloses before consent (see
  [privacy.md](./privacy.md)).

**Jurisdictions to review.** Portugal (Lisbon), Mexico (Mexico City), Colombia (Medellín), Thailand
(Chiang Mai), Indonesia (Canggu).

**Gate on production calls.** Outside production a call reaches only a number in `CALL_ALLOWLIST`
(`packages/server-core/src/telephony/allowlist.ts`), and any other number is refused with
`not_allowlisted`. In production `CALLS_PRODUCTION_APPROVED` defaults to `false`
(`packages/server-core/src/env/workers.ts`) and the guard refuses every number with
`production_calls_not_approved` until the operator sets it to `true`; that refusal keeps the task
`queued` with `blockedReason = not_allowlisted` (`apps/workers/src/calls/eligibility.ts`) and no number is
dialed.

Scripts, simulator results and the staging-call status are in [voice-agent.md](./voice-agent.md).

## 3. Financial-record retention period

**Status: Pending legal review.**

- `Meetup`, `Deposit`, `PaymentOperation`, `MeetupSettlement`, `TableCreditEntry`, `StripeEvent` and the
  `CheckIn` result and distance bucket are kept as pseudonymous financial and settlement records, linked
  to an erased account's tombstone where there was one. No coordinates and no card data are kept.
- The period is `FINANCIAL_RETENTION_DAYS` (2,557 days, seven years, configurable), measured from
  `Meetup.finalAt`. The daily step of the `data-expiry` job at 03:00 UTC purges meetups past that cut-off
  with their deposits, payment operations, settlement, credit entries, check-ins, messages and disputes;
  it unlinks the kept `WitnessEvent` and `Report` rows from the meetup, deletes its lodging activity
  facts and purges `StripeEvent` rows of the same age (`apps/workers/src/jobs/data-expiry.ts`). Report
  and resolved-dispute reason text is deleted at 180 days; an open dispute keeps its text.

**Decision needed.** The period and its legal basis in each launch country. Changing it is a
configuration change to `FINANCIAL_RETENTION_DAYS` for the `workers` process, applied by the next daily
step; no code change is needed, and the default stands until this review changes it.

The full data inventory, the encryption at rest and the erasure rules are in [privacy.md](./privacy.md).
