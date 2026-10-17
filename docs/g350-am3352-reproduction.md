# G350 AM3352 / DDR routing reproduction

A self-contained AM3352BZCZ100 and MT41K256M16TW-107:P placement using the
fixture, loader, CLI and debugger structure of the
[AM3352 SBC reproduction](am3352-sbc-reproduction.md).

## Input

The CPU is at `(0,20)`, rotation 0; RAM is at `(0,6)`, rotation 270.
Coordinates are board-world millimetres. The fixture contains 194 components
and 854 pads, including all 324 CPU balls and 96 RAM balls, unused/NC pads,
decoupling, power supplies, VREF, ZQ/VTP, clock and reset circuitry.

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

## Run

```sh
bun install
bun scripts/repro-g350-am3352.ts --timeout-seconds 120 \
  --report /tmp/g350-report.json --output /tmp/g350-routed.json
```

The runner returns nonzero on failure, timeout or failed acceptance. It writes
routing output only after all 49 true-pad connections, copper DRC, layer and
via rules, bus/pair matching and exterior pair coupling pass. Reports measure
planar copper length. Incomplete output has unverified measurements.

Run the fixture and acceptance regression tests with
`bun test tests/g350-am3352-sample.test.ts` and typecheck with
`bun run typecheck`.

For interactive debugging, run `bun start` and open
`g350-am3352-outer-layers`.

## Fixture verification

File hashes, part identities and component/net mappings are recorded in
`tests/fixtures/g350-am3352/metadata.json`; attribution is in its `LICENSE`.
The optional capture verifier uses Core 0.0.2107 and checks regenerated fixture
bytes without overwriting them:

```sh
bun scripts/capture-g350-am3352.ts /path/to/core/dist/index.js
```
