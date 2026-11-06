# Operations

The operator runbook: the commands that build and run what the other documents describe, the inputs
each one takes, and the locks and limits that govern them.

## Circuit build and trusted setup (packages/circuits/scripts)

`packages/circuits/scripts/compile.sh` and `packages/circuits/scripts/setup.sh` produce the proving
artefacts the clients download and the `api` verifies proofs against. Both are invoked with `bash`,
both write only inside the git-ignored `packages/circuits/build/` and the `docs/zk-proofs.md` marker
blocks, and both print their contract when called with `--help`, or with an argument they do not take.

| Command                 | What it does                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm circuits:compile` | Runs `bash scripts/compile.sh`: compiles `circuits/tablemate_itinerary.circom` with circom 2.1.9 into the R1CS, the symbols and the wasm witness generator, then records the constraint count and the public-signal shape. Several minutes on a loaded host.                                          |
| `pnpm circuits:setup`   | Runs `bash scripts/setup.sh`: verifies the phase 1 file, fetches it if it is absent, then runs `snarkjs groth16 setup`, two contributions, one beacon, `zkey verify` and the verification-key export, and writes the manifest. It needs the compile's R1CS and wasm first, and takes tens of minutes. |
| `pnpm circuits:build`   | `pnpm circuits:compile && pnpm circuits:setup`, the whole pipeline in one command.                                                                                                                                                                                                                    |

The ceremony this runs is a development ceremony for this environment: one script makes both
contributions and the beacon is public. The multi-party production ceremony belongs to launch
preparation and is out of scope (AAP 0.7.2).

### Environment knobs

All of them are optional, and `bash scripts/<script>.sh --help` prints the same list.

| Knob                    | Read by    | Default                                                                     | Effect                                                                                                                                                                                                                                                         | Validated by                                                                                                                                 |
| ----------------------- | ---------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PTAU_PATH`             | `setup.sh` | `build/ptau/powersOfTau28_hez_final_22.ptau`                                | The phase 1 file. An existing file at that path is used as it stands and skips the download, which is the fast path for a fresh checkout.                                                                                                                      | `setup.sh`: the byte size first, then the BLAKE2b-512                                                                                        |
| `PTAU_URL`              | `setup.sh` | `https://circom.info/powersOfTau28_hez_final_22.ptau`                       | The URL the phase 1 file is downloaded from when it is absent.                                                                                                                                                                                                 | —                                                                                                                                            |
| `PTAU_MIRROR`           | `setup.sh` | `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_22.ptau` | The URL tried only once `PTAU_URL` has failed.                                                                                                                                                                                                                 | —                                                                                                                                            |
| `BEACON_HASH`           | `setup.sh` | 32 fresh random bytes                                                       | The beacon's entropy. A supplied value reproduces an earlier ceremony, a beacon being public by definition.                                                                                                                                                    | `setup.sh`: 64 hex characters, before any download or ceremony step                                                                          |
| `CIRCUITS_NODE_HEAP_MB` | both       | 8192 in `compile.sh`, 16384 in `setup.sh`                                   | Node's heap in MB for the R1CS parse and for the ceremony, which need well over node's default.                                                                                                                                                                | both scripts: a positive integer, rejected before the multi-minute compile in `compile.sh` and before the phase 1 verification in `setup.sh` |
| `TMPDIR`                | both       | `/tmp`                                                                      | Where the docs-block content temp file is created, and in `setup.sh` also the transcript and step-output files. Each script's `write_doc_block` creates its own temp next to the document instead, so the document's rename stays atomic whatever `TMPDIR` is. | —                                                                                                                                            |

### Fresh-checkout fast path

The phase 1 file `powersOfTau28_hez_final_22.ptau` is exactly 4,831,921,304 bytes and has BLAKE2b-512

```
0d64f63dba1a6f11139df765cb690da69d9b2f469a1ddd0de5e4aa628abb28f787f04c6a5fb84a235ec5ea7f41d0548746653ecab0559add658a83502d1cb21b
```

