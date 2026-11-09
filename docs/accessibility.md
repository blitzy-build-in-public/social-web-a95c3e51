# Accessibility — WCAG 2.1 AA for the core flows

The four flows a traveler cannot get around — signing in, making a proposal, locking the commitment
and checking in at the venue — are held to WCAG 2.1 level AA. This document records the measures the
app carries, the web audit's result and the manual screen-reader checklists (AAP 0.5.8, AAP 0.12.2).

## Scope and standard

- **Flows and platforms:** sign-in, proposal, commitment lock (Accept and lock) and check-in, on
  iOS 16 or later with VoiceOver, Android 10 (API 29) or later with TalkBack, and web with a keyboard
  and a screen reader.
- **Standard and tooling:** WCAG 2.1 AA, audited with `@axe-core/playwright` over the `wcag2a`,
  `wcag2aa`, `wcag21a` and `wcag21aa` rulesets. A `serious` or `critical` violation fails the audit;
  a `minor` or `moderate` one is recorded and left standing.
- **Web audit:** `apps/mobile/e2e/playwright/a11y-core-flows.spec.ts`, in the Playwright Chromium
  project, where every step after the first load is something a traveler taps. The mobile checks are
  performed by hand against the two checklists below.
- **Status words:** `pass`, `fail`, `pending` or `blocked`. A `pass` is recorded only after a run or
  a completed manual check, with its date, commit and tester role.
- **What automation cannot reach:** axe judges rendered markup, not speech, focus order, text scaling
  or whether a message is carried by colour alone.

## Implemented measures

- **Names and roles.** `Button` is a `button` whose accessible name is its visible label, reporting
  itself disabled or busy while keeping that label. A `ListItem` row with `onPress` is a `link` when
  it navigates and a `button` otherwise, named by its own visible text — it sets no `aria-label`, so
  its name always contains what the row shows (WCAG 2.5.3). `TextField` always renders its label,
  never as a placeholder, and that label is the input's accessible name.
- **Structure and order.** `Screen` renders the page heading first, as a level-1 heading, and the
  proposal's venue and deposit groups are `radiogroup`s whose options are `radio`s with
  `aria-checked`. Controls follow source order: a banner reads title, message, content, action;
  Propose reads the deposit copy, then the safety notice, then the submit button; the lock screen
  reads the same two, then Accept and Decline — so the framing copy and the "Your deposit is not a
  safety guarantee." notice always precede the action they qualify.
- **Errors are spoken.** `announce()` in `src/ui/Banner.tsx` calls
  `AccessibilityInfo.announceForAccessibility` on iOS and Android, drops an immediate repeat of the
  same sentence, and does nothing elsewhere. Sign-in, Propose, the lock screen and check-in call it
  with the app's own copy for the error code, never server text, a token or coordinates.
- **Live regions and field errors.** A `Banner`'s title and message share one live region —
  `aria-live="assertive"` with `role="alert"` for the error tone, `aria-live="polite"` with
  `role="status"` for the rest — stopping before the banner's action, so a change re-announces the
  notice rather than the button beside it; `aria-live` is also what Android renders its live region
  from. A field's error sits below the input, is bound to it (`aria-describedby`, `aria-invalid` on
  web, `accessibilityHint` on native) and prefixed with "Error:", and is a live region on web alone.
- **Touch targets and scaling.** `MIN_TOUCH_TARGET` (44) floors every control — a 44-wide, 44-tall
  button minimum, a 44-tall input, a 44-tall list row — and no control has a fixed height. Type roles
  are scalable base sizes (`caption` 14, `body` and `label` 16, `title` 20, `heading` 24, `display`
  32), font scaling stays on, and only `caption` sits below the 16-point body size, never as a control
  label.
- **Contrast.** `CONTRAST_PAIRS` records every text pair a primitive paints, all at or above 4.5:1:
  `text` on `background` 17.21 and on `surface` 15.52, `textMuted` on `background` 7.07 and on
  `surface` 6.38, `onPrimary` on `primary` 7.3, `primary` on `background` 7.3, `danger` on
  `background` 6.47 and on `surface` 5.83, `onDanger` on `danger` 6.47, `success` on `surface` 6.43,
  `warning` on `surface` 6.39. `NON_TEXT_CONTRAST_PAIRS` records what is not text, all at or above
  3:1 (WCAG 1.4.11): `border` on `background` 3.7 and on `surface` 3.34, `focusRing` on `background`
  6.7 and on `surface` 6.04.
- **Keyboard on web.** Every control is a real focusable element, and the visible focus indicator is
  the reserved 2 px control border painted in `colors.focusRing`, each primitive suppressing the
  browser's own outline. The proposal options keep `role="radio"` and take the Space key from an
  explicit handler, because the web runtime answers Space only for a native button.
- **Nothing by colour alone (WCAG 1.4.1).** A banner given no title of its own renders the visible
  word "Error" or "Warning", a field error carries the "Error:" prefix, and a status colour is always
  paired with text.
- **Check-in.** Time left is written as text, never by colour: "Check-in opens in N minutes.",
  "N minutes left to check in.", "Check-in opens in less than a minute.", "Check-in has closed." The
  six-digit field takes the numeric keyboard and keeps the selection menu, so a code can be pasted,
  and accepts one-time-code autofill. The venue's code is re-readable at any time and three
  consecutive minute steps are accepted, so the one-minute rotation costs the user nothing, and a code
  entered offline is held for at most 60 seconds. A code filled by scan, an unrecognised QR, the
  offline hold and an expired code are each announced.

