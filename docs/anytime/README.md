# Anytime bus routing with coordinated space allocation

The new search changes complete routing groups and the space they occupy. On AM3352 inner-layers-above, the genuine **1x → 5x** prefix reduces the outer carrier envelope **42.64%**, planar signal copper **16.49%**, and independently measured clearance exclusion **16.23%**. All **14 samples × 3 efforts = 42** complete checkpoints pass their original native connectivity, DRC, matching, and pair checks.

[Open the interactive comparison](index.html). Select a sample and copper layer, then pan or zoom the linked panels. Every checkpoint uses the same physical viewport. The report embeds exact full-precision routed geometry and runs offline in browsers supporting `DecompressionStream`.

![AM3352 inner-above: exact 1x, 2x and 5x routes at the same physical scale](comparison.png)

Native review snapshots auto-fit each route. The interactive panels and this comparison screenshot use a shared viewport.

## Algorithm

1. Provide provisional endpoint connections immediately with `status: "best_effort"` and explicit violations. Obtain a valid incumbent using the existing initial router, preserving supplied fanouts and local escapes.
2. Discover empty coordinate strips crossed only by straight runs. Move all affected lanes together, collapsing compatible strips from the outside inward while anchoring terminals, vias, immutable copper, and package approaches. Explore cumulative and directional subsets in a bounded beam. Separately recover untuned skeletons and search shorter corridors by rerouting blocking nets together on coarse-to-fine visibility grids.
3. Close overlapping bus and differential-pair constraints into electrical cohorts. Compute a new common length-target vector. Reconstruct banks together across known and newly available pockets, using compact rounded/folded forms and clearance-derived density. Accepted banks can expand or contract their straight legs while retaining bend radii and longitudinal positions. Whole paired lobes can be removed without disturbing the remaining phase. Reserve future immutable handoffs and nonbank approaches during partial construction.
4. Rebase complete transactions onto the latest incumbent. Check original terminal/port identity, width, layer, ownership, immutable escape geometry, whole-copper matching, native continuous clearance, self-clearance, conventional angles, pair coupling, and accepted physical minimum pair gaps. A strictly valid, better transaction replaces the incumbent atomically.
5. Yield after bounded discovery and construction chunks. Continue the identical deterministic sequence at higher effort; failed scratch candidates leave the valid result available. The objective never increases after the first valid route.

The optimizer uses low-level geometry and its own transaction search. The original router creates the first incumbent; the original validator audits later candidates.

The configurable objective is

```text
areaWeight * normalizedArea + skewWeight * skewPenalty + lengthWeight * normalizedLength
```

Default weights are **1, 0.1, 0.2**. Area combines the outer copper envelope, mean physical-layer envelope, mean lane envelope, and mean clearance-exclusion union, normalized by the terminal envelope. Wire radii and via pads count. Tuning-bank rectangles are secondary diagnostics and have no effect on acceptance. Length includes immutable fanouts; skew is mean squared skew normalized by its declared tolerance, floored at minimum trace width. Individual components can trade off while the complete route stays valid.

The default cumulative budgets are **512, 1024, and 2560** optimization steps. Initial routing and independent validation are separate costs. `iterationsPerX` is configurable; a larger base can reach a compact result already at 1x. Additional effort can plateau and does not guarantee a global optimum or proportional elapsed time. `step()` supports external scheduling, and `runIterations(n)` continues beyond the presets.

## All existing positive samples

The table reports physical outer envelopes in mm², total planar signal copper in mm, and signed exclusion reductions from 1x to 5x. Exclusion is measured on one frozen conservative 0.1-mm probe per sample; its union counts overlapping exclusions once and subtracts immutable copper and board exclusions. Summed layer areas use layer-mm². These measurements are independent of the optimizer's score. Negative reductions show a component tradeoff.

