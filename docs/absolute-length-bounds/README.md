# Absolute DDR copper length bounds (work in progress)

This branch adds total-copper `minLength` / `maxLength` constraints to buses, including fixed escape copper, and preserves both length and congestion cost in bounded grid searches. A cheaper but longer prefix must not discard a shorter prefix that can finish within the remaining length budget.

The AM3352 SBC is **not yet demonstrated compliant**. The current experimental repair connected 47/47 signals inside the trial maximum lengths, but complete timing matching and exterior coupling remain unresolved. Diagnostic routes are kept out of these review artifacts.

The snapshots below are completed runs of all nine existing benchmark samples. Each passed its declared connectivity, physical DRC, fixed-power preservation, differential-pair matching and bus-skew checks. These samples do not declare TI absolute minimum/maximum lengths: their passing status is **not DDR compliance**. The two-bus legacy samples also do not constrain the complete CA bus. The complete-CA sample declares all three buses. Every image was visually inspected; the large matching envelopes are visible and remain a problem.

| Sample | Completed snapshot |
|---|---|
| Control | [View](baseline/control-solved.png) |
| Right | [View](baseline/right-solved.png) |
| Left | [View](baseline/left-solved.png) |
| Above | [View](baseline/above-solved.png) |
| Inner layers | [View](baseline/inner-layers-solved.png) |
| Inner layers, right | [View](baseline/inner-layers-right-solved.png) |
| Inner layers, left | [View](baseline/inner-layers-left-solved.png) |
| Inner layers, above | [View](baseline/inner-layers-above-solved.png) |
| Inner layers, complete CA | [View](baseline/inner-layers-complete-ca-solved.png) |

Reproduce the gallery with `bun scripts/snapshot-routed-am3352.ts docs/absolute-length-bounds/baseline 300`. The exporter refuses to write artifacts unless all nine runs succeed and pass independent validation.

The board's custom `algorithmFn` imports a self-contained candidate bundle, with source and bundle SHA-256 provenance, supplies strict TI length bounds, and independently rejects failing timing or exterior pair coupling. The board's saved copper has not been replaced.
