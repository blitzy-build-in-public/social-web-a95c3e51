# ZK performance

Proving and verification measurements with their pass or fail, for success criterion 4 (AAP 0.5.5,
AAP 0.12.1). Three blocks are written by scripts and replaced on every run of the script that owns
them — the native smoke check, the server verification benchmark and the web rows of the end-to-end
suite — so nothing inside their markers is edited by hand; everything outside them is hand-written.
No figure is recorded as `pass` without a measurement behind it (AAP 0.12.3), and no figure ever
moves proving to the server: the `api` image holds no proving key, calls no proving entrypoint and
accepts no private input (AAP 0.5.5, AAP 0.12.2). The circuit, its registry and its trusted setup
are described in [`zk-proofs.md`](./zk-proofs.md).

## Targets

| Measurement                     | Target        | Device or engine                                                                   |
| ------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| Device proving, iPhone 13 class | p95 ≤ 90 s    | A15, 4 GB, iOS 16+                                                                 |
| Device proving, Pixel 7 class   | p95 ≤ 90 s    | Tensor G2, 8 GB, Android 10+ (API 29+)                                             |
| Server proof verification       | p95 ≤ 500 ms  | `api` container: 1,000 `verifyItineraryProof` calls and 30 route-level submissions |
| Desktop web local proving       | informational | Chrome, Firefox and Safari, at their current and previous stable major             |

The 90-second figure names only the two phone classes (AAP 0.5.5). Desktop timings are recorded for
information, but each supported browser must still complete local proving: one that cannot is a
defect against the web capability, never an exception, and its deviation is reported in
[`platform-notes.md`](./platform-notes.md) (AAP 0.3.4).

## Criterion 4 status

| Measurement                           | Result  | Evidence                                                                                    |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| Proving, iPhone 13 class              | pending | Not yet measured — device access required                                                   |
| Proving, Pixel 7 class                | pending | Not yet measured — device access required                                                   |
| Server verification                   | pass    | `verifyItineraryProof` p95 10.48 ms and route p95 22.68 ms — run 2026-11-08, commit a5ee7c3 |
| Web local proving, Playwright engines | fail    | WebKit 27.2 recorded `fail` with no duration — run 2026-11-08, commit be61372-dirty         |
| Web local proving, branded browsers   | pending | Pending — manual browser check not yet run; the Safari rows need a macOS host               |

Updated by hand as the tables below gain measurements, and mirrored in
[`acceptance.md`](./acceptance.md).

## Method

### Device proving

- Build: the `bench` profile of `apps/mobile/eas.json` — the release configuration
  (`ios.buildConfiguration` `Release`, Android `:app:assembleRelease`), no development client, and
  `EXPO_PUBLIC_ZK_BENCH=1`, which mounts `apps/mobile/app/dev/zk-bench.tsx` at `/dev/zk-bench`. On a
  physical iPhone the `bench-device` profile extends it with `ios.simulator: false`, and that ad-hoc
  build needs Apple signing.
- Conditions: the device charged above 50%, with the proving key downloaded and verified before the
  measured runs. The benchmark screen states these conditions and does not enforce them.
- Sample: the bundled fixture `packages/circuits/fixtures/test-issuer/valid.eml`, two warm-up proofs
  and then 30 measured proofs. The flow's `RUNS` defaults to 30, and `RUNS=1` is the single run of
  the native smoke check, with no warm-up.
- Span: each measured span runs from input construction on the in-memory `.eml` bytes through
  witness generation and proving to the proof output. `totalMs` is the figure held against the
  target; `inputMs`, `witnessMs` and `proveMs` are diagnostics.
- Command:
  `maestro test -e RUNS=30 -e ARTIFACTS_URL=<artifacts-url> apps/mobile/e2e/maestro/zk-bench.yaml`,
  which prints one `ZK_BENCH_RESULT <json>` line carrying `platform`, `device`, `os`, `buildId`,
  `runs`, `runCount`, `warmups`, `p50`, `p95`, `max`, `proof` and `publicSignals`. Copy `p50`, `p95`
  and `max` into the table below in seconds to one decimal, and check the proof on the host with
  `snarkjs groth16 verify packages/circuits/build/verification_key.json`.

### Native smoke check

