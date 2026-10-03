# AM3352 placement artifacts

The current benchmark declares eight samples, including all four RAM placements restricted to inner1 and inner2. See the [current report](../../benchmark-results.json) and [timing table](../../README.md#am3352-placement-benchmark). 7/8 currently pass; no new expanded snapshot set has been exported because the exporter requires every declared sample to pass. The images and measurements below are historical results from the earlier four-case revision.

## Previous four-placement snapshot run

This update starts from merged PR #18 (`e50b499`), including its native-pad and package-local pair-tuning fixes. Bank entrances now reserve longitudinal space only for lanes they cross, including full differential-channel width. That opens longer central runs and allows narrower banks. A new rounded folded serpentine can fill a short, taller pocket by running back and forth across it. It preserves radius, tangency, emitted copper length, and offset pair geometry.

Ordinary meanders and partial banks retain priority. Folded single-lane candidates run only if those cannot complete, from the untouched input geometry, with a separate 128-candidate cap. Shared folded candidates remain within the existing paired budget. Fold width is solved from emitted chord length in closed form; there is no amplitude bisection. Entrance ordering costs O(n²) lane comparisons and a DAG traversal, and narrow-bank probes get one tuning attempt before the established fallbacks.

| Placement | Overall copper bounds (mm²) | Further reduction | Routing | Total with validation |
| --- | ---: | ---: | ---: | ---: |
| Control | 683.1 → 606.5 | 11.2% | 13.764 s | 15.820 s |
| Right | 686.5 → 686.5 | 0.0% | 12.888 s | 15.291 s |
| Left | 854.3 → 628.3 | 26.5% | 18.396 s | 23.967 s |
| Above | 810.6 → 810.6 | 0.0% | 27.707 s | 33.255 s |

Fresh computed routes on macOS arm64 / Bun 1.3.2. Bounds include signal and fixed power copper, wire radii and via pads. Control and left shrink further; right and above retain their previous total bounds. These are measurements, not saved solver inputs or special acceptance rules. CI retains its existing 180-second deadline because runner speeds vary.

The four-placement gains come from better entrance allocation and narrower banks. Folded curves add a tested alternative for blocked pockets; they are not forced into a layout when the established dense curves already fit. A regression fixture fits 8 mm of additional copper into an obstacle-bounded pocket under 0.775 mm high, with conventional tangents and clearance.

| Placement | Unoccupied middle area before → after (mm² across layers) | BYTE0 skew | BYTE1 skew | Largest pair skew |
| --- | ---: | ---: | ---: | ---: |
| Control | 189.3 → 165.7 | 0.635000 mm | 0.635000 mm | 0.126884 mm |
| Right | 314.0 → 348.3 | 0.635000 mm | 0.635000 mm | 0.121802 mm |
| Left | 335.2 → 215.7 | 0.635000 mm | 0.635000 mm | 0.127000 mm |
| Above | 236.5 → 240.7 | 0.635000 mm | 0.635000 mm | 0.127000 mm |

The [comparison](footprint-comparison.json) retains per-layer envelopes, free area/fraction and largest empty rectangles. Clearance-aware vacancy uses whole 0.1 mm cells (coarser above 250,000 cells) in the open inter-package window. Summed layer area is not board area. Lower vacancy alone is not a goal: shorter copper can leave more free area inside unchanged bounds. Exact native DRC remains authoritative.

`./benchmark.sh --timeout-seconds 30 --require-all-solved` runs exactly four cases. The [full report](benchmark-results.json) confirms 47/47 signals, native DRC, both byte buses ≤0.635 mm total copper skew, pairs ≤0.127 mm, zero exterior pair separation, and 161 unchanged VCC/GND dogbones in every case (including numerical epsilon).

All four images are from a separate fresh run of `bun scripts/snapshot-routed-am3352.ts docs/routed-am3352-placements 30`. The exporter validates all four before writing any artifact. Every image was inspected.

- [Control](control-solved.png)
- [Right](right-solved.png)
- [Left](left-solved.png)
- [Above](above-solved.png)
