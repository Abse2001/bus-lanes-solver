# AM3352 mini-PC: 90° RAM, inner-layer routing reproduction

This is the full 50-signal DDR-phase capture from the active mini-PC circuit,
rendered with tscircuit 0.0.2744/core 0.0.2080 on 2026-10-04. The Micron 1 GB
RAM is rotated 90°, at (0, −13) mm, with the reviewed DQ9/DQ15 swap. All 1,441
native obstacles are retained; this is not a minimized sample. There is no saved
or manual copper in the input. The existing 47-signal benchmark is unchanged.

`tests/fixtures/am3352-mini-pc-inner-layers/` contains the byte-identical SRJ
compressed as `input.json.gz` (the recorded hash covers the decompressed bytes),
solver options, and source/release hashes. Physical layer count is four;
global and every bus's carrier permissions are exactly `inner1, inner2`.
Automatic top-pad dogbones and through-via barrels remain physical copper.
The native bus and pair bounds are retained: 0.635 mm for both byte groups and
the 27-signal command/address/clock group; 0.127 mm for each DQS pair and
0.1 mm for the clock pair. Vias are 0.4 mm copper / 0.2 mm drill.

Run from this repository at the recorded revision, with Bun dependencies installed:

```sh
bun scripts/repro-am3352-mini-pc-inner-layers.ts --timeout-seconds 240
bun test tests/am3352-mini-pc-inner-layers-repro.test.ts --timeout 30000
```

`MINI_PC_REPRO_SECONDS` can change the default budget. `--input`, `--options`,
and `--output` accept explicit paths. The default options file is
`default-options.json`, containing `{}`, so native solver defaults apply.
The earlier configured attempt can be replayed separately:

```sh
bun scripts/repro-am3352-mini-pc-inner-layers.ts \
  --options tests/fixtures/am3352-mini-pc-inner-layers/options.json \
  --output .cache/am3352-mini-pc-inner-layers/configured-report.json \
  --timeout-seconds 240
```

The configured options select `smoothTuning: true`, `denseSearch: true`,
`maxSearchIterations: 200000`, and `maxLaneIterations: 15000`. The runner imports this repository's native
`BusLanesPipelineSolver` and makes no solver edits, fanout substitutions,
staged retention, manual traces, or constraint changes.

The report defaults to `.cache/am3352-mini-pc-inner-layers/defaults-report.json`.
It distinguishes a natural native failure, a wall-clock budget stop, a hard
worker deadline, and a completed output that fails independent validation.
At a normal budget stop it requests the public final-acceptance operation;
only a previously validated complete native snapshot can become accepted.
Progress trace counts are explicitly separate from accepted signals.
An outer process deadline handles a native step that does not return.

A routing pass requires all 50 native pad pairs to connect with one
inner-layer carrier per signal, unchanged input, native copper DRC and
self-short checks, retained length limits, and conventional routed geometry.
The runner exits nonzero for every incomplete or invalid result. It writes
route output only after those checks pass; diagnostic captures stay local.
The fast test checks capture identity, constraints, and rejection of incomplete
output. It does not permanently assert that the solver must fail.

Planar matching alone does not establish via-depth timing, impedance, return
continuity, power connectivity, or electrical signoff. This reproduction does
not claim the complete board is ready for manufacture.

## Observed result on 2026-10-04

Both native defaults and the explicit configured options above exhausted the
240-second routing budget on this exact capture, in the official 0.0.19 release
and repository revision `463734fa7ec4581a0e7ba2a1afacdf6715f1b37e`. Every run
generated 100 automatic local dogbones, then remained in `lanes_route`.
None produced an accepted signal set.

| Runtime | Elapsed | Accepted signals | Stop reason |
| --- | ---: | ---: | --- |
| Official 0.0.19 release, native defaults | 240.217 s | 0 / 50 | Wall-clock budget; `search_budget_exhausted` |
| Repository source, native defaults | 245.944 s | 0 / 50 | Wall-clock budget; `search_budget_exhausted` |
| Official 0.0.19 release, configured | 240.221 s | 0 / 50 | Wall-clock budget; `search_budget_exhausted` |
| Repository source, configured | 240.380 s | 0 / 50 | Wall-clock budget; `search_budget_exhausted` |

The native-default source run reached the budget at 240.198 seconds; its
reported total includes native finalization and report overhead. The source
options are `{}`; the release adapter materializes the identical native
`smoothTuning: true` and `denseSearch: true` defaults without iteration overrides.
Both source runs used Bun 1.3.14. Their input stayed unchanged; the input SHA-256
is `914d9aae90e0f5be60b8dd881c881401e99fe95176381c3572d39bf09193fc54`.
The native pipeline still reported `failed: false` after the public budget
finalization operation, so the wrapper records the explicit budget stop rather
than misclassifying it as a natural terminal failure or success. Provisional
lane counts do not represent connected, matched, accepted copper. Full-channel
DRC and timing remain unqualified. A bounded search failure does not establish
that the physical routing problem is impossible.

The focused capture test passed (1 test, 14 assertions), and `bun run typecheck`
passed. No solver implementation changed for this reproduction.

The repository reference benchmark completed **5/9** cases; four timed out. See [the measured connectivity, DRC, skew and runtime results](./am3352-mini-pc-inner-layers-benchmark.md).
