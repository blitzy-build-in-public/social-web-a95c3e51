# ZK proofs

The circuit, its registry and the setup transcript. The table below is written by
`pnpm circuits:compile` and replaced on every run, so it always describes the build in the tree.

<!-- BEGIN circuits:compile -->

| Item             | Value                                             |
| ---------------- | ------------------------------------------------- |
| Constraints      | 2538201                                           |
| Phase 1 capacity | 4,194,304 (2^22, powersOfTau28_hez_final_22.ptau) |
| Result           | within limit                                      |
| Wires            | 2491345                                           |
| Private inputs   | 3324                                              |
| Public inputs    | 2                                                 |
| Outputs          | 5                                                 |
| circom           | circom compiler 2.1.9                             |
| snarkjs          | 0.7.6                                             |
| Compiled (UTC)   | 2026-11-05                                        |

<!-- END circuits:compile -->

<!-- BEGIN circuits:setup -->

| Item                     | Value                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| ptau file                | powersOfTau28_hez_final_22.ptau (4831921304 bytes)                                                                               |
| ptau BLAKE2b-512         | 0d64f63dba1a6f11139df765cb690da69d9b2f469a1ddd0de5e4aa628abb28f787f04c6a5fb84a235ec5ea7f41d0548746653ecab0559add658a83502d1cb21b |
| ptau source              | https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_22.ptau                                                        |
| snarkjs                  | 0.7.6                                                                                                                            |
| Circuit hash             | b0fac5ba5d20ea633a54793d3dae3324f484cd613fc67f7cfe3faa3289c66485ca92b21966c07329299f21582c4bad15a33056764ac6030a921145fdcedd2971 |
| Contribution 1 name      | tablemate dev contribution 1                                                                                                     |
| Contribution 1 hash      | 3c6c48c55aecd57ce8cd32409db219c01dcb7949caf867d640257b554d1e26a5468451499841e8f9a3d67ba3ff377a7d02f7b298cc0ac608af0e275a45801970 |
| Contribution 2 name      | tablemate dev contribution 2                                                                                                     |
| Contribution 2 hash      | f0f918be9b9cc7e0c5c27e7f41cf7ba42f4268ead479c1a7f2ed784de8f27b1662b08e95e2e34fbc3d06b432488ffb9c3e9e5559e217b78fe875749df524b147 |
| Beacon hash              | db66284b2ef1368951cd0a0ea640e273c327ea9fb90d7f9f997fadb9cd371e3b                                                                 |
| Beacon iterations        | 10 (2^10)                                                                                                                        |
| Beacon contribution hash | b4b4d289a5d3db3dff44493ea3655bebb081f22487204d6fa8ef0d9d71b8526b081a2099476ae1f757b25df334dddc81e5c596f9fd1d9752d54e47238debc623 |
| zkey verify              | ZKey Ok! (attempt 1 of 3)                                                                                                        |
| Final zkey SHA-256       | cfe3c06bb77ca8bc792854e43a37489d85aa7acbb240855d791249cda7400713                                                                 |
| Final zkey size          | 1588395630 bytes                                                                                                                 |
| Verification key SHA-256 | 228452d42b79634272fabc6b52c6df6907a26a9f457040c7c1cbb0d9e4dc5306                                                                 |
| Ceremony (UTC)           | 2026-11-05                                                                                                                       |
| Note                     | Development ceremony for this environment; the multi-party production ceremony is out of scope (AAP 0.7.2).                      |

<!-- END circuits:setup -->
