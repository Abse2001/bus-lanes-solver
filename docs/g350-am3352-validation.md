# G350 reproduction validation — 2026-10-11

Tested against Bus Lanes `d8583e433b5268ef4472639a18a533f2ba55e453`
(0.0.25), using Bun 1.3.14 and Node 25.6.1. The G350 board runtime,
reviewed native checks patch, routing evidence and hardware sources are unchanged.

## Fixture and acceptance checks

- Six G350 tests pass, including all real pads, exact 49-signal numeric pin
  mapping, required power/reference/reset/clock contacts, constraints, and
  rejection of a superficially connected but colliding 49-trace output.
- G350 and related merged SBC snapshot/package-first/benchmark-report tests:
  28 pass, 0 fail, 1,227 assertions.
- Repository typecheck and the capture/CLI script typechecks pass.
- Fresh Core 0.0.2107 capture from both the complete G350 layout and the focused
  committed circuit reproduces the saved fixture hashes exactly.
- No accepted routed copper or snapshot is exported from an incomplete solve.

## G350 49-signal result

The final fixture was run with the full three-bus and three-pair constraints:

```sh
bun scripts/repro-g350-am3352.ts --timeout-seconds 120 \
  --report /tmp/g350-am3352-tested-report.json \
  --output /tmp/g350-am3352-tested-accepted.json
```

The solver timed out in `route_shared_layers` after 120.000149 seconds
and 318,220 iterations. No accepted output was available, and the input
remained unchanged. DDR connectivity, DRC, BYTE0/BYTE1/COMMAND_CLOCK skew and
all pair skews remain unverified; their measurements are null rather than zero.
The requested output file was not created. The full diagnostic measurements
are in [g350-report.json](g350-am3352-repro/g350-report.json).

All 49 signals and all 68 support nets remain in the committed native capture.
This result does not establish complete DDR routing, connected support nets,
electrical timing closure or readiness to order. `fabricationReady=false`.

## Existing upstream benchmarks

Ran the required harness against all eleven existing samples:

```sh
./benchmark.sh --timeout-seconds 60 --output /tmp/g350-repro-upstream-benchmark.json
```

Five samples pass connectivity, independent combined DRC and requested matching;
six reach the bounded timeout. The timeout results are unresolved at this budget,
not proof of impossible routing. Reported paths in timed-out cases are solver
internal counts and do not establish accepted connectivity or DRC. DRC/skew cells
remain unverified for those cases. The existing benchmark fixtures, fixed
FanoutSolver paths, matching bounds and solver implementation were unchanged.

| Sample | Status | Reported paths | DRC | BYTE0 skew (mm) | BYTE1 skew (mm) | Runtime (s) |
| --- | --- | --- | --- | --- | --- | --- |
| control | solved | 47/47 | pass | 0.635000 | 0.635000 | 32.248 |
| control-inner1 | timed_out | 47/47 | not verified | not verified | not verified | 60.714 |
| right | solved | 47/47 | pass | 0.635000 | 0.635000 | 28.525 |
| left | solved | 47/47 | pass | 0.635000 | 0.511147 | 36.638 |
| above | solved | 47/47 | pass | 0.635000 | 0.635000 | 38.538 |
| inner-layers | solved | 47/47 | pass | 0.635000 | 0.635000 | 47.245 |
| inner-layers-right | timed_out | 47/47 | not verified | not verified | not verified | 69.031 |
| inner-layers-left | timed_out | 47/47 | not verified | not verified | not verified | 60.321 |
| inner-layers-above | timed_out | 0/47 | not verified | not verified | not verified | 60.248 |
| inner-layers-complete-ca | timed_out | 0/47 | not verified | not verified | not verified | 63.489 |
| outer-layers | timed_out | 0/47 | not verified | not verified | not verified | 60.093 |

The complete-CA sample also retains its command/address/clock bound; its skew
was unavailable at timeout. These are the existing 47-signal benchmark cases,
not the separate G350 49-signal case. Full per-bus copper lengths, connectivity,
DRC, runtime and immutable-fanout checks are retained in
[benchmark-results.json](g350-am3352-repro/benchmark-results.json).

## Installation note

The environment denies GitHub API tarball requests. For this local install,
the repository's exact pinned FanoutSolver commit
`15857f17beed0f228b2e29544f7ce393af297c86` (0.0.76) was fetched over authenticated
Git HTTPS, packed locally and used for dependency installation. The original
`package.json` was restored byte-for-byte before tests. No dependency pins were
changed or published, and no board packages were replaced.