`bash packages/circuits/scripts/native-smoke.sh [ios|android|all]` (also `pnpm circuits:smoke`) is
the integration gate of AAP 0.2.4: it compiles the circuit and runs the trusted setup only when
their artefacts are missing or stale, builds mopro's native prover libraries, runs the `bench`
build, installs it on a booted simulator or an attached emulator or device, runs `zk-bench.yaml`
with `RUNS=1` against the compose `artifacts` service, and verifies the proof the device produced on
the host. Native-prover work on a platform proceeds only after its `pass`. A platform whose host,
device or tool is unavailable stays `pending` and unverified, which is the fallback AAP 0.2.4
permits: proving there is neither confirmed nor moved to the server. iOS needs macOS with Xcode 16.4
and a booted simulator, Android needs `adb` with an attached target, and both need the EAS CLI
(27.4.1) and the Maestro CLI (2.12.1).

### Server verification

`pnpm --filter @tablemate/api bench:verify` prepares 31 proofs of the test issuer on the host,
measures 1,000 `verifyItineraryProof` calls and 30 route-level `POST /v1/itinerary-proofs`
submissions inside the `api` container, and replaces its block below with p50, p95 and max for each
series plus the verdict against p95 ≤ 500 ms. It wants a compose stack up as
`APP_ENV=test ZK_ALLOW_TEST_ISSUER=true` with a built `dist/scripts`. Nothing here proves: the
proofs come from the test harness, and the runtime image holds no proving key and no proving call
(AAP 0.5.5, AAP 0.12.2).

### Web

`apps/mobile/e2e/playwright/web-proving.spec.ts` runs once in each project of
`apps/mobile/playwright.config.ts` — Chromium, Firefox and WebKit — and walks the app's own screens:
a throwaway account imports `valid.eml` through the proof-import UI, the page's Web Worker proves
it, and the API's answer to the submission is the evidence, `201` or `409 nullifier_used` when an
earlier actor already spent the booking. Its measured span runs from the proving step's first paint
to the instant the submission is issued, so the artefact download and its hash check sit outside it.
Each engine writes `.local/e2e/web-proving/<engine>.json`, and `scripts/e2e.ts` turns the files
written by its own run into the block below; an engine with no file is `pending`.

Branded desktop browsers are checked by hand: import and prove the same fixture through the
proof-import screen of a stack started with `APP_ENV=test`. "The two latest" means the current
stable release and the previous stable major of Chrome, Firefox and Safari at the time of the check;
the previous Safari major needs a second macOS host on the previous macOS release. No launcher and
no memory-sampling harness is built for these checks (AAP 0.7.2).

## Criterion 4 — device proving

| Device class                    | Device model | OS  | Build id | Runs | p50 (s) | p95 (s) | max (s) | Result  | Date | Commit |
| ------------------------------- | ------------ | --- | -------- | ---- | ------- | ------- | ------- | ------- | ---- | ------ |
| iPhone 13 class (A15, 4 GB)     | —            | —   | —        | 30   | —       | —       | —       | pending | —    | —      |
| Pixel 7 class (Tensor G2, 8 GB) | —            | —   | —        | 30   | —       | —       | —       | pending | —    | —      |

**Not yet measured — device access required.** The iPhone row additionally needs Apple signing for
an ad-hoc device build. A row is filled only from a `ZK_BENCH_RESULT` line whose proof the host
verified, and the device model, OS version and build id come from that line. The two percentiles are
the nearest-rank `p50` and `p95` of `totalMs` over the 30 measured runs.

## Native smoke check

One row per platform, replaced on every run of `packages/circuits/scripts/native-smoke.sh`.

<!-- BEGIN native-smoke -->

| Platform | Result  | Total ms | Input ms | Witness ms | Prove ms | Device / OS | Date       | Commit  | Note                                       |
| -------- | ------- | -------- | -------- | ---------- | -------- | ----------- | ---------- | ------- | ------------------------------------------ |
| iOS      | pending | n/a      | n/a      | n/a        | n/a      | n/a         | 2026-11-08 | 0d3a667 | Pending — EAS CLI and Maestro CLI required |
| Android  | pending | n/a      | n/a      | n/a        | n/a      | n/a         | 2026-11-08 | 0d3a667 | Pending — EAS CLI and Maestro CLI required |

<!-- END native-smoke -->

Both rows are `pending`, so native-prover integration on both platforms is waiting on a host that
can run this check; the timings of the single run it takes stay diagnostics and are not the
criterion 4 figures.

## Server verification

One block, replaced on every run of `pnpm --filter @tablemate/api bench:verify`.

