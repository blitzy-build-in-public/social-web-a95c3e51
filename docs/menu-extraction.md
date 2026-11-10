# Menu extraction

What the menu pipeline reads, what it refuses to read, and what criterion 11 measured on the labeled
set (AAP 0.5.6, 0.12.1). The pipeline is `apps/workers/src/menus/` plus the `menu-ingest` job that runs
it, and `apps/workers/eval/menus-eval.ts` measures the fixture menus through that same code and writes
the results block at the end of this document.

## Status

| Item                                   | Status                                            | Where it stands                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture set (20 labeled menus)         | see [Criterion 11 results](#criterion-11-results) | 20 fictional menus, 4 per language, 6 HTML, 7 PDF and 7 images, 202 labeled priced items                                                                  |
| Real launch-city menus                 | **Unverified — fixture set only**                 | no real menu with labels has been supplied, so accuracy on real launch-city menus is unmeasured (AAP 0.12.3)                                              |
| Token-count evidence for the spend cap | pending                                           | recorded per request in the block below; pending until `LLM_PROVIDER=openai`, a supported model and a provider key are configured (AAP 0.5.6, AAP 0.12.3) |

## Pipeline

### Crawl policy

- `robots.txt` is fetched per origin and cached 24 hours. RFC 9309 decides the rest: a 4xx answer means
  the site restricts nothing, an unreachable or 5xx answer disallows everything, and a served file is
  evaluated for `TablemateBot` with the `*` group as fallback. A disallowed path is skipped.
- Every request takes a slot from a per-domain throttle first: a `SET … PX 1000 NX` key on the request
  host's registrable domain, so a site and its subdomains share one slot and see at most one request per
  second. The user agent is `TablemateBot/1.0 (+<CRAWLER_CONTACT_URL>)`.
- `config/crawl-blocklist.json` names 37 aggregator, delivery and review domains; a blocklisted domain
  or a subdomain of one is `prohibited` and outranks an earlier operator decision. A fetch also stops on
  a 401 or 403 answer, a password field or a login path.
- Site terms are never read automatically, because phrase matching over a terms page cannot establish
  permission. A domain with no decision is recorded `uncertain` / `awaiting_review` before its first
  menu fetch and is not fetched while it stays so; `GET /v1/admin/crawl-domains` lists it, and only an
  operator's `PATCH /v1/admin/crawl-domains/:domain` makes it `allowed`. A host that is itself a public
  suffix is `prohibited`, and both non-`allowed` decisions take the phone fallback below.

### Request safety and resource bounds

`safe-fetch.ts` is the only place a request is made — the entry page, each redirect target, each
followed menu document, each browser subrequest and each `robots.txt` — so the blocklist, the site-terms
decision and `robots.txt` are checked on every hop, never only on the URL the crawl started from.

- `http` and `https` on ports 80 and 443 only, and the host is resolved once with the request then
  connecting to the validated address, so no later DNS answer can point it at a private one. Loopback,
  private, link-local (the cloud metadata address included), carrier-grade NAT, multicast, unique-local
  IPv6 and unspecified addresses are refused.
- At most 5 redirects, each validated exactly like the entry URL.
- The browser context blocks service workers and closes WebSockets, and every page request and
  subrequest is fulfilled through `safe-fetch`, which owns the connection. Image, media and font
  subresources are refused without a fetch: a menu image is followed deliberately instead, at most 20
  per page.
- Per response: 10 MiB of HTML or image, 20 MiB of PDF, 512 KiB of `robots.txt`. Per place: 30 MiB of
  bodies and 50 requests in total, whichever comes first, and 30 seconds per hop.
- `CRAWL_ALLOW_PRIVATE_HOSTS` exempts named hosts from the address check, and only when `APP_ENV=test`,
  which is what lets the evaluation serve its own fixtures over loopback.

### Text extraction

- Playwright renders the page and its visible text is read as rendered, so a JavaScript-rendered menu is
  read in full. Up to 500 anchors are examined for same-domain links whose text or decoded URL matches
  `menu|cardápio|carta|เมนู|daftar menu`.
- A PDF's text layer is read with `pdfjs-dist` 6.5.438, its first 20 pages; a PDF with no text layer is
  rasterized page by page with `pdftoppm` and each page is OCR'd.
- Images are re-encoded with `sharp` — refused above 25,000,000 pixels, before a pixel is decoded — and
  read by the native Tesseract 5 command line, 60 seconds per image, with `-l <city language>+eng` over
  the `tessdata_best` models for `eng`, `por`, `spa`, `tha` and `ind`. The native CLI replaces
  `tesseract.js`, whose Node 22 path aborts on a `tessdata_best` model.

### Structured extraction

- Each chunk is one language-model request under a strict JSON schema:
  `{ items: [{ name, category, priceText, currency, alcoholic, perPerson, ticketType }] }`. Every key is
  required and nullable, `additionalProperties` is `false`, and `priceText` is copied verbatim.
- `perPerson` and `ticketType` (`standard`, `concession`, `group`) are set on a `ticket` price and null
  on every other category, because the day-plan estimate reads whole standard tickets. An item the
  shared schema rejects is dropped rather than stored half-described.
- One place is bounded to 3 chunks of 60,000 characters, `max_output_tokens` 16,000 per chunk and one
  60-second deadline per chunk covering its count and its send together. Text past the third chunk is
  dropped, which usually leaves such a place on the phone fallback.

### Source gate — no invented prices

- The only normalization is whitespace: every Unicode whitespace run collapses to one space and the
  result is trimmed, so a price restated with an ordinary space still matches a source written with a
  no-break space.
- An item survives only when its normalized `priceText` occurs in the normalized source text and
  `price-parse.ts` parses that same substring to exactly one positive amount in the currency the source
  declares; everything else is dropped and counted as `not_in_source` or `unparseable`.
- The parser reads both decimal conventions (`1.234,50`, `1,234.50`), space groups (`25 000`), currency
  markers (`$`, `€`, `฿`, `Rp`, `Rp.`, `US$`, `MX$`, `COL$`) and the IDR thousands suffix (`45K`, `45k`,
  `45 rb`, `45 ribu`, refused for every other currency), in ISO 4217 minor units, assembled as a digit
  string and never in floating point.
- Each stored price keeps its `sourceUrl` and `capturedAt` and converts to USD cents with the `FxRate`
  of its capture date. Criterion 11's "100% of extracted price strings found in the source text"
  therefore holds by construction.

### Phone fallback

A place takes a `menu_prices` call task when it has no website or menu link (`no_link`), its URL is
unusable (`bad_url`), its domain is `prohibited` or `uncertain` (`domain_prohibited`,
`domain_uncertain`), its page failed (the refusal's own reason, such as `robots_disallowed`, `timeout` or
`too_large`, then `login_wall`, `parse_failed` or `empty_text`), or fewer than 5 priced items were stored
(`too_few_items`). One open task per place is enforced under an advisory lock, a `doNotCall` place gets
none, and a place with no phone still gets one, which `call-dispatch` moves to the operator queue as
`unreachable`. No price is guessed in any of these cases.

## Language model and spend cap

### Request profile

- The OpenAI Responses API is called with one payload of `model`, `instructions`, `input` and, when a
  schema was asked for, `text.format` (`type: "json_schema"`, `strict: true`). No tools are sent.
- Immediately before sending, `client.responses.inputTokens.count` counts that identical payload — a
  free call accepting everything the send does except the two generation-only keys. `create` then
  receives the payload plus `max_output_tokens` and `store: false`, and the client and every call set
  `maxRetries: 0`, so one reservation covers exactly one sent request and a retry reserves again.
- The reservation is the counted input tokens at `LLM_PRICE_INPUT_USD_PER_MTOK` plus `maxTokens` at
  `LLM_PRICE_OUTPUT_USD_PER_MTOK`, rounded up to micro-dollars, and it is taken atomically against
  `CAP_LLM_USD_PER_CITY_DAY` (25 USD) for the city's local day. A count that fails or is not a count
  means the request is never sent, and so does one that does not fit: `menu-ingest` then defers the
  place's job to 00:05 local the next day.
- After the answer the provider's reported cost is charged and the remainder released; an error or
  timeout without reported usage charges the whole reservation, because tokens may already have been
  billed.
- A reported input count differing from the counted one means the bound this cap rests on no longer
  holds: the difference is charged in full, `llm_count_mismatch` is logged with counts only, and
  language-model use is suspended in every city until an operator re-enables it.
- `workers`' menu extraction and `api`'s voice relay draw on the same per-city counter, so one menu
  cannot spend a city's day on its own.

### Supported models

`SUPPORTED_MODELS` in `packages/server-core/src/llm/openai.ts` lists the text-only models billed purely
per input and output token, which are the only ones the count-then-send profile bounds: `gpt-4.1-mini`,
`gpt-4.1` and `gpt-5-mini`. Any other `LLM_MODEL` fails the process at startup, and the adapter refuses
to be built for it.

## Labeled set

`apps/workers/eval/fixtures/menus/` holds 20 fictional menus, 4 per language (`en`, `pt`, `es`, `th`,
`id`), each priced in a launch-city currency: 6 HTML pages, 7 PDFs and 7 images. The seven image menus go
through OCR, and `id/id-03-scanned.pdf` has no text layer, which exercises the rasterize-then-OCR path.

`manifest.json` (version 1, one menu per line) names each file, its language, format, optional
`textLayer`, currency, Tesseract language and its labeled items — name, `normalizedName`, `priceText`,
`amountMinor`, currency and category — 202 items in total. A label counts as matched when a stored item
of the same menu has the same normalized name and the same exact amount in the same currency, and each
stored item consumes at most one label.

The run needs Chromium, Tesseract 5 with the five `tessdata_best` models, `poppler-utils` `pdftoppm` and
a generated Prisma client. With provider credentials it measures the set and writes the results block
below; without them (`LLM_PROVIDER` unset or `fake`) it validates the fixture set, writes the pending
block and exits 0 without overwriting a recorded measurement. It exits 1 on a failed threshold, a
token-count mismatch, a malformed fixture or a failed preflight.

```bash
LLM_PROVIDER=openai LLM_API_KEY=… LLM_MODEL=… LLM_PRICE_INPUT_USD_PER_MTOK=… \
  LLM_PRICE_OUTPUT_USD_PER_MTOK=… pnpm --filter @tablemate/workers eval:menus
```

## Criterion 11 results

<!-- BEGIN menus-eval -->
<!-- menus-eval:pending -->

Evaluation pending provider credentials

Counted-against-reported token evidence for the spend cap (AAP 0.5.6): pending.

Set `LLM_PROVIDER=openai` with a supported `LLM_MODEL`, `LLM_API_KEY` and both `LLM_PRICE_*_USD_PER_MTOK` prices to record the measurement.
<!-- END menus-eval -->

Everything between the two markers is written by `apps/workers/eval/menus-eval.ts`; run the evaluation
rather than editing it by hand.
