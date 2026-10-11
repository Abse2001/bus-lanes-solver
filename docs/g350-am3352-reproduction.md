# G350 AM3352 / DDR outer-layer reproduction

This follows the merged [AM3352 SBC reproduction](am3352-sbc-reproduction.md):
a captured native routing fixture, a cloning loader, a command-line pipeline
runner, independent acceptance, regression tests, and a Cosmos debugger page.
It adds a reproduction; it does not change the routing algorithm or existing
AM3352 benchmarks.

The fixture contains the actual G350 AM3352BZCZ100 and
MT41K256M16TW-107:P, including all 324 CPU balls and all 96 RAM balls.
CPU is at `(0, 20)` with rotation 0; RAM is at `(0, 6)` with rotation 270.
Coordinates are board-world millimetres, +X right and +Y up. The five support
parts moved to clear the CPU/RAM corridor retain their checked positions.
No previously routed DDR paths or fixed FanoutSolver outputs are supplied.

## Included circuitry and routing boundary

All 194 selected components and 854 physical pads remain obstacles, including
unused and NC balls and bottom-side parts. The capture retains 125 capacitors,
CPU/RAM supply and ground pins, the VREF divider and bypass capacitors, 49.9-ohm
VTP and 240-ohm ZQ resistors, TPS65217 PMIC, boost and buck support, the regulator
feeding the CPU's PERIPH_3V3 bank, TPS3808 reset supervisor and pull-up,
24 MHz crystal/load capacitors/damping resistor, boot straps, reset/power
switches, and UART/JTAG test pads. DNP components retain their physical pads.
The source netlist includes all 679 selected source traces and all 68 support
nets. The peripheral display, USB, audio, buttons and SD socket are outside
this focused routing reproduction.

`tests/fixtures/g350-am3352/circuit.json` retains the real source netlist,
numeric ports, land geometry, component positions, courtyards and four-layer
board outline. `native-input.json` captures all 117 connections: 49 DDR
signals and 68 support nets. No part lookup or access to the original board
checkout is needed to run the reproduction.

`loadG350Am3352Sample()` requests all 49 DDR signals while retaining **every
support pad obstacle**. `loadG350Am3352CompleteInput()` exposes the unfiltered
capture for power/ground/reference/clock/reset routing. Many support nets are
multi-terminal; Bus Lanes requires two-terminal connections, so they need a
separate fanout/plane or general-routing stage. They are preserved, not treated
as connected by the DDR runner. No support copper or reference fill is supplied;
passing the DDR runner alone cannot qualify the powered circuit.

The physical PCB remains four layers. DDR wires may use only top and bottom;
through-vias use 0.4572 mm lands and 0.254 mm drills, without blind/buried vias.
Trace width and trace-to-pad clearance remain 0.1016 mm. The capture retains
the board's additional hole, pad and edge clearance settings.

All 49 connections use the board's current byte-swizzled numeric pin map,
including A13, A14 and A15. BYTE0 and BYTE1 each contain 11 signals;
COMMAND_CLOCK contains 26; RESETn is separate. All three synchronous bus skew
bounds remain 0.635 mm. DQS0, DQS1 and CK pairs retain 0.127 mm skew bounds and
0.12 mm gap. No timing group is removed for a benchmark-only pass.

## Run

```sh
bun install
bun test tests/g350-am3352-sample.test.ts
bun scripts/repro-g350-am3352.ts --timeout-seconds 120 \
  --report /tmp/g350-report.json --output /tmp/g350-accepted.json
bun run typecheck
bun start
```

Open the Cosmos page `g350-am3352-outer-layers`. Its input/progress views are
debugging views, not completed routing snapshots. The CLI returns nonzero on
failure, timeout or failed acceptance and writes a routing output only after
49/49 pad-to-pad connectivity, unchanged geometry, copper DRC, outer-layer
restrictions, all bus/pair matching and exterior pair coupling pass. Reports
retain null DRC/skew values when a complete output is unavailable; missing
routes cannot be interpreted as zero skew. Length reports measure planar
copper, including any supplied fixed fanouts; package and via delays require
separate electrical models.

## Provenance and repeat capture

`metadata.json` records file hashes, component/net names, supplier ball-map
sources and the exact source captures. Geometry comes from the fresh editable
G350 clear-corridor export, SHA-256
`9ed86875ab52717a660ab1798fcd8c6a33e9cac143d10f019e0a1ce19c06b97b`,
with tscircuit 0.0.2821 and Core 0.0.2107. The existing board runtime and its
reviewed checker patch are unchanged. This reproduction runs this repository's
latest source, based on `d8583e433b5268ef4472639a18a533f2ba55e453` (0.0.25).
The fixture's MIT attribution is retained in its `LICENSE`.

The optional capture verifier uses the pinned public Core adapter and requires
an already installed Core 0.0.2107 entry point. It verifies the regenerated
bytes and hashes before accepting them, without overwriting the fixture:

```sh
bun scripts/capture-g350-am3352.ts /path/to/core/dist/index.js
# Also verify extraction from the original hash-indexed full layout:
bun scripts/capture-g350-am3352.ts /path/to/core/dist/index.js \
  /path/to/fresh-layout.circuit.json
```

Repeated net aliases in obstacles are reduced to captured connection/net
ownership and the pad's own physical identifiers; land geometry and terminal
coordinates remain exact. The capture script restores bus and pair constraints
from the source buses because Core's geometry-only adapter call does not emit
them without live JSX components.

## Measured status

See [the validation report](g350-am3352-validation.md). Fixture completeness and
acceptance regression tests pass. The bounded full DDR solve has not passed;
there is no accepted routed snapshot. Support routing, electrical timing and
full-board manufacturing qualification remain open. `fabricationReady=false`.
