# Saved AM3352 post-routing length tuning

The generic post-processing stage keeps the original physical layout and a separate best verified checkpoint. It returns the best checkpoint when the search stalls, exhausts its budget, throws, or is cancelled. Rejected or worse trials cannot replace it. The physical pipeline runs this stage after complete routing; existing complete layouts can call `postProcessRoutedLengths` directly. See the [API and budgets](../../README.md#physical-topbottom-routing).

This saved result has **49/49 DDR signals connected, zero native physical DRC issues, 80 full-stack PTHs, and all 98 fixed escape paths preserved exactly**. It is partial length-tuning progress on an existing saved layout. All three bus length constraints still fail. Fresh automatic generation of the complete layout remains unproved.

View the [complete Top/Bottom route](routing.png), [best routed SRJ](routed.json), [independent native verification](validation.json), and [measurements and search records](postprocess-results.json). The [original layout](../g350-am3352-physical-milestone/routed.json) remains separately preserved.

The first bounded run took 301.386 seconds with 1.5-second operator slices and found no acceptable proposal. It returned the original routed file byte-for-byte. After adding logarithmically smaller partial additions and fair sampling of both sides and tuning methods, a second run took 91.747 seconds with 3-second slices. It saved four successive improvements, adding 0.296757 mm of copper and zero vias. The changed signals are D8, D11, BA2, and A2. The six paired traces, all 80 PTH records, RESET, native geometry, and fixed paths remain exact.

The tuning objective uses a fixed portfolio of target windows constrained by immutable-path lower bounds. Its out-of-band count stays 38/48; summed target-window error decreases from 478.636008 to 478.339251 mm. This is progress toward the configured matching windows. The actual bus spreads remain:

| Bus | Spread (mm) | Allowed (mm) | Matched |
| --- | ---: | ---: | --- |
| DDR_BYTE0 | 13.797413 | 0.635 | No |
| DDR_BYTE1 | 15.299813 | 0.635 | No |
| DDR_COMMAND_CLOCK | 22.236753 | 0.635 | No |

All three differential pairs pass their 0.127 mm skew and coupling checks. Fixed fanouts count once in full-owned XY lengths. The earlier milestone's free-window ranking uses a different target definition; the fixed portfolio here remains constant throughout each run.

Recheck the saved result from the repository root:

```sh
bun scripts/verify-g350-am3352-physical-milestone.ts \
  docs/g350-am3352-postprocess/routed.json \
  --report work/g350-postprocess-verification.json
```

Both search runs used frozen generic bundles and separately invoked the unchanged original native checker. The final run passes all eleven preservation/execution gates; the native verification passes all sixteen physical gates. Library source `534e341` passes 711 tests across 203 files, strict TypeScript, and isolated Node/browser/TypeScript package consumers. The legacy control benchmark connects 47/47 signals with zero combined DRC issues and passing bus/pair matching in 62.657 seconds overall; it uses its own layer permissions.

The PNG was visually inspected and draws actual copper widths and native pads to scale. It shows the region containing all 49 routed signals. DDR wires use Top and Bottom on four physical layers; inner layers remain reserved for ground and power/reference planes. This result covers DDR signals only. The 68 support nets, electrical delay/SI, and fabrication readiness remain unverified. Generated JSON files retain their exact bytes and are excluded from automatic formatting.