## Automated results (web, axe)

Serious, Critical and Other are the counts of violating rules at that impact. A run passes when it
reports no serious and no critical violation.

| Flow     | Screen                                                     | Serious | Critical | Other | Result                                       | Date       | Commit  |
| -------- | ---------------------------------------------------------- | ------- | -------- | ----- | -------------------------------------------- | ---------- | ------- |
| Sign-in  | `app/(auth)/sign-in.tsx` · `/sign-in`                      | 0       | 0        | 0     | pass                                         | 2026-11-09 | 33bb261 |
| Sign-in  | `app/(auth)/age-gate.tsx` · `/age-gate` (first sign-in)    | 0       | 0        | 0     | pass                                         | 2026-11-09 | 33bb261 |
| Proposal | `app/meetups/propose.tsx` · `/meetups/propose`             | 0       | 0        | 0     | pass                                         | 2026-11-09 | 33bb261 |
| Lock     | `app/meetups/[id]/index.tsx` · `/meetups/<id>`, Accept     | —       | —        | —     | Blocked — Stripe test-mode keys not supplied | —          | —       |
| Check-in | `app/meetups/[id]/check-in.tsx` · `/meetups/<id>/check-in` | —       | —        | —     | Blocked — Stripe test-mode keys not supplied | —          | —       |

The age-gate screen is audited inside the sign-in flow's test: the first sign-in passes through it
before any feature is reachable.

How this table is filled:

- Each audited screen writes `.local/e2e/a11y/<screen>.json` — `sign-in`, `age-gate`, `proposal`,
  `lock`, `check-in` — holding the screen, its path, `ranAt`, the count of passing rules, and every
  violation's id, impact, node count and help text. No page text, handle or token is recorded.
- Result is `pass` when that run reported no serious or critical violation and `fail` when it did;
  Date and Commit are the audit's date and the short commit it ran on. A `fail` row lists each
  violation id with its impact under the table, and the check is fixed before the row reads `pass`.
- Lock and check-in need a stack holding Stripe test-mode keys, because both screens require a
  meetup whose deposit decision is durable. Without those keys the spec skips that test itself, with
  its `BLOCKED_REASON` sentence, and the two rows carry it: "Blocked — Stripe test-mode keys
  not supplied". A skipped screen writes no such record. The result reaches
  `docs/acceptance.md` as the `e2e` block's one `wcag` cell, "WCAG 2.1 AA — axe on core flows",
  written by `scripts/e2e.ts` from whether the spec passed — no cell per screen, and the script
  reads no record. A row still to be run reads `pending` — "Pending — `pnpm test:e2e` not yet run".

## Manual screen-reader checklist

Run with VoiceOver on iOS 16 or later and with TalkBack on Android 10 or later, on a build of the app
running against a stack with test-mode keys, on the device or emulator named in the footer. Every
cell holds `pass`, `fail`, `pending` or `blocked`; a failing check names the screen and what was heard.

### VoiceOver — iOS 16 or later

| Check                                                                                                       | Sign-in | Proposal | Lock    | Check-in |
| ----------------------------------------------------------------------------------------------------------- | ------- | -------- | ------- | -------- |
| Every control announced with its label and role                                                             | pending | pending  | pending | pending  |
| Focus order matches visual order                                                                            | pending | pending  | pending | pending  |
| Errors announced when they appear                                                                           | pending | pending  | pending | pending  |
| Deposit copy and the "Your deposit is not a safety guarantee." notice read before the submit or lock button | pending | pending  | pending | pending  |
| Time left in the check-in window announced as text                                                          | pending | pending  | pending | pending  |
| Code field accepts a pasted code                                                                            | pending | pending  | pending | pending  |
| Controls operable at the largest system font size                                                           | pending | pending  | pending | pending  |
| No information conveyed by colour alone                                                                     | pending | pending  | pending | pending  |

### TalkBack — Android 10 or later

| Check                                                                                                       | Sign-in | Proposal | Lock    | Check-in |
| ----------------------------------------------------------------------------------------------------------- | ------- | -------- | ------- | -------- |
| Every control announced with its label and role                                                             | pending | pending  | pending | pending  |
| Focus order matches visual order                                                                            | pending | pending  | pending | pending  |
| Errors announced when they appear                                                                           | pending | pending  | pending | pending  |
| Deposit copy and the "Your deposit is not a safety guarantee." notice read before the submit or lock button | pending | pending  | pending | pending  |
| Time left in the check-in window announced as text                                                          | pending | pending  | pending | pending  |
| Code field accepts a pasted code                                                                            | pending | pending  | pending | pending  |
| Controls operable at the largest system font size                                                           | pending | pending  | pending | pending  |
| No information conveyed by colour alone                                                                     | pending | pending  | pending | pending  |

### Result footer

Device, OS version, app build id and tester role are recorded once per platform, and one date per
completed column. A cell without a completed check reads `pending`; the dates cell lists the four
columns in the order sign-in, proposal, lock, check-in.

| Platform           | Device model | OS version | App build id | Tester role | Dates (sign-in · proposal · lock · check-in) |
| ------------------ | ------------ | ---------- | ------------ | ----------- | -------------------------------------------- |
| iOS (VoiceOver)    | pending      | pending    | pending      | pending     | pending                                      |
| Android (TalkBack) | pending      | pending    | pending      | pending     | pending                                      |

The builds these checks run on are development or internal builds; the app is not submitted to
either store, so no result here comes from a store build.
