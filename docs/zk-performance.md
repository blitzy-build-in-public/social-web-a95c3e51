# ZK performance

## Server verification

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

## Device proving

<!-- BEGIN native-smoke -->

| Platform | Result  | Total ms | Input ms | Witness ms | Prove ms | Device / OS | Date       | Commit  | Note                                       |
| -------- | ------- | -------- | -------- | ---------- | -------- | ----------- | ---------- | ------- | ------------------------------------------ |
| iOS      | pending | n/a      | n/a      | n/a        | n/a      | n/a         | 2026-11-08 | 0d3a667 | Pending — EAS CLI and Maestro CLI required |
| Android  | pending | n/a      | n/a      | n/a        | n/a      | n/a         | 2026-11-08 | 0d3a667 | Pending — EAS CLI and Maestro CLI required |

<!-- END native-smoke -->

<!-- BEGIN e2e:web-proving -->

Web proving in the end-to-end suite. Run 2026-11-08T10:54:09.180Z · commit be61372-dirty · Stripe mock (stripe-mock behind the stateful proxy) — mock evidence only

| Engine   | Version      | Total (s) | Result |
| -------- | ------------ | --------- | ------ |
| chromium | 156.0.8078.4 | 253.8     | pass   |
| firefox  | 157.0        | 264.9     | pass   |
| webkit   | 27.2         | n/a       | fail   |

Timings are informational: the 90-second target names only the phone classes (AAP 0.5.5). Each row is one `.local/e2e/web-proving/<engine>.json` that this run wrote, and an engine whose file is missing is `pending`. Chrome, Firefox and Safari at their current and previous branded versions are recorded by hand (AAP 0.3.4).

<!-- END e2e:web-proving -->
