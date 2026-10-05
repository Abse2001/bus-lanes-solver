# Further AM3352 envelope compaction

Against merged **v0.0.19 (`463734f`)**, the unweighted mean signal-envelope reduction is **4.02%** across all nine declared samples. The summed area falls **4.89%**, from **6,752.55 to 6,422.35 mm²**. These are further reductions after the previous compactor.

All nine complete 47/47 routes and pass native combined-copper DRC, declared bus/pair length matching and exterior coupling. Every input and all 161 fixed FanoutSolver power dogbones remain unchanged. No sample's signal envelope increases.

The envelope includes wire radii and terminal via pads. The mean weights each sample equally; the aggregate is `1 - sum(after) / sum(before)`. Fixed power copper also participates in DRC and the separate all-copper bounds in the JSON measurements.

| Sample / completed snapshot | v0.0.19 area (mm²) | New area (mm²) | Further reduction | Baseline solve (s) | New solve (s) | New compaction (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [control](control-solved.png) | 381.904 | 376.473 | 1.42% | 53.840 | 72.178 | 31.104 |
| [right](right-solved.png) | 658.597 | 658.597 | 0.00% | 64.391 | 56.577 | 24.279 |
| [left](left-solved.png) | 567.985 | 560.795 | 1.27% | 74.406 | 103.145 | 35.575 |
| [above](above-solved.png) | 614.360 | 614.360 | 0.00% | 83.261 | 73.790 | 20.904 |
| [inner-layers](inner-layers-solved.png) | 437.914 | 419.080 | 4.30% | 103.448 | 91.959 | 36.334 |
| [inner-layers-right](inner-layers-right-solved.png) | 810.899 | 788.424 | 2.77% | 92.426 | 146.739 | 76.698 |
| [inner-layers-left](inner-layers-left-solved.png) | 802.029 | 723.468 | 9.80% | 169.032 | 229.613 | 134.624 |
| [inner-layers-above](inner-layers-above-solved.png) | 1053.073 | 941.052 | 10.64% | 197.049 | 190.999 | 68.999 |
| [inner-layers-complete-ca](inner-layers-complete-ca-solved.png) | 1425.785 | 1340.099 | 6.01% | 213.685 | 285.118 | 105.882 |

Both versions route each sample from its native pads and immutable copper in fresh worker processes, using the same 300-second allowance on Linux x86_64 / Bun 1.4.0. Most measurements ran alongside regression checks; the final inner-layer left/above workers were rerun after those checks finished. Timings therefore include different shared-machine loads and are not a controlled speed comparison. The extra optimization increases runtime. The CLI's default 180-second allowance is unchanged; CI explicitly uses 300 seconds to cover the additional optimization.

[Baseline measurements](baseline.json) and [final measurements](../../benchmark-results.json) include connectivity, native DRC, full-pad copper lengths, quality and runtime. The final report's `envelopeOptimization.beforeAreaMm2` is the area before **all** compaction stages, not the merged baseline used in this table.

## Full-copper matching

Bus limits remain 0.635 mm and pair limits 0.127 mm. Measurements include fixed fanouts and generated terminal escapes. Existing output-validation tolerances are unchanged; the displayed values below are rounded to six decimals.

| Sample | BYTE0 / BYTE1 / CA skew (mm) | DQS0 / DQS1 / CK skew (mm) | Native DRC |
| --- | --- | --- | --- |
| control | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.072830 | 0 errors |
| right | 0.635000 / 0.635000 | 0.096047 / 0.121802 / 0.102644 | 0 errors |
| left | 0.635000 / 0.511147 | 0.010514 / 0.127000 / 0.105429 | 0 errors |
| above | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 | 0 errors |
| inner-layers | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.127000 | 0 errors |
| inner-layers-right | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 | 0 errors |
| inner-layers-left | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.105429 | 0 errors |
| inner-layers-above | 0.635000 / 0.635000 | 0.126915 / 0.127000 / 0.127000 | 0 errors |
| inner-layers-complete-ca | 0.635000 / 0.635000 / 0.635000 | 0.020663 / 0.127000 / 0.066384 | 0 errors |

## Method and validation

The existing conservative search runs first. Coordinated proposals can shorten matched lanes together, subject to full-copper length bounds, while nearby differential rail vertices share a displacement. Flexible banks also shorten straight legs between rigid sampled arcs, preserving bend shapes and radii. A guarded variant pins existing via approaches when an unguarded proposal fails their clearance check. Each neighborhood starts from the conservative result and keeps at most two accepted proposals (one for the guarded fallback). A branch stops when it cannot beat the best route, and alternative neighborhoods stop after a completed neighborhood achieves a 5% reduction from the conservative result. This is a work limit, not a per-sample guarantee. The pipeline publishes the best validated branch.

The area objective uses fractional width/height changes. One extent may grow when the actual total area falls. Ordinary segments keep their directions and remain nonzero. Endpoints, vias and supplied fanouts stay fixed. Every accepted proposal passes the existing carrier, self-clearance, angle, terminal-via, length and coupling checks. Cancellation and unsuccessful searches retain the best complete accepted route.

Collision half-planes are clipped in the two-dimensional relative displacement of each pair of translation groups. Only the polygon boundary contributes simplex rows; degenerate intersections retain all cuts. Advanced searches have at most 12 cutting-plane rounds, a 4,096-pivot limit for each simplex phase and 64 million tableau cells (96 million for guarded banks). These limits bound work; hitting one does not bypass validation.

Regression coverage includes full-pad min/max/skew constraints, coupled rail movement, preserved sampled bends, immutable via approaches, clipping degeneracies and interruption after an accepted improvement. The three long AM3352 integration tests and CI benchmark use a 300-second allowance to cover the additional searches; their geometry and length assertions are unchanged. All 325 tests across 112 files pass (541,310 assertions). Type checking, formatting and isolated Node/browser/TypeScript package-consumer checks also pass.

## Reproduce and inspect

```sh
bun install
bun run typecheck
bun test
bun run format:check
bun run test:package
./benchmark.sh --require-all-solved --timeout-seconds 300
bun scripts/snapshot-routed-am3352.ts docs/envelope-compaction-further 300
bun scripts/snapshot-routed-ddr.ts docs/envelope-compaction-further/legacy-ddr
```

All nine snapshots were rendered from the final benchmark routes. The standard exporter independently revalidated every declared sample before writing any image. Each image was inspected for complete routes, intact fanouts and tuning geometry on the allowed layers.

The four legacy DDR placements also complete 33/33 routes each. Their regenerated, inspected snapshots are [left](legacy-ddr/ddr_left_io_right-solved.png), [right](legacy-ddr/ddr_right_io_left-solved.png), [top](legacy-ddr/ddr_top_io_bottom-solved.png) and [bottom](legacy-ddr/ddr_bottom_io_top-solved.png). These standalone-solver cases are outside the nine-case area comparison.
