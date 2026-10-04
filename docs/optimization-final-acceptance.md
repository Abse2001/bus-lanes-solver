# Preserve completed routes through optimization interruptions

The pipeline stores a private copy only after all signal stages, matching, package coupling, simplification and escape attachment finish. Optional envelope optimization starts after that point. `tryFinalAcceptance()` closes the optimizer and restores the accepted copy, clears failure state and marks the result solved. Repeated final acceptance preserves already solved output. Missing routes never acquire a fallback. Optimizer exceptions also retain the accepted copy and are recorded in stats.

The separate envelope PR supplies the optimization algorithm; the default hook here does no geometry work. Tests interrupt a real two-signal routed bus after corrupting its mutable optimizer state, both explicitly and through the BaseSolver iteration limit, and independently check restored native copper and skew. Additional tests cover optimizer exceptions and unfinished-route rejection.

Validation: 287 tests, typecheck, formatting, and package consumers pass. The nine-case benchmark passes with identical copper metrics to the preceding benchmark PR. All nine [successful routed snapshots](benchmark-nine-samples.md) were inspected. Measured runtime variation is reported below; the change adds one finishing step and a private copy, not another route search.

| Sample | Runtime (s) | Signal envelope (mm²) | Bus skews (mm) | Pair skews (mm) |
| --- | ---: | ---: | --- | --- |
| control | 25.020 | 412.370 | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.072830 |
| right | 22.598 | 660.450 | 0.635000 / 0.635000 | 0.096047 / 0.121802 / 0.102644 |
| left | 27.666 | 568.859 | 0.635000 / 0.635000 | 0.010514 / 0.127000 / 0.105429 |
| above | 36.635 | 638.400 | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 |
| inner-layers | 36.360 | 468.312 | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.127000 |
| inner-layers-right | 46.139 | 880.425 | 0.635000 / 0.635000 | 0.123649 / 0.127000 / 0.127000 |
| inner-layers-left | 62.186 | 983.289 | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.105429 |
| inner-layers-above | 80.529 | 1184.358 | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 |
| inner-layers-complete-ca | 103.937 | 1521.211 | 0.635000 / 0.635000 / 0.635000 | 0.020663 / 0.127000 / 0.072830 |

Every case has 47/47 connectivity, passing native DRC/coupling and immutable fixed power. Timings: Linux x86_64 / Bun 1.4.2. Relative matching remains distinct from full DDR absolute-length compliance.
