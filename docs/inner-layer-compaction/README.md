# Inner-layer envelope compaction

Against merged PR #38 (**`63bc112`**), the five inner-layer-only samples have a further **6.11% unweighted mean area reduction**. Their summed signal-envelope area falls **9.36%**, from **4,212.12 to 3,817.75 mm²**. The four original placements retain exactly their merged signal-envelope areas. No sample regresses.

The improvement is concentrated in the complete command/address sample; the table shows each case separately. Every final worker completes 47/47 routes, passes native combined-copper DRC, full-pad bus/pair length matching and exterior coupling, and preserves the original input plus all 161 fixed FanoutSolver power dogbones.

The mean weights the five inner-layer samples equally. Aggregate reduction is `1 - sum(after) / sum(before)` for those five. Signal envelopes include trace radii and terminal via lands; the JSON also reports bounds including fixed power copper.

| Completed sample | Merged area (mm²) | New area (mm²) | Further reduction | Merged solve (s) | New solve (s) | Added group search (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [control](control-solved.png) | 376.473 | 376.473 | 0.00% | 72.178 | 58.607 | 0.000 |
| [right](right-solved.png) | 658.597 | 658.597 | 0.00% | 56.577 | 43.364 | 0.000 |
| [left](left-solved.png) | 560.795 | 560.795 | 0.00% | 103.145 | 69.312 | 0.000 |
| [above](above-solved.png) | 614.360 | 614.360 | 0.00% | 73.790 | 68.044 | 0.000 |
| [inner-layers](inner-layers-solved.png) | 419.080 | 419.080 | 0.00% | 91.959 | 106.225 | 0.000 |
| [inner-layers-right](inner-layers-right-solved.png) | 788.424 | 788.424 | 0.00% | 146.739 | 144.277 | 0.000 |
| [inner-layers-left](inner-layers-left-solved.png) | 723.468 | 723.058 | 0.06% | 229.613 | 282.030 | 48.778 |
| [inner-layers-above](inner-layers-above-solved.png) | 941.052 | 906.054 | 3.72% | 190.999 | 375.973 | 167.225 |
| [inner-layers-complete-ca](inner-layers-complete-ca-solved.png) | 1340.099 | 981.139 | 26.79% | 285.118 | 425.074 | 147.734 |

## Runtime and measurements

Recorded total solve time across all nine samples is **1250.1 → 1572.9 seconds** (+25.8%). The new group-search column isolates the added work. These are wall times from a shared Linux x86_64 / Bun 1.4.0 environment, not a controlled speed comparison: the merged measurements are retained from PR #38, and the fresh final benchmark ran alongside regression checks.

The new search costs additional optimization time on eligible inner-layer cases. The CI benchmark uses a 480-second allowance; the CLI default remains 180 seconds and existing test timeouts are unchanged. The benchmark job permits 40 minutes for all nine serial workers. Resource or cancellation limits preserve the best complete validated route, but a strict benchmark still reports a solve-budget overrun as a timeout.

[Baseline measurements](baseline.json) and [final measurements](../../benchmark-results.json) include connectivity, native DRC, full-copper lengths, quality, and runtime. Every final sample was routed from its native input in a fresh CLI worker. `envelopeOptimization.beforeAreaMm2` precedes all compaction stages; `cohortBeforeAreaMm2` is the accepted envelope before the new group search.

## Full-copper matching

Declared bus skew limits remain 0.635 mm and pair limits remain 0.127 mm. Lengths include immutable fanouts and generated terminal escapes. Displayed values are rounded; output acceptance tolerances are unchanged.

| Sample | BYTE0 / BYTE1 / CA skew (mm) | DQS0 / DQS1 / CK skew (mm) | Native DRC |
| --- | --- | --- | --- |
| control | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.072830 | 0 errors |
| right | 0.635000 / 0.635000 | 0.096047 / 0.121802 / 0.102644 | 0 errors |
| left | 0.635000 / 0.511147 | 0.010514 / 0.127000 / 0.105429 | 0 errors |
| above | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 | 0 errors |
| inner-layers | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.127000 | 0 errors |
| inner-layers-right | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 | 0 errors |
| inner-layers-left | 0.634990 / 0.634992 | 0.126990 / 0.000001 / 0.105429 | 0 errors |
| inner-layers-above | 0.634991 / 0.634993 | 0.126915 / 0.126990 / 0.000001 | 0 errors |
| inner-layers-complete-ca | 0.634990 / 0.634992 / 0.634994 | 0.075359 / 0.000000 / 0.066384 | 0 errors |

## Method and checks

The existing compactor runs unchanged first. For routing restricted to inner layers, the new phase runs only when a bus or differential signal supports the outer envelope. It groups each bus with its paired rails, holds the other carriers fixed, and compacts smaller groups before larger ones. An interior group can shrink without immediately reducing the board envelope, leaving room for a later group. The pipeline publishes only complete validated results whose actual area improves on the best accepted route.

Each proposal has a 2 mm displacement window, at most 24 cutting-plane rounds, a 4,096-pivot simplex limit, and the existing 64/96-million-cell memory bounds. At most four sweeps run; another sweep requires at least 0.1% envelope progress over the preceding complete sweep. A guarded fallback pins existing via approaches when a candidate fails their clearance check.

Paired tuning banks can contract their straight legs while sampled arcs retain their shape and radius. Ordinary segment directions, endpoints, vias, and supplied fanouts remain fixed. The group LP reserves matching slack and restores direction equalities after simplex rounding. Numerically stationary translations are pinned in the returned proposal, and group validation uses a slightly stricter copper boundary to cover the native checker. No output DRC or matching limit is relaxed.

Each local candidate passes terminal-via, self-clearance, conventional-angle, full-copper length and pair-coupling checks. Before publishing an area improvement, the pipeline also validates the complete carrier set and native exterior coupling. Cancellation or failure retains the private accepted snapshot.

The full suite passed 331 tests across 114 files (541,392 assertions). Regression coverage includes group matching with absolute length limits and fixed copper, bounded full-pad matching in both new modes, direction projection near fixed clearance boundaries, and interruption during an inner-layer group search. Test, typecheck, formatting and isolated Node/browser/TypeScript package-consumer results are recorded in the PR.

## Reproduce and inspect

```sh
bun install
bun test
bun run typecheck
bun run format:check
bun run test:package
./benchmark.sh --require-all-solved --timeout-seconds 480
bun scripts/snapshot-routed-am3352.ts docs/inner-layer-compaction 480
bun scripts/snapshot-routed-ddr.ts docs/inner-layer-compaction/legacy-ddr
```

All nine snapshots were rendered from the successful final benchmark routes. The standard exporter independently revalidated every route before writing the images, and each image was individually inspected.

The four legacy DDR placements also complete 33/33 routes each. Their regenerated and inspected snapshots are [left](legacy-ddr/ddr_left_io_right-solved.png), [right](legacy-ddr/ddr_right_io_left-solved.png), [top](legacy-ddr/ddr_top_io_bottom-solved.png), and [bottom](legacy-ddr/ddr_bottom_io_top-solved.png). They are outside the five-sample inner-layer area comparison.
