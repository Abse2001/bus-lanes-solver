# Eight powered AM3352/RAM routing placements

The processor stays at (0, 0) mm. RAM moves below, right, left, and above it;
each placement is tested with automatic signal layers and with only inner1/inner2.
Every run computes routes from the original pads. Supplied power dogbones remain
immutable obstacles, including their through-via barrels.

The strict local benchmark completes **8/8 within 60 seconds per sample**:

| Sample | Routing | Including validation | Signals | Native DRC | Byte 0 / byte 1 skew | DQS0 / DQS1 / clock skew |
| --- | ---: | ---: | --- | --- | --- | --- |
| control | 11.293 s | 13.271 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.078 / 0.127 / 0.073 mm |
| right | 11.109 s | 13.465 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.096 / 0.122 / 0.103 mm |
| left | 15.366 s | 20.820 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.011 / 0.127 / 0.105 mm |
| above | 19.436 s | 23.556 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.127 / 0.127 / 0.127 mm |
| inner-layers | 20.424 s | 22.543 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.078 / 0.127 / 0.127 mm |
| inner-layers-right | 26.309 s | 28.496 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.124 / 0.127 / 0.127 mm |
| inner-layers-left | 38.595 s | 44.321 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.127 / 0.127 / 0.105 mm |
| inner-layers-above | 56.388 s | 59.221 s | 47/47 | Pass | 0.635 / 0.635 mm | 0.127 / 0.127 / 0.127 mm |

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
