# Nine-case AM3352 benchmark

The standard benchmark now includes `inner-layers-complete-ca`: the powered inner-layer fixture with its complete 24-signal CA/clock bus. The other eight cases retain their two byte buses. Every sample uses the same strict native constraint, connectivity, copper, skew and coupling audits. The new case is required by `--require-all-solved` and the snapshot exporter. The default/CI deadline is 180 seconds per sample; explicit overrides still apply to every sample.

Measured on Linux x86_64, Bun 1.4.2. All nine passed, with 47/47 signals, native DRC/coupling and unchanged 161 fixed power dogbones. Routing code and geometry are unchanged in this PR. The linked successful routed snapshots were inspected; the complete-CA snapshot has the same native input and all three timing groups.

| Sample / routed snapshot | Runtime (s) | Signal envelope (mm²) | Bus skews (mm) | Pair skews (mm) |
| --- | ---: | ---: | --- | --- |
| [control](routed-am3352-complete-ca/baseline/control-solved.png) | 20.710 | 412.370 | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.072830 |
| [right](routed-am3352-complete-ca/baseline/right-solved.png) | 19.831 | 660.450 | 0.635000 / 0.635000 | 0.096047 / 0.121802 / 0.102644 |
| [left](routed-am3352-complete-ca/baseline/left-solved.png) | 27.015 | 568.859 | 0.635000 / 0.635000 | 0.010514 / 0.127000 / 0.105429 |
| [above](routed-am3352-complete-ca/baseline/above-solved.png) | 35.240 | 638.400 | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 |
| [inner-layers](routed-am3352-complete-ca/baseline/inner-layers-solved.png) | 35.674 | 468.312 | 0.635000 / 0.635000 | 0.077868 / 0.126884 / 0.127000 |
| [inner-layers-right](routed-am3352-complete-ca/baseline/inner-layers-right-solved.png) | 46.070 | 880.425 | 0.635000 / 0.635000 | 0.123649 / 0.127000 / 0.127000 |
| [inner-layers-left](routed-am3352-complete-ca/baseline/inner-layers-left-solved.png) | 61.637 | 983.289 | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.105429 |
| [inner-layers-above](routed-am3352-complete-ca/baseline/inner-layers-above-solved.png) | 82.052 | 1184.358 | 0.635000 / 0.635000 | 0.127000 / 0.127000 / 0.127000 |
| [inner-layers-complete-ca](routed-am3352-complete-ca/complete-ca-solved.png) | 113.002 | 1521.211 | 0.635000 / 0.635000 / 0.635000 | 0.020663 / 0.127000 / 0.072830 |

Run `./benchmark.sh --require-all-solved` for all nine, or `bun scripts/benchmark.ts --worker inner-layers-complete-ca --timeout-seconds 180` for the added case. The runner retains failures in its score and strict mode exits nonzero. Tests reject removal, relaxed skew or changed membership of the CA bus.

These are routing and relative-skew benchmarks. TI absolute-length limits and full board electrical compliance remain separate; the complete-CA result still exceeds the SBC absolute ceiling.
