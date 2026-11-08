# The automated phone agent

What Tablemate's automated calls say, in which language, under which rules, and what the scripted
telephony simulator has measured (AAP 0.5.6, 0.12.1).

The agent calls businesses only: a place about its menu prices, a lodging about whether a named guest
is staying there. It never calls a user, and it calls for no other purpose. Twilio Programmable Voice
carries the call and ConversationRelay streams speech both ways: `apps/api`'s `modules/voice-agent`
runs the dialogue in the relay socket it terminates, while `apps/workers` decides whether a task may be
dialed and applies each result to the task and, for a stay call, to its lodging claim (AAP 0.3.2, 0.5.3).

## Status

| Item                                                                                                                  | Status                                             | Where it stands                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal review of automated voice, recording and disclosure rules in Portugal, Mexico, Colombia, Thailand and Indonesia | **Pending legal review**                           | Production calls stay disabled until `CALLS_PRODUCTION_APPROVED=true` is set; see [legal-review.md](./legal-review.md)                                        |
| Scripted simulator results                                                                                            | see [Simulator results](#simulator-results)        | every scenario below is played by the simulator; no scenario is recorded as passing without a run                                                             |
| One real staging call per task kind                                                                                   | **Staging calls pending — simulator results only** | needs Twilio credentials, a voice-capable `TWILIO_FROM_NUMBER`, an operator-owned number in `CALL_ALLOWLIST` and a public HTTPS `API_PUBLIC_URL` (AAP 0.12.3) |
| `es-US` recognition in Mexico City and Medellín                                                                       | **Pending**                                        | `es-MX` and `es-CO` are not ConversationRelay defaults, so both cities open in `es-US`; only the staging call confirms how it is recognized                   |
| Voice recordings and audio                                                                                            | No audio stored anywhere                           | Twilio recording is off, no Voice Intelligence service is attached, and `menu_prices` transcripts are the only speech kept, for 30 days                       |

## Languages

Each city's `callLanguage` comes from `config/cities.json`, and the relay speaks and transcribes it
with the pairing named beside it (`apps/api/src/modules/voice-agent/twiml.ts`):

| City        | `callLanguage` | Text-to-speech | Transcription             |
| ----------- | -------------- | -------------- | ------------------------- |
| Lisbon      | `pt-PT`        | Google         | Deepgram `nova-3-general` |
| Mexico City | `es-US`        | ElevenLabs     | Deepgram `nova-3-general` |
| Medellín    | `es-US`        | ElevenLabs     | Deepgram `nova-3-general` |
| Chiang Mai  | `th-TH`        | Google         | Deepgram `nova-2-general` |
| Canggu      | `id-ID`        | ElevenLabs     | Deepgram `nova-3-general` |

Every call also carries an `en-US` entry. When the classifier hears a callee ask for English or answer
in it, the relay sends a ConversationRelay `language` message for `en-US` and speaks
`switch.english` in the language the call was in, so the question and its answer never fall on
different languages mid-turn. `en-US` itself is spoken by ElevenLabs and transcribed with Deepgram
`nova-3-general`.

`es-MX` and `es-CO` are not ConversationRelay speech pairings, so Latin American Spanish uses `es-US`
for Mexico City and Medellín; only the staging call establishes how well it recognizes those callers.

## What the call says

Every spoken line is a template key of `apps/api/src/modules/voice-agent/i18n/*.json` — one file per
language, all five carrying the same 15 keys, which `dialogue.ts` asserts as the module loads. The
language model never composes an utterance; it only classifies what the callee said. The lines quoted
below are copied from those built files.

### The disclosure greeting, always first

`twiml.ts` sends the greeting as the ConversationRelay `welcomeGreeting` and the session speaks it as
its first line, so the callee learns the call is automated before anything is asked, in the city's own language.

| Language | `greeting.menu_prices`                                                                                                 | `greeting.lodging_stay_verification`                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `en-US`  | "Hello, this is an automated assistant calling on behalf of Tablemate to ask about your menu prices."                  | "Hello, this is an automated assistant calling on behalf of Tablemate to confirm a guest's stay."                    |
| `pt-PT`  | "Olá, fala um assistente automático que liga em nome da Tablemate para saber os preços da vossa ementa."               | "Olá, fala um assistente automático que liga em nome da Tablemate para confirmar a estadia de um hóspede."           |
| `es-US`  | "Hola, le habla un asistente automatizado que llama en nombre de Tablemate para preguntar por los precios de su menú." | "Hola, le habla un asistente automatizado que llama en nombre de Tablemate para confirmar la estadía de un huésped." |
| `th-TH`  | "สวัสดีค่ะ นี่คือผู้ช่วยอัตโนมัติที่โทรมาในนามของ Tablemate เพื่อสอบถามราคาอาหารในเมนูของร้านค่ะ"                      | "สวัสดีค่ะ นี่คือผู้ช่วยอัตโนมัติที่โทรมาในนามของ Tablemate เพื่อยืนยันการเข้าพักของแขกท่านหนึ่งค่ะ"                 |
| `id-ID`  | "Halo, ini asisten otomatis yang menelepon atas nama Tablemate untuk menanyakan harga menu Anda."                      | "Halo, ini asisten otomatis yang menelepon atas nama Tablemate untuk mengonfirmasi masa menginap seorang tamu."      |

### The `menu_prices` script

Three steps, in this order, each answer read back and confirmed before it counts: the cheapest main
course with its price, the most expensive main course with its price, then the price of a coffee or a
beer. An answer that carries no price is asked again, and one that carries a dish but no price leaves
that item unconfirmed — which is what makes such a call `low` confidence rather than a stored guess.

The question of each step, per language:

- **`en-US`** — `ask.cheapest_main`: "What is your cheapest main course, and how much does it cost?" · `ask.priciest_main`: "And what is your most expensive main course, and how much does it cost?" · `ask.coffee_or_beer`: "Lastly, how much is a coffee or a beer?"
- **`pt-PT`** — `ask.cheapest_main`: "Qual é o vosso prato principal mais barato e quanto custa?" · `ask.priciest_main`: "E qual é o vosso prato principal mais caro e quanto custa?" · `ask.coffee_or_beer`: "Por último, quanto custa um café ou uma cerveja?"
- **`es-US`** — `ask.cheapest_main`: "¿Cuál es su plato principal más económico y cuánto cuesta?" · `ask.priciest_main`: "¿Y cuál es su plato principal más caro y cuánto cuesta?" · `ask.coffee_or_beer`: "Por último, ¿cuánto cuesta un café o una cerveza?"
- **`th-TH`** — `ask.cheapest_main`: "อาหารจานหลักที่ราคาถูกที่สุดของร้านคือเมนูอะไร และราคาเท่าไรคะ" · `ask.priciest_main`: "แล้วอาหารจานหลักที่ราคาแพงที่สุดของร้านคือเมนูอะไร และราคาเท่าไรคะ" · `ask.coffee_or_beer`: "สุดท้ายนี้ กาแฟหรือเบียร์ราคาเท่าไรคะ"
- **`id-ID`** — `ask.cheapest_main`: "Apa hidangan utama Anda yang paling murah, dan berapa harganya?" · `ask.priciest_main`: "Lalu, apa hidangan utama Anda yang paling mahal, dan berapa harganya?" · `ask.coffee_or_beer`: "Terakhir, berapa harga kopi atau bir?"

### The `lodging_stay_verification` script

One question, and nothing else about the guest: whether a guest named `<bookingName>` is staying from
`<stayFrom>` to `<stayTo>`. The handle, the app account and the booking reference are never spoken. Its
read-back restates the question and asks for an explicit answer, so a confirmed no rejects a claim as
firmly as a confirmed yes verifies one. The stay dates are formatted in the call's own language — Thai
uses the Buddhist calendar year its reception staff read.

- **`en-US`** — `ask.stay`: "Is a guest named {bookingName} staying with you from {stayFrom} to {stayTo}?"
- **`pt-PT`** — `ask.stay`: "Têm um hóspede com o nome {bookingName} alojado convosco de {stayFrom} a {stayTo}?"
- **`es-US`** — `ask.stay`: "¿Tienen hospedado a un huésped con el nombre {bookingName} del {stayFrom} al {stayTo}?"
- **`th-TH`** — `ask.stay`: "มีแขกชื่อ {bookingName} เข้าพักที่นี่ตั้งแต่วันที่ {stayFrom} ถึงวันที่ {stayTo} ใช่ไหมคะ"
- **`id-ID`** — `ask.stay`: "Apakah ada tamu atas nama {bookingName} yang menginap di tempat Anda dari tanggal {stayFrom} sampai tanggal {stayTo}?"

### Read-backs, prompts and closings

Shared by both kinds, each in the five language files; the `en-US` text is quoted here.

| Key                   | Spoken line (`en-US`)                                                                                                    | When                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `readback.price`      | "I have {dish} at {price}."                                                                                              | after a priced answer, before it is confirmed |
| `readback.stay`       | "Just to be sure: is a guest named {bookingName} staying with you from {stayFrom} to {stayTo}? Please answer yes or no." | after a stay answer, before it is confirmed   |
| `confirm.prompt`      | "Is that correct?"                                                                                                       | after every read-back                         |
| `retry.unclear`       | "Sorry, I didn't catch that. Could you please repeat?"                                                                   | when an answer cannot be classified           |
| `switch.english`      | "Of course, let's continue in English."                                                                                  | when the callee prefers or speaks English     |
| `closing.thanks`      | "Thank you very much for your help. Goodbye."                                                                            | a call whose steps are done                   |
| `closing.refused`     | "No problem, sorry to have bothered you. Goodbye."                                                                       | the callee asked for a person or to stop      |
| `closing.do_not_call` | "Understood. We will not call you again. Goodbye."                                                                       | the callee asked never to be called again     |
| `closing.budget`      | "Thank you for your time. We will follow up another way. Goodbye."                                                       | the call's dialogue budget is used up         |

### Understanding

`understanding.ts` gives the model one job: classify the callee's latest utterance into exactly one
label — `price`, `dish`, `yes`, `no`, `prefers_english`, `wants_human`, `stop`, `do_not_call` or
`unclear` — and extract the values that were actually said, under a strict JSON schema. A price is kept
as the callee's own words; the model may neither invent, round nor convert one. `yes` and `no` carry a
confirmation, and `prefers_english`, `wants_human`, `stop` and `do_not_call` are acted on rather than
answered.

Each turn has a 3-second deadline, shared by the input-token count and the send. A booking name is
replaced in the classification window before anything is sent, so the name does not reach the provider
as speech. A classification that fails or times out speaks the relevant closing line and ends the call
politely; the task keeps its place and is retried, and no other route is touched.

## Call rules

### Whether a task may be dialed

`apps/workers/src/calls/eligibility.ts` answers six questions in this order, and the order is part of
the rule: a safety refusal is decided before any scheduling question.

1. Is the target marked `doNotCall`? No task of any kind calls a `doNotCall` number, and a number
   another place or lodging has opted out of is the same refusal. The task goes to the operator queue
   as `unreachable` with `blockedReason = do_not_call`.
2. Does a phone number exist? Without one the task is `unreachable` with `blockedReason = no_phone`.
3. May Tablemate dial that number at all? Outside production only `CALL_ALLOWLIST` numbers are dialed,
   and in production `CALLS_PRODUCTION_APPROVED` gates every call. A refusal keeps the task `queued`
   with `blockedReason = not_allowlisted`.
4. Has the task spent its two attempts (`CALL_MAX_ATTEMPTS`)? It waits 24 hours.
5. Is the last attempt at least 24 hours old (`CALL_RETRY_SPACING_HOURS`)? It waits for the spacing.
6. Is it inside calling hours? A call starts only if `now >= 09:00` and `now + CAP_CALL_SECONDS <=
20:00` in the business's own city time; otherwise it is deferred to the next 09:00 local. With a
   300-second cap, a 19:55:00 start is allowed and 19:55:01 is not.

A dispatch that ends in a definite vendor rejection before the call exists — a refused connection, or a
Twilio 4xx — is not counted as an attempt: it releases the reserved slot, records the attempt as
`dispatch_failed`, adds one `vendorFailures` and requeues the task after `60 s × 2^(vendorFailures − 1)`,
at most 8 times before the task joins the operator queue as `needs_review` with
`blockedReason = vendor_unavailable`. A dispatch whose outcome is ambiguous is never redialled; it is
resolved as described in [operations.md](./operations.md).

### Twilio parameters

Every outbound call is created with `timeLimit` = `CAP_CALL_SECONDS` (300) so no call exceeds five
minutes, `record: false`, machine detection on, and `statusCallbackEvent` limited to `initiated`,
`ringing`, `answered` and `completed`. The TwiML URL and the status-callback URL both carry the
`CallAttempt` id, which is the only evidence accepted for a call whose create answer was lost. No
Voice Intelligence service is attached and no audio is stored; a machine answer is hung up on and
recorded as unanswered.

### Caps

- **Calls:** `CAP_CALLS_PER_CITY_DAY` (40) per city per local day, reserved by one conditional update
  that only claims a slot while the day's count is below the cap. The 41st task of a city's local day
  keeps its status and moves to 09:00 local the next day.
- **Dialogue spend:** a call's whole worst-case dialogue — `LLM_MAX_TURNS_PER_CALL` (60) turns of the
  largest counted classification turn — is reserved before it is dialed and stored on the attempt. A
  call whose budget cannot be reserved is not dialed, and every turn is sent only while its own counted
  bound fits what is left, so the city's `CAP_LLM_USD_PER_CITY_DAY` (25 USD) cannot be crossed mid-call.
  A call whose next turn does not fit hears `closing.budget` and ends as `needs_review` with the data it
  already confirmed.
- **Relay sessions:** at most `VOICE_RELAY_MAX_SESSIONS` (10) concurrent relay sessions per API
  instance; a further upgrade is refused, which Twilio reports as a failed call.

### Outcomes

| Twilio final status, or what the dialogue reached                                          | Attempt outcome and confidence                  | Task and claim                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Answered; every value confirmed on read-back                                               | `completed`, `high`                             | `completed`: menu prices stored with `source = phone_quote`, or the claim `verified` / `rejected`             |
| Confirmed values mixed with partial or unparsed ones, or a call dropped before it finished | `completed` or `needs_review`, `low`            | `needs_review`; menu prices stored `needs_review` and left out of suggestions until an operator approves them |
| `busy`, `no-answer`, `canceled`, or `failed` on a number that may exist                    | `no_answer`                                     | `queued` again, `nextAttemptAt` = attempt end + 24 h; the second `no_answer` makes it `unreachable`           |
| Answering machine detected                                                                 | `no_answer`                                     | as above: the call is hung up on and retried once                                                             |
| `failed` because the destination number cannot exist                                       | `unreachable`, `blockedReason = invalid_number` | `unreachable`; the operator queue                                                                             |
| Callee asked to speak to a person, or to stop                                              | `refused`                                       | `refused`                                                                                                     |
| Callee asked never to be called again                                                      | `do_not_call`                                   | `do_not_call`: `doNotCall` is set on the place or lodging and its other tasks are cancelled                   |
| Definite vendor rejection before the call exists                                           | `dispatch_failed`                               | `queued` with vendor backoff; the two-attempt allowance is untouched                                          |
| Ambiguous dispatch outcome                                                                 | `dispatch_unknown`                              | `needs_review`, never redialled                                                                               |

A task cancelled while its call is live ends differently: the relay speaks the relevant closing line and
sends ConversationRelay `end`, the attempt is marked superseded, and any result that arrives afterwards
is recorded on the attempt alone and never applied. A lodging claim leaves `calling` only while an
attempt may genuinely be live, so `409 call_in_progress` while the claim is being called means what it
says.

### What a call may keep

| Item                                  | `menu_prices`                                                                    | `lodging_stay_verification`                                                |
| ------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `high` confidence                     | every value was confirmed on read-back and parsed unambiguously                  | an explicit yes or no, confirmed                                           |
| `low` confidence                      | anything else: the items are stored `needs_review` and excluded from suggestions | anything else: the claim joins the operator queue                          |
| Transcript                            | kept for 30 days, then deleted                                                   | never stored                                                               |
| Outcome, extracted fields and summary | kept for 365 days for call, cap and spend metrics                                | exist only until the claim resolves, then erased with the booking details  |
| Booking name and reference            | not applicable                                                                   | used for the call, encrypted at rest, erased within 24 hours of resolution |

## Simulator results

The scripted telephony simulator (`apps/api/test/support/voice-simulator/`) plays Twilio's part — it
fetches the TwiML, opens the relay socket, sends `prompt` frames from a scenario file and posts signed
status callbacks — so each row below is a dialogue run through the real relay, the real classification
path and the real task transitions, with `LLM_PROVIDER=fake` and `TELEPHONY_MODE=simulator`.

Run on 2026-11-08 at commit `cfabac5`: five suites passed — 40 unit tests in
`apps/api/test/unit/voice-dialogue.test.ts`, 37 integration tests in
`apps/api/test/integration/webhooks-voice.test.ts`, and 26 across
`apps/workers/test/integration/call-dispatch.test.ts`, `tests/system/phone-fallback.test.ts`,
`tests/system/lodging-verification.test.ts` and `tests/system/caps-and-isolation.test.ts`.

| Scenario             | What it exercises                                                                                                                                                  | Test file                                                                                                     | Result  | Date       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| `prices-high`        | a call whose three values are each confirmed on read-back: `high` confidence, `phone_quote` records, a transcript kept 30 days                                     | `apps/api/test/integration/webhooks-voice.test.ts`, `tests/system/phone-fallback.test.ts`                     | pass    | 2026-11-08 |
| `prices-low`         | a partial call: a dish named without a price, so the attempt is `low` and its items unconfirmed                                                                    | `apps/api/test/integration/webhooks-voice.test.ts`                                                            | pass    | 2026-11-08 |
| `yes`                | a stay call reception confirms: `high` confidence, claim `verified`                                                                                                | `apps/api/test/integration/webhooks-voice.test.ts`, `tests/system/lodging-verification.test.ts`               | pass    | 2026-11-08 |
| `no`                 | a stay call reception denies: `high` confidence, claim `rejected` on a confirmed no                                                                                | `apps/api/test/integration/webhooks-voice.test.ts`, `tests/system/lodging-verification.test.ts`               | pass    | 2026-11-08 |
| `no-answer`          | an unanswered attempt: `no_answer`, the task requeued a day later, and `unreachable` after the second                                                              | `apps/workers/test/integration/call-dispatch.test.ts`, `tests/system/phone-fallback.test.ts`                  | pass    | 2026-11-08 |
| `busy`               | a busy line: `no_answer` from the final status, and a city day held at its cap where the default scenario keeps each dialed call free of dialogue turns            | `apps/api/test/integration/webhooks-voice.test.ts`, `tests/system/caps-and-isolation.test.ts`                 | pass    | 2026-11-08 |
| `drop-mid-script`    | a call dropped after one item: `needs_review`, `low`, no invented value                                                                                            | `apps/api/test/unit/voice-dialogue.test.ts` (its dropped-mid-script row)                                      | pass    | 2026-11-08 |
| `stop`               | a callee asking to stop: `closing.refused` spoken, ConversationRelay `end`, outcome `refused`                                                                      | `apps/api/test/integration/webhooks-voice.test.ts`                                                            | pass    | 2026-11-08 |
| `do-not-call`        | a request never to be called again: `closing.do_not_call`, `doNotCall` set, the target's other tasks cancelled                                                     | `apps/api/test/integration/webhooks-voice.test.ts`, `tests/system/phone-fallback.test.ts`                     | pass    | 2026-11-08 |
| `english-switch`     | a mid-call switch: the `language` frame to `en-US`, `switch.english` spoken, the dialogue continuing in English                                                    | `apps/api/test/integration/webhooks-voice.test.ts`                                                            | pass    | 2026-11-08 |
| `budget-exhaustion`  | a dialogue that never progresses: the turn that does not fit the reservation hears `closing.budget`, and the unused budget is released                             | `apps/api/test/integration/webhooks-voice.test.ts`                                                            | pass    | 2026-11-08 |
| `vendor-down`        | Twilio refusing the connection before a call exists: the slot released, the two-call allowance kept, the task requeued with backoff, and the meetup flow untouched | `apps/workers/test/integration/call-dispatch.test.ts`, `tests/system/caps-and-isolation.test.ts`              | pass    | 2026-11-08 |
| `machine`            | an answering machine: the TwiML fetch answered `<Hangup/>` and the call recorded unanswered                                                                        | `apps/api/test/integration/webhooks-voice.test.ts`                                                            | pass    | 2026-11-08 |
| `drop-before-prompt` | a call that ends before any answer                                                                                                                                 | parsed by `loadScenarios()` in every suite that builds the simulator; no suite plays this scenario yet        | pending | —          |
| `wants-human`        | a callee asking for a person: `closing.refused` and outcome `refused`                                                                                              | the label-to-closing mapping in `apps/api/test/unit/voice-dialogue.test.ts`; no suite plays this scenario yet | pending | —          |

## Staging calls

One real call per task kind, to an operator-owned number, is what turns the simulator evidence above
into evidence about the vendor (AAP 0.12.3). It needs Twilio credentials, a voice-capable
`TWILIO_FROM_NUMBER`, that number in `CALL_ALLOWLIST`, and a public HTTPS `API_PUBLIC_URL` for the
TwiML, relay and status callbacks. Numbers are never written down here.

| Task kind                   | Language                  | Number                            | Result                                             | Notes                                                                                  | Date |
| --------------------------- | ------------------------- | --------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- | ---- |
| `menu_prices`               | the city's `callLanguage` | operator-owned allowlisted number | **Staging calls pending — simulator results only** | to be made once the credentials and a public HTTPS base URL exist                      | —    |
| `lodging_stay_verification` | the city's `callLanguage` | operator-owned allowlisted number | **Staging calls pending — simulator results only** | as above; the call confirms the stay question reads naturally aloud                    | —    |
| `es-US` recognition check   | `es-US`                   | operator-owned allowlisted number | **Pending**                                        | the one check that settles how Mexican and Colombian callers are recognized in `es-US` | —    |

## Reproduce

```bash
pnpm exec vitest run --project unit apps/api/test/unit/voice-dialogue.test.ts
pnpm exec vitest run --project integration apps/api/test/integration/webhooks-voice.test.ts \
  apps/workers/test/integration/call-dispatch.test.ts tests/system/phone-fallback.test.ts \
  tests/system/lodging-verification.test.ts tests/system/caps-and-isolation.test.ts
```

The integration project starts its own PostgreSQL, Redis and Stripe mock containers, so no stack has to
be running first. A staging call is placed against a stack started with `TELEPHONY_MODE=twilio`, the
Twilio variables set and a public HTTPS `API_PUBLIC_URL`; its result belongs in the table above.
