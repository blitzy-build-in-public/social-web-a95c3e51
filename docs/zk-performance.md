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
