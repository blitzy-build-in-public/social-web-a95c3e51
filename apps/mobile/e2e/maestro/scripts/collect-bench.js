/* global http, json, maestro, RUNS, OUTPUT, COLLECT_URL */
/*
 * Validates the on-device proving benchmark result and emits it for the host: the sample collection of
 * AAP 0.5.5, the native smoke check of AAP 0.2.4 and success criterion 4.
 *
 * The contract, agreed with `zk-bench.yaml`, `app/dev/zk-bench.tsx`, `docs/zk-performance.md` and the
 * host that reads this output:
 *   - GraalJS has no filesystem, so this script cannot write `OUTPUT` itself.
 *   - On success it prints exactly one line, `ZK_BENCH_RESULT <single-line JSON>`, and nothing else.
 *   - `packages/circuits/scripts/native-smoke.sh` takes that line from Maestro's console output, or
 *     from `maestro.log` under `--debug-output <dir>`, and writes the JSON to `OUTPUT` itself.
 *   - A failure throws, which fails the Maestro step; a bench error prints `ZK_BENCH_ERROR <platform>
 *     <code>` first, so the cause is visible, not only the verdict.
 *
 * Flow env inputs: `RUNS` (required; `zk-bench.yaml` defaults it to 30, `native-smoke.sh` passes 1),
 * `OUTPUT` (the host's target path, echoed back in the payload), `COLLECT_URL` (optional HTTP sink).
 *
 * Emitted shape: `{ platform, device, os, buildId, runs, runCount, warmups, p50, p95, max, proof,
 * publicSignals, output }`, built from the app's `BenchResult`: `runs` is the sample list, so the host
 * reads `runs[0].totalMs` and the component timings from it, and `runCount` is the sample count.
 *
 * Only structure and arithmetic are judged here; pass or fail against p95 ≤ 90 s belongs to
 * `docs/zk-performance.md`, and the smoke check's pass is the host's `snarkjs groth16 verify`. No
 * message below echoes a signal or proof value — only the name of the field that failed.
 */
(function () {
  'use strict';
  /* The seven public signals of the circuit in snarkjs order, and their decimal form, restated because
   * this script runs in Maestro's sandbox and cannot import them from packages/shared. */
  const PUBLIC_SIGNAL_COUNT = 7;
  const FIELD_ELEMENT = /^\d{1,78}$/;
  const RESULT_PREFIX = 'ZK_BENCH_RESULT ';
  const SAMPLE_FIELDS = ['inputMs', 'witnessMs', 'proveMs', 'totalMs'];
  const runs = Number(typeof RUNS === 'undefined' ? '' : String(RUNS));
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error('RUNS must be a positive integer');
  }
  const output = typeof OUTPUT !== 'undefined' && OUTPUT ? String(OUTPUT) : '';
  const collectUrl = typeof COLLECT_URL !== 'undefined' && COLLECT_URL ? String(COLLECT_URL) : '';
  function fail(field) {
    throw new Error('zk-bench-result is invalid: ' + field);
  }
  function timing(value, field) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(field);
    return value;
  }
  function point(value, field) {
    if (!Array.isArray(value) || value.length !== 3) fail(field);
  }
  function label(value) {
    return typeof value === 'string' ? value : '';
  }
  /* The result the flow copied out of the app (`copyTextFrom: { id: 'zk-bench-result' }`). */
  const copied = typeof maestro.copiedText === 'string' ? maestro.copiedText.trim() : '';
  if (copied === '') {
    throw new Error('nothing copied — zk-bench.yaml must copyTextFrom zk-bench-result first');
  }
  let result;
  try {
    result = json(copied);
  } catch {
    throw new Error('zk-bench-result is not complete JSON (truncated?)');
  }
  if (result === null || typeof result !== 'object') {
    throw new Error('zk-bench-result is not a JSON object');
  }
  /* A bench failure carries a code instead of samples (AAP 0.5.5): print it, then fail the step. */
  if (result.error) {
    const platform = result.platform || maestro.platform;
    console.log('ZK_BENCH_ERROR ' + platform + ' ' + result.error);
    throw new Error('zk-bench reported ' + result.error + ' on ' + platform);
  }
  if (result.platform !== maestro.platform) fail('platform');
  if (result.runs !== runs) fail('runs');
  const samples = result.samples;
  if (!Array.isArray(samples) || samples.length !== runs) fail('samples');
  if (!Number.isInteger(result.warmups) || result.warmups < 0) fail('warmups');
  for (const sample of samples) {
    if (sample === null || typeof sample !== 'object') fail('samples');
    for (const field of SAMPLE_FIELDS) timing(sample[field], 'samples[].' + field);
  }
  const p50 = timing(result.p50, 'p50');
  const p95 = timing(result.p95, 'p95');
  const max = timing(result.max, 'max');
  if (p50 > p95 || p95 > max) fail('p50 <= p95 <= max');
  const publicSignals = result.publicSignals;
  if (!Array.isArray(publicSignals) || publicSignals.length !== PUBLIC_SIGNAL_COUNT) {
    fail('publicSignals');
  }
  for (const signal of publicSignals) {
    if (typeof signal !== 'string' || !FIELD_ELEMENT.test(signal)) fail('publicSignals');
  }
  /* The Groth16 JSON shape `snarkjs groth16 verify` consumes: pi_a and pi_c are G1 points of three
   * coordinates, pi_b a G2 point of three coordinate pairs. Only the point counts are checked here, since
   * whether the coordinates are field elements is the host verifier's business. */
  const proof = result.proof;
  if (proof === null || typeof proof !== 'object') fail('proof');
  point(proof.pi_a, 'proof.pi_a');
  point(proof.pi_c, 'proof.pi_c');
  if (!Array.isArray(proof.pi_b) || proof.pi_b.length !== 3) fail('proof.pi_b');
  for (const pair of proof.pi_b) {
    if (!Array.isArray(pair) || pair.length !== 2) fail('proof.pi_b');
  }
  const payload = {
    platform: result.platform,
    device: label(result.model),
    os: label(result.osVersion),
    buildId: label(result.buildId),
    runs: samples,
    runCount: result.runs,
    warmups: result.warmups,
    p50,
    p95,
    max,
    proof,
    publicSignals,
    output: output === '' ? null : output,
  };
  /* One line, never indented, so it survives both the copy and the console capture intact. */
  console.log(RESULT_PREFIX + JSON.stringify(payload));
  if (collectUrl !== '') {
    const response = http.post(collectUrl, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error('POST to COLLECT_URL failed: HTTP ' + response.status);
    }
  }
})();
