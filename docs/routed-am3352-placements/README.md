# Compact powered AM3352 routing

The compact matcher uses more rounded cells along each available run and tries
narrower tuning banks before widening the routes. Differential pairs use shared
curves; their bend radius and spacing are preserved. The algorithm computes all
routes from the native input without saved signal geometry.

| Placement | Overall bounds area (mm²) | Reduction | Signal-only reduction | Middle offset (mm) | Routing | Total with validation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Control | 1104.2 → 725.1 | 34.3% | 34.3% | 13.60 → 9.20 | 15.326 s | 17.587 s |
| Right | 1174.3 → 804.2 | 31.5% | 32.2% | 17.00 → 12.50 | 19.055 s | 24.753 s |
| Left | 1615.0 → 1022.2 | 36.7% | 35.5% | 22.06 → 14.86 | 21.383 s | 27.463 s |
| Above | 1524.6 → 930.9 | 38.9% | 38.9% | 18.40 → 11.46 | 26.453 s | 31.397 s |

Baseline: PR #12 at `d8f004d`. Both measurements use fresh computed routes on
macOS arm64 with Bun 1.3.2. Overall area is the bounding rectangle of signal and fixed power copper,
including wire radii and via pads. Signal-only area excludes fixed power copper. Middle offset is the greatest distance from the physical chip-center axis
within the open inter-package window. The [comparison](footprint-comparison.json)
also records signal bounds for every copper layer. These are measurements, not solver
inputs or acceptance shortcuts.

`./benchmark.sh --timeout-seconds 30 --require-all-solved` runs exactly the four
samples. The [full report](benchmark-results.json) records 47/47 connectivity,
native DRC, pad-to-pad length matching, unchanged power dogbones, corner checks,
and zero exterior pair separation for all four. Each byte bus stays within
0.635 mm skew and every pair within 0.127 mm, including numerical epsilon.

The images below come from a separate fresh run of
`bun scripts/snapshot-routed-am3352.ts docs/routed-am3352-placements 30`.
The exporter validates all four before writing images; every image was inspected.

- [Control](control-solved.png)
- [Right](right-solved.png)
- [Left](left-solved.png)
- [Above](above-solved.png)
