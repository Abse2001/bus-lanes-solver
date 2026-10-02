# Interior tuning banks for powered AM3352 routing

The matcher now tries tuning banks inside the package approach envelope before expanding outward. Staggered entrances preserve lane order, with differential pairs treated as one wider channel. The existing rounded, densely packed curves fill these interior banks; unchanged bend-radius, matching and clearance checks decide whether a bank is usable. All routes are computed from native input without saved signal geometry.

| Placement | Overall copper bounds (mm²) | Further reduction | Unoccupied middle area (mm²) | Routing | Total with validation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control | 725.1 → 683.1 | 5.8% | 224.7 → 189.9 | 13.363 s | 14.917 s |
| Right | 804.2 → 686.5 | 14.6% | 418.7 → 314.0 | 15.142 s | 18.930 s |
| Left | 1022.2 → 854.3 | 16.4% | 429.6 → 334.3 | 18.013 s | 23.510 s |
| Above | 930.9 → 810.6 | 12.9% | 291.1 → 236.5 | 25.095 s | 29.839 s |

Baseline: merged PR #14 at `2d33734`. Measurements use fresh computed routes on macOS arm64 with Bun 1.3.2. Overall area is the bounding rectangle of signal and immutable power copper, including wire radii and via pads. Runtime is machine-dependent; CI retains its existing 180-second budget.

The vacancy diagnostic measures each signal layer separately in the open inter-package window. It reports the rectangular envelope, unoccupied area/fraction and largest empty rectangle after reserving copper, clearance and a minimum-width trace radius. Cells are nominally 0.1 mm (coarser above 250,000 cells); the whole-cell safety margin gives a conservative free-area estimate. Layer areas are summed, so this is not a physical board-area measurement. Rotated rectangular obstacles use conservative projected bounds. This metric exposes packing opportunities; it does not replace DRC or reward extra copper merely to fill space.

The [comparison](footprint-comparison.json) includes before/after signal bounds, center offsets and per-layer vacancy. Signal copper length also falls in all four cases.

`./benchmark.sh --timeout-seconds 30 --require-all-solved` runs exactly four samples. The [full report](benchmark-results.json) records 47/47 connectivity, native DRC, pad-to-pad length matching, 161 unchanged power dogbones, conventional corners, and zero exterior pair separation for every placement. Both byte buses stay within 0.635 mm skew and every pair within 0.127 mm (including numerical epsilon).

| Placement | BYTE0 total copper skew | BYTE1 total copper skew | Largest pair skew |
| --- | ---: | ---: | ---: |
| Control | 0.635000 mm | 0.635000 mm | 0.127000 mm |
| Right | 0.635000 mm | 0.635000 mm | 0.127000 mm |
| Left | 0.635000 mm | 0.635000 mm | 0.127000 mm |
| Above | 0.635000 mm | 0.635000 mm | 0.127000 mm |

The images come from a separate fresh run of `bun scripts/snapshot-routed-am3352.ts docs/routed-am3352-placements 30`. All four must pass connectivity, DRC, matching and coupling validation before the exporter writes any images. Every image was inspected.

- [Control](control-solved.png)
- [Right](right-solved.png)
- [Left](left-solved.png)
- [Above](above-solved.png)