which `b2sum <file>` prints. Without a copy on the host, `setup.sh` downloads it from `PTAU_URL` and
falls back to `PTAU_MIRROR`; with the host's verified copy already present, pointing `PTAU_PATH` at it
skips the download entirely:

```bash
PTAU_PATH=/path/to/powersOfTau28_hez_final_22.ptau pnpm circuits:setup
```

Keep that copy outside the repository: `.gitignore` excludes `*.ptau`, and the same file is reused by
every later ceremony on the host.

A file supplied this way is checked the same way and is never deleted when it fails; a file the run
downloaded itself is removed, so the next run fetches it again.

### Outputs

| Path                                                                          | Written by   | Contents                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/circuits/build/tablemate_itinerary.r1cs`                            | `compile.sh` | The constraint system circom emits, and the input to the ceremony.                                                                                                                                                                                                                                   |
| `packages/circuits/build/tablemate_itinerary.sym`                             | `compile.sh` | The symbol file the circuit tests load with `recompile: false`.                                                                                                                                                                                                                                      |
| `packages/circuits/build/tablemate_itinerary.wasm`, `tablemate_itinerary_js/` | `compile.sh` | The wasm witness generator, as circom writes it and under the flattened name the manifest serves.                                                                                                                                                                                                    |
| `packages/circuits/build/tablemate_itinerary.zkey`                            | `setup.sh`   | The proving key.                                                                                                                                                                                                                                                                                     |
| `packages/circuits/build/verification_key.json`                               | `setup.sh`   | The key the `api` verifies proofs with.                                                                                                                                                                                                                                                              |
| `packages/circuits/build/artifacts.manifest.json`                             | `setup.sh`   | The name, size and SHA-256 of the wasm, the proving key and the verification key, parsed against `ArtifactsManifest` from `@tablemate/shared` before the run reports itself complete.                                                                                                                |
| `docs/zk-proofs.md`                                                           | both         | Two marker blocks: `circuits:compile`, holding the constraint count, the capacity and the public-signal shape, and `circuits:setup`, holding the ceremony transcript — the phase 1 file with its digest and its source, both contributions, the beacon, the verify result and the final key digests. |

`build/` is git-ignored (AAP 0.7.1), so the marker blocks in `docs/zk-proofs.md` are the tracked
record of which artefacts are in the tree.

### Constraint ceiling

`compile.sh` fails above 4,194,304 constraints (2^22), the capacity of the 2^22 phase 1 file, and it
does so before any ceremony step runs: the count comes from `snarkjs r1cs info` over the R1CS the
ceremony would consume. The `circuits:compile` block records the count and either `within limit` or
`exceeds limit` before the failure is reported.

### One run at a time

Both scripts write fixed intermediate names under `packages/circuits/build/`, so one run at a time
owns that directory. Each script takes an exclusive lock before its first write and holds it for the
whole run.

| Mechanism | Used when                                  | Lock                                            | Released                                                                                                                        |
| --------- | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `flock`   | The host has `flock`, as Linux does        | The directory `packages/circuits/build`         | By the kernel when the process ends, a killed one included. The directory stays in place, so the next run locks the same inode. |
| `mkdir`   | The host has no `flock`, as macOS does not | The directory `packages/circuits/build/.lock.d` | At the end of the run, on a failure and on `SIGINT` or `SIGTERM`. Remove it by hand only once no run is active.                 |

A run that finds the lock held reports it and exits at once instead of queueing behind the other run,
naming the lock path and, for the directory, the remedy.

The circuit itself, the registry and the issuer records are in `docs/zk-proofs.md`.

## Partner console pages

`apps/venue-console` serves the two pages the plan names for it, each behind the operator-issued
secret the API checks (AAP 0.3.2, 0.5.4): `/venue` shows the venue's rotating check-in code with
its QR form, and `/lodging` shows one lodging's leaderboard standing. Beyond those two, it serves
a landing index at `/` that links both consoles, and any other path renders that same index with a
"Page not found" line above the links. The landing index is a deliberate addition to the two
screens the AAP names for this workspace, not a route the API serves. It renders no route data and
makes no request: the `venue-console` image is nginx, which answers `index.html` for every path
(AAP 0.6.2), so the page decides what to render from the path alone.