| Sample | Signals | 1x envelope | 2x envelope | 5x envelope | Envelope reduction | 1x → 5x copper | Exclusion reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| AM3352 / control | 47 | 412.370 | 412.370 | 412.370 | 0.00% | 1525.838 → 1525.633 | 0.05% |
| AM3352 / right | 47 | 660.450 | 660.450 | 660.450 | 0.00% | 1864.875 → 1870.935 | -0.07% |
| AM3352 / left | 47 | 568.859 | 568.859 | 568.859 | 0.00% | 1916.743 → 1927.418 | 0.34% |
| AM3352 / above | 47 | 638.400 | 638.400 | 638.400 | 0.00% | 2100.815 → 2096.467 | 1.32% |
| AM3352 / inner-layers | 47 | 474.662 | 474.662 | 474.662 | 0.00% | 1622.503 → 1622.425 | 0.01% |
| AM3352 / inner-layers-right | 47 | 908.315 | 908.315 | 908.315 | 0.00% | 2161.650 → 2161.777 | 0.00% |
| AM3352 / inner-layers-left | 47 | 1381.394 | 1381.394 | 1319.329 | 4.49% | 2369.826 → 2282.552 | 5.63% |
| AM3352 / inner-layers-above | 47 | 2217.520 | 2217.520 | 1271.900 | 42.64% | 3195.350 → 2668.320 | 16.23% |
| AM62L / ddr left io right | 33 | 233.303 | 233.303 | 233.303 | 0.00% | 2198.992 → 2201.992 | 0.46% |
| AM62L / ddr right io left | 33 | 144.907 | 144.071 | 138.572 | 4.37% | 2588.706 → 2589.706 | 1.71% |
| AM62L / ddr top io bottom | 33 | 208.073 | 201.084 | 201.122 | 3.34% | 2387.325 → 2374.703 | 5.78% |
| AM62L / ddr bottom io top | 33 | 424.898 | 424.898 | 424.898 | 0.00% | 2414.416 → 2417.416 | 0.08% |
| Three-lane obstacle channel | 3 | 14.688 | 14.688 | 14.688 | 0.00% | 30.787 → 30.787 | 0.00% |
| Skew tolerance / 0.5 mm | 2 | 31.973 | 31.973 | 31.973 | 0.00% | 20.000 → 19.980 | 2.76% |

Inner-above's mean layer envelope falls **31.61%**, mean lane envelope **25.89%**, and normalized objective **32.61%**. Its maximum byte-bus/pair skews remain **0.635 / 0.127 mm**; one pair becomes effectively equal-length. Minimum physical pair gaps, fixed copper, terminals, vias, and package approaches remain unchanged. It regains **200.66 layer-mm²** of conservatively certified probe space; envelope reduction and usable space are distinct measurements.

All 42 native-gated routed PNGs were visually inspected. The browser report was exercised across all 14 samples, 42 effort selections, and 82 available layer views without runtime exceptions. Exact gzip outputs, embedded report geometry, inputs, seeds, and frozen source are hash-checked. The measured source fingerprint is `b62e85919bfe8488075a6db9f0f2c17f2e7c94ec55635a30a3d6d910a0b6d814`.

The report reused pristine, hash-checked initial routes computed independently earlier in this session. It records their original routing cost, new optimization cost, and independent validation overhead separately. Runtimes depend on machine load; the final exporter ran four independent sample workers. No iteration-zero, partial, failed, or provisional routes are review artifacts.

## Original placement benchmark

`./benchmark.sh` was also run against the unchanged original solver. All eight placements completed with 47/47 signals, zero native combined DRC errors, byte-bus skew within 0.635 mm and differential skew within 0.127 mm. The table measures total planar copper, including local escapes. All 161 supplied power dogbones per placement remained immutable.

| Sample | Connectivity | DRC errors | BYTE0 skew (mm) | BYTE1 skew (mm) | Maximum pair skew (mm) | Route seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| control | 47/47 | 0 | 0.635000 | 0.635000 | 0.126884 | 32.63 |
| right | 47/47 | 0 | 0.635000 | 0.635000 | 0.121802 | 27.72 |
| left | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 41.87 |
| above | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 54.64 |
| inner-layers | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 55.86 |
| inner-layers-right | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 76.06 |
| inner-layers-left | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 86.77 |
| inner-layers-above | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 127.78 |

The first benchmark run used a 120-second cap: seven placements passed, and inner-layers-above timed out. That placement passed when rerun with a 240-second cap, taking 127.78 seconds. This is a search/runtime limitation, not a promise that every physical input has a legal route.

## Reproduce and use

```sh
bun scripts/compare-anytime.ts docs/anytime 512 --concurrency 4
bun test
bun run typecheck
bun run test:package
bun run format:check
./benchmark.sh --timeout-seconds 240 --require-all-solved
```

The exporter freezes source, inputs, and pristine seeds. It requires every native checkpoint to pass before writing routed artifacts, and verifies the frozen source again before publication. `--stage-only` retains the complete validated report privately for inspection before copying it into the review directory.

[measurements.json](measurements.json) records every raw bus/pair length, physical metric, objective component, budget, acceptance count, validation result, source fingerprint, and input/output hash. `outputs/<sample>-<effort>x.json.gz` contains the exact output SRJ. The public API and continuation example are in the [repository README](../../README.md#anytime-optimization).

Unsupported or physically impossible routing constraints retain a labeled provisional result. Such copper is not fabrication-ready. A valid incumbent is never replaced by that fallback. Tests cover strict candidate/seed acceptance, monotone and deterministic continuation, immutable ports/copper, routing retries, detached snapshots, paired topology changes, and coordinated space allocation. The existing regression suite and isolated Node, browser, and TypeScript package-consumer checks also pass.
