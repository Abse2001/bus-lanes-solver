# Reference benchmark result

Ran `./benchmark.sh` at repository revision `463734fa7ec4581a0e7ba2a1afacdf6715f1b37e`, with Bun 1.3.14 and the default 180-second budget per case. Five of nine cases passed complete connectivity, native copper DRC and declared matching. Four exhausted their wall-clock budget; they are not counted as routing passes. The command exits zero for recorded search-budget outcomes unless `--require-all-solved` is supplied.

This suite ran concurrently with the mini-PC reproduction attempts; the runtimes are observations from this run, not a performance comparison. No native solver implementation changed. Failed or intermediate route images are not included.

| Case | Result | Qualified connectivity | DRC / matching | Runtime | Bus total planar copper skew (mm) | Pair skew (mm) |
| --- | --- | --- | --- | ---: | --- | --- |
| control | solved | 47/47 | Pass | 56.932 s | DDR_BYTE0: 0.635000; DDR_BYTE1: 0.635000 | pair_0: 0.077868; pair_1: 0.126884; pair_2: 0.072830 |
| right | solved | 47/47 | Pass | 74.998 s | DDR_BYTE0: 0.635000; DDR_BYTE1: 0.635000 | pair_0: 0.096047; pair_1: 0.121802; pair_2: 0.102644 |
| left | solved | 47/47 | Pass | 74.065 s | DDR_BYTE0: 0.635000; DDR_BYTE1: 0.635000 | pair_0: 0.010514; pair_1: 0.127000; pair_2: 0.105429 |
| above | solved | 47/47 | Pass | 161.274 s | DDR_BYTE0: 0.635000; DDR_BYTE1: 0.635000 | pair_0: 0.127000; pair_1: 0.127000; pair_2: 0.127000 |
| inner-layers | solved | 47/47 | Pass | 113.315 s | DDR_BYTE0: 0.635000; DDR_BYTE1: 0.635000 | pair_0: 0.077868; pair_1: 0.126884; pair_2: 0.127000 |
| inner-layers-right | timed_out | unqualified | unqualified | 182.330 s | unqualified | unqualified |
| inner-layers-left | timed_out | unqualified | unqualified | 183.592 s | unqualified | unqualified |
| inner-layers-above | timed_out | unqualified | unqualified | 180.336 s | unqualified | unqualified |
| inner-layers-complete-ca | timed_out | unqualified | unqualified | 182.461 s | unqualified | unqualified |

The `inner-layers-right` case reported 47 provisional traces at its deadline, but completed validation was not obtained, so it remains a timeout. The remaining timed-out cases reported zero traces.

Raw benchmark report SHA-256: `c0554b8dc30b1f7fd535c92e2121587bd3ed29c4f0c52a4b4ccbbc1f10f3d0e3`. The local diagnostic report is `.cache/am3352-mini-pc-inner-layers/upstream-benchmark.json`.