<!-- BEGIN bench-verify -->

Run: 2026-11-08T04:02:16.529Z · commit a5ee7c3
Host: INTEL(R) XEON(R) PLATINUM 8581C CPU @ 2.10GHz × 112 · 2929 GiB · container Node v22.23.4
Mode: APP_ENV=test, fixture proofs of the test issuer

| Series                                    | Samples           | p50 (ms) | p95 (ms) | Max (ms) | Target       | Result |
| ----------------------------------------- | ----------------- | -------- | -------- | -------- | ------------ | ------ |
| `verifyItineraryProof` (api container)    | 1,000 (1 warm-up) | 7.33     | 10.48    | 14.90    | p95 ≤ 500 ms | pass   |
| `POST /v1/itinerary-proofs` (route level) | 30                | 15.02    | 22.68    | 29.76    | p95 ≤ 500 ms | pass   |

Criterion 4 (server verification): pass
<!-- END bench-verify -->

## Web — Playwright engines

One row per engine, written from `.local/e2e/web-proving/<engine>.json` by `scripts/e2e.ts`.

<!-- BEGIN e2e:web-proving -->

Web proving in the end-to-end suite. Run 2026-11-08T10:54:09.180Z · commit be61372-dirty · Stripe mock (stripe-mock behind the stateful proxy) — mock evidence only

| Engine   | Version      | Total (s) | Result |
| -------- | ------------ | --------- | ------ |
| chromium | 156.0.8078.4 | 253.8     | pass   |
| firefox  | 157.0        | 264.9     | pass   |
| webkit   | 27.2         | n/a       | fail   |

Timings are informational: the 90-second target names only the phone classes (AAP 0.5.5). Each row is one `.local/e2e/web-proving/<engine>.json` that this run wrote, and an engine whose file is missing is `pending`. Chrome, Firefox and Safari at their current and previous branded versions are recorded by hand (AAP 0.3.4).

<!-- END e2e:web-proving -->

WebKit's row is a defect against the web capability rather than an exception (AAP 0.3.4): that
engine's walk recorded a failure with no duration, so its proof was not accepted by the API and the
engine is not proved until a later run records `pass`. The Stripe mode in the heading belongs to the
end-to-end run that produced the rows; local proving does not touch the card provider.

## Web — branded desktop browsers

| Browser                  | Version | Host OS | Total (s) | Result  | Date | Commit | Checked by |
| ------------------------ | ------- | ------- | --------- | ------- | ---- | ------ | ---------- |
| Chrome (current)         | —       | —       | —         | pending | —    | —      | —          |
| Chrome (previous major)  | —       | —       | —         | pending | —    | —      | —          |
| Firefox (current)        | —       | —       | —         | pending | —    | —      | —          |
| Firefox (previous major) | —       | —       | —         | pending | —    | —      | —          |
| Safari (current)         | —       | —       | —         | pending | —    | —      | —          |
| Safari (previous major)  | —       | —       | —         | pending | —    | —      | —          |

Every row is `pending` — **Pending — manual browser check not yet run** — and the two Safari rows
also need a macOS host, the current release for the current major and the previous release for the
previous one: **Pending — macOS host required**. One row is one walk of the fixture through the
proof-import screen, so it carries no sample size, and the web export it ran against is identified
by the commit.

## When a target is missed

Record the measured figures as `fail` rather than omitting them. An affected phone class stays in
the unverified state, and a browser that cannot complete local proving is reported as a defect
against the web capability (AAP 0.2.4, AAP 0.3.4). Proving never moves to the server whatever the
figure, and a device build killed for memory is recorded as `fail` with the cause named in the row's
note. A run that cannot measure at all — no device, no host, no credential — stays `pending` with
what it needs spelled out.

## How to update

1. Device proving: run the benchmark flow on each phone class, then fill the two rows above from the
   `ZK_BENCH_RESULT` line, and set the matching row of the status table.
2. Native smoke check: run `pnpm circuits:smoke` per platform. The script replaces its own block;
   make no edit inside the markers.
3. Server verification: run `pnpm --filter @tablemate/api bench:verify` against a stack started as
   `APP_ENV=test ZK_ALLOW_TEST_ISSUER=true`. It replaces its own block.
4. Web: run `pnpm test:e2e` for the engine rows, and check the six branded versions by hand for the
   table above. Update the status table by hand whenever a row changes.
