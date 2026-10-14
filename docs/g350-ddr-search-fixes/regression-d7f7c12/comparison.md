# G350 stacked fix regression comparison

Baseline: `c1151212be7b9de4b34b07436d135d874e6c0466`. Fix: `d7f7c1254d34dfdd2853f069d7277c79ce6ebf5e`. Budget: 3600 seconds per sample.
Both frozen-source manifests were verified against their declared Git revisions; required run provenance binds the exact report, fixture inputs, and accepted cache hashes.

Both revisions independently accepted all eleven samples with 47/47 signals, unchanged inputs and 161 immutable power dogbones, combined-copper DRC, full-copper bus/pair matching, and coupling. Lost completions: none.
These are the eleven existing 47-signal benchmark cases. The new 49-signal G350 repro requires a separate acceptance result.

All eleven signal route geometries byte-identical: true.
All eleven complete accepted cache files byte-identical: true.

Serial baseline; Serial candidate. Both runs shared this cloud machine with separate investigation or G350 validation processes. One run per revision/placement, without alternating paired execution. Timing differences are descriptive; concurrent work limits runtime isolation. This comparison verifies completion, DRC, and matching preservation.

| Percentile | Baseline (s) | Fix (s) | Change |
| --- | ---: | ---: | ---: |
| P50 | 75.680 | 250.134 | +230.5% |
| P80 | 217.326 | 674.672 | +210.4% |
| P90 | 623.335 | 1985.732 | +218.6% |
| P95 | 782.021 | 2755.899 | +252.4% |

| Sample | Connectivity / DRC | Baseline (s) | Fix (s) | Change | Baseline / fix iterations | Identical routes / cache |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| control | 47/47 / pass | 32.290 | 105.768 | +227.6% | 50026 / 50026 | true / true |
| control-inner1 | 47/47 / pass | 940.706 | 3526.065 | +274.8% | 70649 / 70649 | true / true |
| right | 47/47 / pass | 24.518 | 73.336 | +199.1% | 51405 / 51405 | true / true |
| left | 47/47 / pass | 31.748 | 100.462 | +216.4% | 82820 / 82820 | true / true |
| above | 47/47 / pass | 36.459 | 106.289 | +191.5% | 101425 / 101425 | true / true |
| inner-layers | 47/47 / pass | 48.119 | 142.530 | +196.2% | 123305 / 123305 | true / true |
| inner-layers-right | 47/47 / pass | 75.680 | 250.134 | +230.5% | 159783 / 159783 | true / true |
| inner-layers-left | 47/47 / pass | 152.304 | 439.600 | +188.6% | 242818 / 242818 | true / true |
| inner-layers-above | 47/47 / pass | 186.581 | 538.316 | +188.5% | 320306 / 320306 | true / true |
| inner-layers-complete-ca | 47/47 / pass | 217.326 | 674.672 | +210.4% | 68571 / 68571 | true / true |
| outer-layers | 47/47 / pass | 623.335 | 1985.732 | +218.6% | 3752529 / 3752529 | true / true |

Total planar copper skews include any fixed signal fanouts and new interconnect. They do not represent electrical propagation delay.

| Sample | Baseline bus skew / tolerance (mm) | Fix bus skew / tolerance (mm) | Baseline pair skew / tolerance (mm) | Fix pair skew / tolerance (mm) |
| --- | --- | --- | --- | --- |
| control | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | pair_0: 0.077868 / 0.127; pair_1: 0.126884 / 0.127; pair_2: 0.072830 / 0.127 | pair_0: 0.077868 / 0.127; pair_1: 0.126884 / 0.127; pair_2: 0.072830 / 0.127 |
| control-inner1 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | pair_0: 0.048900 / 0.127; pair_1: 0.004720 / 0.127; pair_2: 0.002792 / 0.127 | pair_0: 0.048900 / 0.127; pair_1: 0.004720 / 0.127; pair_2: 0.002792 / 0.127 |
| right | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | pair_0: 0.096047 / 0.127; pair_1: 0.121802 / 0.127; pair_2: 0.102644 / 0.127 | pair_0: 0.096047 / 0.127; pair_1: 0.121802 / 0.127; pair_2: 0.102644 / 0.127 |
| left | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.511147 / 0.635 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.511147 / 0.635 | pair_0: 0.010514 / 0.127; pair_1: 0.127000 / 0.127; pair_2: 0.105429 / 0.127 | pair_0: 0.010514 / 0.127; pair_1: 0.127000 / 0.127; pair_2: 0.105429 / 0.127 |
| above | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | pair_0: 0.127000 / 0.127; pair_1: 0.127000 / 0.127; pair_2: 0.127000 / 0.127 | pair_0: 0.127000 / 0.127; pair_1: 0.127000 / 0.127; pair_2: 0.127000 / 0.127 |
| inner-layers | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | pair_0: 0.077868 / 0.127; pair_1: 0.126884 / 0.127; pair_2: 0.127000 / 0.127 | pair_0: 0.077868 / 0.127; pair_1: 0.126884 / 0.127; pair_2: 0.127000 / 0.127 |
| inner-layers-right | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | pair_0: 0.127000 / 0.127; pair_1: 0.127000 / 0.127; pair_2: 0.127000 / 0.127 | pair_0: 0.127000 / 0.127; pair_1: 0.127000 / 0.127; pair_2: 0.127000 / 0.127 |
| inner-layers-left | DDR_BYTE0: 0.634990 / 0.635; DDR_BYTE1: 0.634992 / 0.635 | DDR_BYTE0: 0.634990 / 0.635; DDR_BYTE1: 0.634992 / 0.635 | pair_0: 0.126990 / 0.127; pair_1: 0.000001 / 0.127; pair_2: 0.105429 / 0.127 | pair_0: 0.126990 / 0.127; pair_1: 0.000001 / 0.127; pair_2: 0.105429 / 0.127 |
| inner-layers-above | DDR_BYTE0: 0.634991 / 0.635; DDR_BYTE1: 0.634993 / 0.635 | DDR_BYTE0: 0.634991 / 0.635; DDR_BYTE1: 0.634993 / 0.635 | pair_0: 0.126915 / 0.127; pair_1: 0.126990 / 0.127; pair_2: 0.000001 / 0.127 | pair_0: 0.126915 / 0.127; pair_1: 0.126990 / 0.127; pair_2: 0.000001 / 0.127 |
| inner-layers-complete-ca | DDR_BYTE0: 0.634990 / 0.635; DDR_BYTE1: 0.634992 / 0.635; DDR_ADDR_CTRL_CK: 0.634994 / 0.635 | DDR_BYTE0: 0.634990 / 0.635; DDR_BYTE1: 0.634992 / 0.635; DDR_ADDR_CTRL_CK: 0.634994 / 0.635 | pair_0: 0.075359 / 0.127; pair_1: 0.000000 / 0.127; pair_2: 0.066384 / 0.127 | pair_0: 0.075359 / 0.127; pair_1: 0.000000 / 0.127; pair_2: 0.066384 / 0.127 |
| outer-layers | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | DDR_BYTE0: 0.635000 / 0.635; DDR_BYTE1: 0.635000 / 0.635 | pair_0: 0.019219 / 0.127; pair_1: 0.127000 / 0.127; pair_2: 0.127000 / 0.127 | pair_0: 0.019219 / 0.127; pair_1: 0.127000 / 0.127; pair_2: 0.127000 / 0.127 |
