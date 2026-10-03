# Eight powered AM3352/RAM routing placements

The processor stays at (0, 0) mm. RAM moves below, right, left, and above it;
each placement is tested with automatic signal layers and with only inner1/inner2.
Every run computes routes from the original pads. Supplied power dogbones remain
immutable obstacles, including their through-via barrels.

The strict local benchmark completes **8/8 within 60 seconds per sample**:

| Sample | Routing | Including validation | Signals | Native DRC | Byte 0 / byte 1 skew | DQS0 / DQS1 / clock skew |
| --- | ---: | ---: | --- | --- | --- | --- |
| control | 11.820 s | 13.829 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.078 / 0.127 / 0.073 mm |
| right | 11.672 s | 14.131 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.096 / 0.122 / 0.103 mm |
| left | 16.875 s | 22.447 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.011 / 0.127 / 0.105 mm |
| above | 22.219 s | 26.641 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.127 / 0.127 / 0.127 mm |
| inner-layers | 23.005 s | 25.132 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.078 / 0.127 / 0.127 mm |
| inner-layers-right | 27.804 s | 29.977 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.124 / 0.127 / 0.127 mm |
| inner-layers-left | 37.722 s | 44.356 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.127 / 0.127 / 0.105 mm |
| inner-layers-above | 48.481 s | 54.075 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.127 / 0.127 / 0.127 mm |

Measurements use Bun 1.3.2 on macOS arm64. All samples have 47/47 signals,
161 unchanged power dogbones, native combined-copper DRC, full pad-to-pad byte-bus
skew ≤0.635 mm and differential-pair skew ≤0.127 mm (including numerical epsilon).
Exterior pair spacing, self-clearance, and conventional-angle checks also pass.
Routing includes length matching; the total column adds fixture/native validation.
The [complete report](benchmark-results.json) retains quality and provenance data.

Run `./benchmark.sh --require-all-solved` to reproduce all eight measurements.
Generate routed artifacts with
`bun scripts/snapshot-routed-am3352.ts docs/routed-am3352-placements 60`.
The exporter validates every declared sample before writing any images.

| RAM position | Automatic layers | Inner1/inner2 only |
| --- | --- | --- |
| Below | [Routed control](control-solved.png) | [Routed below](inner-layers-solved.png) |
| Right | [Routed right](right-solved.png) | [Routed inner right](inner-layers-right-solved.png) |
| Left | [Routed left](left-solved.png) | [Routed inner left](inner-layers-left-solved.png) |
| Above | [Routed above](above-solved.png) | [Routed inner above](inner-layers-above-solved.png) |

`footprint-comparison.json` records the earlier four-placement compaction study;
it is historical evidence, not the current eight-placement benchmark.


## Two-layer envelope compaction

The combined signal bounding-box area decreases **29.4%**, from 4,981.89 to
3,516.38 mm², relative to the merged #21 baseline (`e3725b4`). Every placement
improves; automatic-layer routes retain their previous geometry.

| RAM position | Before signal area | After signal area | Reduction | Middle envelope before → after |
| --- | ---: | ---: | ---: | ---: |
| Below | 474.66 mm² | 468.31 mm² | 1.3% | 365.95 → 363.35 mm² |
| Right | 908.32 mm² | 880.43 mm² | 3.1% | 678.81 → 667.74 mm² |
| Left | 1381.39 mm² | 983.29 mm² | 28.8% | 977.16 → 688.03 mm² |
| Above | 2217.52 mm² | 1184.36 mm² | 46.6% | 1217.31 → 680.41 mm² |

Banks reserve extra tuning space for bus members and for pairs with large shared
length deficits; unconstrained controls need only copper clearance. Dense folded
curves use the resulting narrower banks, with a bounded larger candidate budget
before falling back to wider banks. A final control-only pass slides supporting
lines inward without changing segment directions, increasing length, moving
endpoints, or modifying paired/matched copper. Every candidate checks obstacle,
trace, and self-clearance.

No sample names or saved geometry enter these algorithms. The
[before/after measurements](two-layer-envelope-comparison.json) also retain the
unoccupied middle area and maximum center offset. Bounding-box area is a layout
score, not a claim that every point inside the box contains copper. Fixed VCC/GND
dogbones remain unchanged and can still determine the total board envelope.
