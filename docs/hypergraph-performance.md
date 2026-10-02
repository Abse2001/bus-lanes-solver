# Hypergraph routing performance

| Placement | Base solve time (s) | New solve time (s) | Speedup |
| --- | --- | --- | --- |
| Below (control) | 5.426 | 4.898 | 1.11× |
| Right | 371.238 | 146.143 | 2.54× |
| Left | 74.024 | 29.645 | 2.50× |
| Above | 469.881 | 177.851 | 2.64× |
| **Median** | **222.631** | **87.894** | **2.53×** |

Baseline: PR #11 at commit `22e0be6`, with coupled pairs. Both reports were measured on the same local Mac using Bun 1.3.2, with the four samples run serially in fresh processes. The baseline is the previously published complete run; the candidate is a fresh complete run. Solve times include all failed retries and exclude export and the separate physical audit. No starting attempt, saved solution, or sample-specific routing schedule is supplied.

The median is the arithmetic mean of the two middle solve times, not the median of per-sample speedup ratios. A comparison is rejected unless each report contains all four successful, fully audited samples with unchanged input and fixed copper. Timings are host-dependent; compare fresh baseline and candidate runs on the same host when reproducing elsewhere.

## Changes

- Search alternative legal terminal assignments before retrying topology on a congested assignment. A quick first round uses no topology retries and caps the preliminary bus-only search at 20,000 iterations. If all assignments fail, a second round retains the broader search, including topology retries.
- Memoize bounded hard-clear pair approaches within one routing request, with a 16 MiB cap and geometry, clearance, endpoint, grid and search-budget keys. Ignore distant copper that cannot affect the local grid. Mutable soft-cost and history searches bypass the cache. Cached results replay their iteration boundaries for debugger stepping and budget accounting.
- Rasterize each copper clearance halo by row, visiting each candidate cell once. A bounded scanline connectivity preflight rejects provably disconnected goal regions using a superset of legal grid moves. Inconclusive checks fall through to A*.
- Skip grid construction for zero-budget tiers and stop evaluating a paired candidate once one of its ends fails.

The quick round can add work on other inputs that require the broader fallback; the measured speedup applies to these four samples.

## Validation

| Placement | Signals | DRC issues | Byte 0 skew (mm) | Byte 1 skew (mm) | Max pair skew (mm) | Interior pair gap (mm) | Solve time (s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Below (control) | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 0.11981–0.13813 | 4.898 |
| Right | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 0.10000–0.14166 | 146.143 |
| Left | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 0.10869–0.13813 | 29.645 |
| Above | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 0.10000–0.14166 | 177.851 |

All lengths include fixed and local fanout copper. Every sample preserves the original input and all 161 fixed power fanouts, has 47/47 original pad-to-pad connections, and passes independent physical pair-spacing checks (0.0999–0.155 mm edge gap outside the unchanged 6.2 mm terminal allowance). Length-skew comparisons use the validator's existing floating-point epsilon.

121 tests, typecheck, formatting, package consumer checks and Cosmos export pass. The tests cover broader-search fallback, cache invalidation/cancellation/storage bounds, exhaustive fine-grid clearance and scanline connectivity against an independent flood fill.

## Reproduction

```sh
./benchmark.sh --solver hypergraph --require-all-solved \
  --timeout-seconds 1200 --output benchmark-hypergraph-results.json \
  --artifacts docs/hypergraph-am3352
bun scripts/compare-am3352-benchmarks.ts \
  docs/hypergraph-performance-baseline.json benchmark-hypergraph-results.json 2
```

[Baseline report](hypergraph-performance-baseline.json), [candidate report](../benchmark-hypergraph-results.json), and [comparison](hypergraph-performance-results.json).
