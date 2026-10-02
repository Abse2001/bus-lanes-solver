# Four powered AM3352 placements

Generated with `bun scripts/snapshot-routed-am3352.ts docs/routed-am3352-placements 30`.
Every image was inspected after the exporter independently checked all four
completed route sets. The images show native copper on inner1, inner2, and bottom;
the AM3352 remains at (0, 0), and the RAM moves without rotation.

The [benchmark report](benchmark-results.json) is a separate fresh-process run of
`./benchmark.sh --timeout-seconds 30 --require-all-solved` on macOS arm64 with
Bun 1.3.2. All four pass 47/47 connectivity, native DRC, full pad-to-pad bus and
pair matching, and exterior pair spacing. All 161 fixed power dogbones retain
their geometry and provenance. No saved signal routes are supplied to either run.

| Placement | Routing | Total with validation | Image |
| --- | ---: | ---: | --- |
| Control | 12.396 s | 14.187 s | [Routed](control-solved.png) |
| Right | 16.635 s | 18.149 s | [Routed](right-solved.png) |
| Left | 17.949 s | 20.989 s | [Routed](left-solved.png) |
| Above | 21.126 s | 23.322 s | [Routed](above-solved.png) |

All four have zero exterior separated pair length, acute corners, sharp curve
corners, illegal ordinary corners, and non-octilinear ordinary segments. Each
byte bus has at most 0.635 mm skew and every differential pair at most 0.127 mm
(with floating-point epsilon). Meanders and both package approaches are included
in the spacing check outside physical package/fanout regions.
