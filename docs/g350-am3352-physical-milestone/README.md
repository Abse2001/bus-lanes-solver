# G350 AM3352 physical routing milestone

This saved experimental layout connects all **49 DDR signals with zero native DRC issues**. View [Top/Bottom routing](routing.png), [routed SRJ](routed.json), and [native verification](validation.json). The physical routing gate passes; DDR bus length matching fails. It is a previously generated layout that has been freshly verified, not a fresh solver generation or a claim that the public solver completes this problem.

The phase covers the 49 CPU-to-RAM DDR connections only. The 68 support nets remain excluded and unverified. The board has four physical copper layers: DDR signal wires use Top and Bottom; the inner layers remain reserved for ground and power/reference planes. All 854 native pad obstacles and 194 components retain their original geometry and ownership under the explicit reproduction-only repaired DQ netlist. The general solver does not select or change DQ assignments.

The saved layout contains 49 joined pad-to-pad traces and 80 full-stack plated through holes (PTH). Native manufacturing rules remain 0.1016 mm minimum trace width and clearance, 0.4572 mm via pads, and 0.254 mm drills. The 98 fixed escape/fanout objects in `fixed-escapes.json` are immutable provenance; their copper is already included in the joined traces and length measurements. The verifier requires the exact canonical escape-file SHA-256 `f4602ca38a6aae7fb6fcb4a30d6adf0141efe933357800b94d55763a065e97d2` and checks every full escape path against its matching joined trace in either orientation, including via directions and mapped curvature permissions. Point comparison sorts JSON object keys only; all coordinates and field values must match exactly. The original native input has no pre-existing fixed traces.

Run the independent verifier from the repository root:

```sh
bun scripts/verify-g350-am3352-physical-milestone.ts \
  --report work/g350-physical-verification.json
```

An explicit SRJ path can precede `--report`; its canonical `fixed-escapes.json` must be in the same directory. The command rebuilds the trusted repaired native input (SHA-256 `fd0050cc1e3323d862be324fedc456cacaf195e81550dc1bccf574d69b365e5d`) and calls the unchanged native acceptance validator, angle validator, and shared-pair spacing checker. It requires all 49 complete joined routes, unchanged native geometry and fixed copper, all 98 canonical saved escapes, valid route geometry/layers/drills/boundary, zero native DRC issues and self-shorts, conventional angles, and passing differential-pair matching, exterior coupling, and shared spacing.

Exit status 0 means the physical routing milestone passes. DDR timing acceptance is reported separately and may be false. The JSON report records the actual source revision, verification-source hashes, exact native hash, exact routed-file hash, all physical gates, and full validation measurements. Existing full-acceptance snapshot exporters and their solver-success/matching gates are unchanged.

Among 30 saved experimental states (15 distinct geometries), this is the best verified clearance-clean candidate under the requested order: fewest timed signals outside their optimal native bus windows, then smallest summed length error. It has 37/48 outside those windows and 396.352201 mm total error; maximum error is 21.601753 mm. These are full-owned XY length errors, not measured electrical delays. The numeric comparison follows the native 0.635 mm skew rule with its 1e-7 mm floating-point tolerance. This is a finite candidate comparison, not a global optimality claim. See `timing-score.json`.

The saved layout has these total joined copper length spreads, including fixed fanouts:

| Bus | Spread (mm) | Allowed spread (mm) | Matched |
| --- | ---: | ---: | --- |
| DDR_BYTE0 | 13.797413 | 0.635 | No |
| DDR_BYTE1 | 15.299813 | 0.635 | No |
| DDR_COMMAND_CLOCK | 22.236753 | 0.635 | No |

All three differential pairs pass their 0.127 mm pair skew tolerance and native coupling/spacing checks. Bus timing remains the next optimization objective after preserving complete physical routing. Support routing, signal integrity, electrical timing, power planes, and fabrication readiness remain unverified.
