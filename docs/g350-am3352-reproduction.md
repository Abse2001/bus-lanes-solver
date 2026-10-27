# G350 AM3352 / DDR routing reproduction

A self-contained AM3352BZCZ100 and MT41K256M16TW-107:P placement using the
fixture, loader, CLI and debugger structure of the
[AM3352 SBC reproduction](am3352-sbc-reproduction.md).

## Input

The CPU is at `(0,20)`, rotation 0; RAM is at `(0,-2)`, rotation 270.
Coordinates are board-world millimetres. The fixture contains 194 components
and 854 pads, including all 324 CPU balls and 96 RAM balls, unused/NC pads,
decoupling, power supplies, VREF, ZQ/VTP, clock and reset circuitry.

RAM and its 17 local support components have moved 8 mm down from the original
RAM center `(0,6)` to leave more room between the CPU and RAM. The same `(0,-8)`
translation applies to `R_DDR_ZQ`, `C_DDR_RAM_1` through `C_DDR_RAM_12`,
`C_DDR_RAM_BULK1`, `C_DDR_RAM_BULK2`, `C_VREF_RAM_CA` and `C_VREF_RAM_DQ`,
including their pads, ports and courtyards. Subsequent hardware corrections
reposition the support parts listed below. CPU/RAM centers, layers, rotations,
bulk capacitors and the original DDR pin mapping remain unchanged.
`metadata.json` records both adjustments, their source commits and file hashes.

`tests/fixtures/g350-am3352/circuit.json` contains the netlist and physical
geometry. `native-input.json` contains 49 DDR connections and 68 support nets.
`loadG350Am3352Sample()` selects the 49 DDR connections and retains all pad
obstacles. `loadG350Am3352CompleteInput()` returns the complete capture.
Support-net routing is a separate problem; no fixed copper or cached DDR paths
are supplied.

The PCB has four copper layers. This case restricts DDR wires to Top/Bottom,
with 0.4572 mm lands and 0.254 mm drills on full-depth through-vias.
Trace width and trace-to-pad clearance are 0.1016 mm. BYTE0 and BYTE1 each have
11 signals; command/clock has 26; RESETn is separate. Each synchronous bus has
a 0.635 mm skew bound. DQS0, DQS1 and CK retain 0.127 mm pair skew and 0.12 mm gap.

## Hardware corrections

The support placement follows the distance checks in
[TI SPRS717L, Table 7-65](https://www.ti.com/lit/ds/sprs717l/sprs717l.pdf#page=178).
CPU bypass capacitor centers must be within 10.16 mm of DDR power/ground balls;
RAM bypass capacitor centers must be within 3.81 mm. The checked maxima are
9.973 mm for the CPU and 1.132 mm for RAM across all 32 high-speed capacitors.
Nominal counts and capacitance remain 20 × 100 nF for the CPU, 12 × 100 nF for
RAM, and two 22 µF bulk capacitors per device.

These supports have been repositioned; their pads, ports, courtyards, native
obstacles and support-net endpoints move together:

| Component | Final center / placement |
| --- | --- |
| `C_DDR_CPU_13`, `_16`, `_19` | `(-5.7,16.5)`, `(-5.7,14.7)`, `(-3.3,14.7)`, Bottom |
| `C_DDR_RAM_1` through `_6` | Bottom row at y=-4.4, x=-6,-3.6,-1.2,1.2,3.6,6 |
| `C_DDR_RAM_7` through `_12` | Bottom row at y=0.4, same x positions |
| `C_VREF_CPU` | `(-0.8,14.7)`, Bottom |
| `C_VREF_RAM_CA`, `C_VREF_RAM_DQ` | `(-2.8,-6.4)`, `(0.4,2.8)`, Bottom |
| `R_DDR_ZQ` | `(-2,-7.6)`, Top |

All component layers and rotations are preserved. The relocated supports have
no same-layer courtyard overlaps. The captured VBAT routing net now explicitly
includes `U_PMIC.BAT_SENSE` (pin 6). Future support routing must connect this
sense line directly at the battery terminal, as required by the
[TPS65217 datasheet, section 6](https://www.ti.com/lit/ds/symlink/tps65217.pdf#page=5).

## Absolute routing bounds

Absolute planar-length bounds complement skew matching, following
[TI SPRS717L, Tables 7-68/69](https://www.ti.com/lit/ds/sprs717l/sprs717l.pdf#page=187):

| Bus | Signals | Minimum length | Maximum length | Maximum skew |
| --- | ---: | ---: | ---: | ---: |
| BYTE0 | 11 | — | 22.4 mm | 0.635 mm |
| BYTE1 | 11 | — | 22.4 mm | 0.635 mm |
| Command/clock | 26 | 30.35 mm | 32.89 mm | 0.635 mm |

Each byte's DQLM is its longest pin-to-pin Manhattan distance. Command/clock
uses CACLM = longest Manhattan distance + 7.62 mm, with a ±1.27 mm window.
The independent validator recomputes these budgets from the pin manifest and
rejects omitted or relaxed bounds and changed bus membership. Source buses
store `min_length`/`max_length`; capture replay preserves the same native bounds.

## Remaining electrical work

The required physical stackup is Top signals / Inner1 GND / Inner2 DDR_1V5 /
Bottom signals, with uninterrupted adjacent reference planes throughout the DDR
routing region and return-current bypassing at layer transitions. Plane copper,
dielectric spacing and controlled-impedance geometry are not supplied by this
routing fixture. The fixed pair gap does not establish differential impedance.
The single-x16 topology without VTT still requires signal-integrity verification.
Support routing, power sequencing, initialization, electrical timing and
manufacturing qualification remain unverified; `fabricationReady` stays false.

## Run

```sh
bun install
bun scripts/repro-g350-am3352.ts --timeout-seconds 120 \
  --report /tmp/g350-report.json --output /tmp/g350-routed.json
```

The runner returns nonzero on failure, timeout or failed acceptance. It writes
routing output only after all 49 true-pad connections, copper DRC, layer and
via rules, absolute length bounds, bus/pair matching and exterior pair coupling pass. Reports measure
planar copper length. Incomplete output has unverified measurements.

Run the static fixture and acceptance checks before routing:

```sh
bun test tests/g350-am3352-sample.test.ts \
  tests/g350-hardware-recommendations.test.ts \
  tests/g350-snapshot-acceptance.test.ts
bun run typecheck
```

These checks cover placement distances, source/captured battery-sense
connectivity, absolute bounds, fixture hashes and rejection of invalid copper.
The runner also audits static hardware recommendations before starting its solver.

For interactive debugging, run `bun start` and open
`g350-am3352-outer-layers`.

## Local snapshots

Input previews are local diagnostics and must not be committed or attached as
routing PR artifacts. Dashed lines represent logical connections, not copper:

```sh
bun scripts/snapshot-g350-am3352.ts --input /tmp/g350-input
```

As in the merged SBC reproduction, exporting a routed snapshot requires complete
connectivity and independent DRC and matching acceptance before writing files:

```sh
bun scripts/snapshot-g350-am3352.ts /tmp/g350-routed.json /tmp/g350-snapshot
```

## Fixture verification

File hashes, part identities and component/net mappings are recorded in
`tests/fixtures/g350-am3352/metadata.json`; attribution is in its `LICENSE`.
The optional capture verifier uses Core 0.0.2107 and checks regenerated fixture
bytes without overwriting them. The adjusted coordinates are already stored
in `circuit.json`; capture replay applies no additional placement translation:

```sh
bun scripts/capture-g350-am3352.ts /path/to/core/dist/index.js
```
