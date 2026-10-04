# AM3352 envelope compaction

Total signal envelope area across the nine declared samples falls **7.72%**, from **7,317.67 to 6,752.55 mm²**. All nine finish within the existing 180-second routing budget and pass 47/47 connectivity, native combined-copper DRC, exterior pair coupling and every declared bus/pair skew limit. All 161 fixed power dogbones and the original inputs remain unchanged.

The signal envelope includes wire radii and terminal via pads. The total reduction is `1 − sum(after) / sum(before)`; it is not a per-case guarantee. The unweighted mean reduction is 6.86%, and individual reductions range from 0.15% to 18.43%. Fixed power copper remains part of clearance validation and the separate all-copper footprint in the JSON report.

Before/after areas are measured in the same run: the unchanged routing and tuning stages first produce a complete accepted solution, then the compactor proposes improvements. The initial areas match the [v0.0.17 nine-case baseline](../benchmark-nine-samples.md). All routes are computed from the native pads, copper and constraints.

| Sample / completed snapshot | Before (mm²) | After (mm²) | Reduction | Routing + compaction (s) | Compaction (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| [control](control-solved.png) | 412.370 | 381.904 | 7.39% | 36.326 | 9.030 |
| [right](right-solved.png) | 660.450 | 658.597 | 0.28% | 33.591 | 6.749 |
| [left](left-solved.png) | 568.859 | 567.985 | 0.15% | 41.103 | 5.220 |
| [above](above-solved.png) | 638.400 | 614.360 | 3.77% | 56.538 | 7.393 |
| [inner-layers](inner-layers-solved.png) | 468.312 | 437.914 | 6.49% | 62.582 | 10.067 |
| [inner-layers-right](inner-layers-right-solved.png) | 880.425 | 810.899 | 7.90% | 68.655 | 10.481 |
| [inner-layers-left](inner-layers-left-solved.png) | 983.289 | 802.029 | 18.43% | 126.337 | 35.854 |
| [inner-layers-above](inner-layers-above-solved.png) | 1184.358 | 1053.073 | 11.08% | 119.669 | 16.272 |
| [inner-layers-complete-ca](inner-layers-complete-ca-solved.png) | 1521.211 | 1425.785 | 6.27% | 162.068 | 18.309 |

Measured on Linux x86_64 with Bun 1.4.0, serially in fresh worker processes. Compaction adds a median 10.07 seconds per sample (range 5.22–35.85 seconds). Routing time includes matching and compaction; native fixture/output audits are reported separately in the total elapsed time. [Full benchmark measurements](../../benchmark-results.json).

## Matching and geometry

Skew measures full pad-to-pad planar copper, including fixed terminal escapes. BYTE0, BYTE1 and complete-CA limits remain 0.635 mm; all three pair limits remain 0.127 mm. The existing numerical tolerances are unchanged.

| Sample | BYTE0 / BYTE1 / CA skew (mm) | DQS0 / DQS1 / CK skew (mm) | Native DRC |
| --- | --- | --- | --- |
| control | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.072830 | 0 errors |
| right | 0.635000 / 0.635000 | 0.096047 / 0.121802 / 0.102644 | 0 errors |
| left | 0.635000 / 0.635000 | 0.010514 / 0.127000 / 0.105429 | 0 errors |
| above | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 | 0 errors |
| inner-layers | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.127000 | 0 errors |
| inner-layers-right | 0.635000 / 0.635000 | 0.123649 / 0.127000 / 0.127000 | 0 errors |
| inner-layers-left | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.105429 | 0 errors |
| inner-layers-above | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 | 0 errors |
| inner-layers-complete-ca | 0.635000 / 0.635000 / 0.635000 | 0.020663 / 0.127000 / 0.072830 | 0 errors |

The pipeline tries up to two bounded linear compaction proposals. Ordinary segment directions and each matched signal’s length remain fixed, sampled curves move rigidly, and differential-pair routes, vias and endpoints retain their geometry. Unconstrained signals may shorten. Clearance constraints are added around actual copper conflicts, including returning arms of the same trace. A candidate must reduce the signal envelope without expanding any bound and pass the existing carrier, angle, self-clearance, terminal-via, skew and coupling validators. Interruptions, resource caps and failed proposals preserve the most recently accepted complete route.

## Reproduce

```sh
bun install
bun run typecheck
bun test
bun run format:check
bun run test:package
./benchmark.sh --require-all-solved
bun scripts/snapshot-routed-am3352.ts docs/envelope-compaction 180
```

The snapshots linked above are rendered from the final benchmark routes. The standard exporter independently revalidates every declared sample before writing any image.

All nine AM3352 images were inspected after successful validation. They show complete signal routes on the allowed layers, intact terminal escapes and preserved tuning banks.

## Validation

`bun test` passes all 298 tests across 109 files (536,065 assertions). Type checking, formatting, and isolated Node/browser/TypeScript package-consumer checks also pass. Regression coverage includes fixed-copper avoidance, rotations/reflections, matched length preservation, rigid curves, carrier reassembly and interruption recovery.

The four legacy DDR placements also complete 33/33 routes each. Their regenerated snapshots were inspected: [left](legacy-ddr/ddr_left_io_right-solved.png), [right](legacy-ddr/ddr_right_io_left-solved.png), [top](legacy-ddr/ddr_top_io_bottom-solved.png), and [bottom](legacy-ddr/ddr_bottom_io_top-solved.png). These use the standalone solver and are outside the nine-case area comparison.
