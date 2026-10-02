# AM3352 / DDR3 placement samples

`native-input.json` is one native core capture of the AM3352 ZCZ and W631GG6MB
footprints: 324 CPU pads, 96 RAM pads, 47 unresolved DDR signals, two byte buses,
and three differential pairs. It starts with no saved routes. Pad diameters,
the imported RAM coordinate rounding, signal identities, and constraints are
preserved. `power-ownership.json` records every ball label, the original signal
names, and the capture provenance.

`scripts/am3352-samples.ts` derives four samples without duplicating the pad
capture. The CPU stays at `(0, 0)` mm; RAM is translated, without rotation, to
`(0, -27)`, `(27, 0)`, `(-27, 0)`, or `(0, 27)`. Coordinates are board-world mm,
with +X right and +Y up.

## Fixed power copper

The two `*-power-fanout.json` records contain actual, independently DRC-checked
FanoutSolver output in each component's local coordinate frame. Their inputs
are regenerated from the native capture and ownership manifest. Stored hashes
cover those inputs, options, traces, and validation output; generator provenance
includes the package version, dependency revision, and a hash of its TypeScript
sources. Each complete trace appears on one line for easier review.

Every `VDD*`, `VSS*`, and `CAP_VDD*` ball gets a source-only local escape, along
with the reference TSX's explicit `GND` ties for `VREFN`, `RTC_KALDO_ENn`, and `VPP`:

| Component | Supply inputs | Ground | Monitor | Decoupling outputs | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| AM3352 | 72 | 46 | 1 | 3 | 122 |
| RAM | 18 | 21 | 0 | 0 | 39 |
| Total | 90 | 67 | 1 | 3 | 161 |

AM3352 `VDDS_DDR` and RAM `VDD`/`VDDQ` use `DDR_1V5`; `VSS*` uses `GND`.
Every other CPU voltage domain retains its own name. `VDD_MPU_MON` is a monitor
pin, and the three `CAP_VDD*` pins are decoupling outputs: their escapes retain
separate identities and are not joined to a supply rail. `VREFP`, `DDR_VREF`, and
RAM `VREF*` are outside this benchmark; the three explicit CPU ground ties remain
included exactly as declared by the reference's `cpuNet` mapping.

Fanout plane termination marks each local escape complete at its via. Ground
targets `inner1`; other domains target `inner2`. No copper pours or connections
between supply pads are fabricated by the fixture. All 161 vias physically span
the four-layer stack, so signal routing must clear their real copper and drills
on every crossed layer.

The loader supplies these 161 immutable wire/via paths in `input.traces` before
`bus_lanes` starts. It leaves only the original 47 signal connections unresolved
and adds no duplicate rectangle obstacles. The separate power-connection
metadata retains native pad endpoints and electrical net identities for DRC.

Regenerate the two fixed records with:

```sh
bun scripts/generate-am3352-samples.ts
```

This command runs FanoutSolver and validates the emitted power copper; it does
not route the DDR signals. Run `./benchmark.sh` for the four signal-routing
attempts, connectivity, combined-copper DRC, and bus length matching. A local
power escape is not evidence of a fully powered or manufacturable board.
