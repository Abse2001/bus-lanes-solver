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

### Explicit reproduction netlist repair

The runner defaults to a revised, explicit DQ pin mapping. This is a change to
this reproduction's netlist; the general solver never changes supplied pin
connections. CPU D0 through D15 connect to physical Micron DQ pins in this order:

```text
7, 4, 1, 2, 5, 6, 0, 3, 8, 10, 14, 12, 9, 11, 13, 15
```

Each byte retains its original eight data bits, DQS pair and data mask.
Address/control and clock connections are unchanged. The permutation removes
the 19 crossings between straight DQ chords within individual bytes; physical
routing and matching still require independent acceptance.

`scripts/g350-am3352-data-swizzle.ts` derives the revised SRJ, source circuit
netlist and a pin-by-pin manifest from the immutable capture. It changes RAM
terminal identities and pad ownership together. The original fixture hashes
stay unchanged. `--pin-mapping original` reproduces the captured connections.
The input snapshot below continues to show that original capture.

The PCB has four copper layers. This case restricts DDR wires to Top/Bottom,
with 0.4572 mm lands and 0.254 mm drills on full-depth through-vias.
Trace width and trace-to-pad clearance are 0.1016 mm. BYTE0 and BYTE1 each have
11 signals; command/clock has 26; RESETn is separate. Each synchronous bus has
a 0.635 mm skew bound. DQS0, DQS1 and CK retain 0.127 mm pair skew and 0.12 mm gap.

### Layer assignment

| Copper layer | Use in the proposed board |
| --- | --- |
| L1 / Top | DDR signals and component connections |
| L2 / inner1 | Continuous ground reference beneath DDR routing |
| L3 / inner2 | Power planes, with a continuous DDR supply reference beneath Bottom DDR routing |
| L4 / Bottom | DDR signals and component connections |

The signal solver uses only Top and Bottom. Through-via barrels span all four
layers; they do not authorize signal wires on either reference plane. Plane
copper and return-path verification belong to the separate support-routing stage.

### Search policies

`BusLanesPipelineSolver` accepts `surfaceRouting: "auto" | "sites" | "joint"`.
The default portfolio first uses joint native-pad approach negotiation for large
Top/Bottom buses. It reserves physically coupled pairs, negotiates ordinary
surface paths and manufactured through-vias, then applies the original bus and
pair length matching. Ordinary signals may use up to four through-vias, while
their complete owned copper remains included in matching and DRC. Compact local
dogbone site negotiation remains a fallback. `sites` selects the compact search
first; `joint` selects the native-pad search first.

Both policies retain the original board outline and all pad obstacles. Search
windows expand to the full board before declaring local routes unreachable.

## Run

```sh
bun install
bun scripts/repro-g350-am3352.ts --timeout-seconds 900 --surface-strategy auto \
  --pin-mapping repaired --netlist-directory /tmp/g350-netlist \
  --report /tmp/g350-report.json --output /tmp/g350-routed.json
```

The runner returns nonzero on failure, timeout or failed acceptance. It writes
routing output only after all 49 true-pad connections, copper DRC, minimum wire
width, full wire/via boundary containment, drill spacing, same-net shortcut
checks, layer and via rules, bus/pair matching and exterior pair coupling pass.
Reports include the selected search policy and progress statistics. Length
measurements are planar copper length. Incomplete output has unverified
measurements.

Geometric acceptance does not qualify the BGA assembly process. Same-net vias
may overlap BGA pad regions; fabrication review must determine whether filled
and capped vias are needed. Reports retain `fabricationReady: false` and also
exclude electrical timing, plane design and support-net routing from sign-off.

The netlist directory contains the derived `native-input.json`, `circuit.json`,
`data-bit-mapping.json` and fixture `LICENSE`, even if routing does not succeed. These are input
artifacts, and do not claim routed copper. Reports identify the selected pin
mapping, original capture hash and derived input hash.

Run the fixture and acceptance regression tests with
`bun test tests/g350-am3352-sample.test.ts` and typecheck with
`bun run typecheck`.

For interactive debugging, run `bun start` and open
`g350-am3352-outer-layers`.

## Snapshot

![G350 reproduction input: CPU/RAM detail and complete fixture, not routed copper](g350-am3352/g350-input.png)

The input snapshot shows the exact fixture placement. Dashed lines represent
logical connections, not routed copper. Regenerate it with:

```sh
bun scripts/snapshot-g350-am3352.ts --input docs/g350-am3352
```

As in the merged SBC reproduction, exporting a routed snapshot requires complete
connectivity and independent DRC and matching acceptance before writing files:

```sh
bun scripts/snapshot-g350-am3352.ts /tmp/g350-routed.json /tmp/g350-snapshot
```

The routed exporter independently reconstructs the revised input. For an
accepted run using the captured mapping, add `--pin-mapping original`.

## Fixture verification

File hashes, part identities and component/net mappings are recorded in
`tests/fixtures/g350-am3352/metadata.json`; attribution is in its `LICENSE`.
The optional capture verifier uses Core 0.0.2107 and checks regenerated fixture
bytes without overwriting them:

```sh
bun scripts/capture-g350-am3352.ts /path/to/core/dist/index.js
```
