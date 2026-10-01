# Pipeline performance

`scripts/benchmark-pipeline.ts` measures the complete public pipeline, including
local pad dogbones, carrier routing, length matching, and final validation. It
does not provide saved routes or board-specific hints to the solver. Run each
trial in a new process, with no competing routing jobs, using the same runtime,
input, and machine for both versions:

```sh
bun scripts/benchmark-pipeline.ts input.json --solver ../baseline/lib/index.ts
bun scripts/benchmark-pipeline.ts input.json --output completed.json
```

The report includes wall time, CPU time, phase times, iterations, connection
count, and hashes of the input and completed output. The exporter refuses failed
or incomplete routes. Runtime measurements exclude input parsing, solver
construction, output serialization, and image rendering. Compare medians of at
least three fresh trials; a local solve measurement does not establish a hosted
SVG response time.

The final AM3352 comparison on macOS arm64 with Bun 1.3.14 alternated three fresh
processes per version, using the same zero-trace input and source modules.

| Version | Wall times (seconds) | Median (seconds) |
| --- | --- | --- |
| Main at `c530ad6` | 18.065, 17.726, 17.426 | 17.726 |
| Optimized | 8.871, 8.668, 9.037 | 8.871 |

This is approximately **2.00×** faster (1.998× by median), with all quality gates
passing. Raw timings, phase times, hashes, and validation counts are recorded
in [am3352-performance.json](./am3352-performance.json).

## AM3352 input

The AM3352 measurement uses core's
`tests/fixtures/am3352-ram-bus-lanes/index.tsx` at commit
`3583eb470f353c2c29f22198a6ac7b192dac28ef`, the same 47-signal example as the
DDR routing guide. It starts with the component pads, 420 pad obstacles, two byte
buses, three differential pairs, and no traces. The fixture uses the public
`autorouter="bus_lanes"` preset.

The compact exported input is 166,914 bytes; its SHA-256 is
`8fc7c1902c1c75c72a5bba4b1ab7378acb413c5c326781516f55e4d0e1032e79`.

To capture its input, save this as `export-am3352-input.tsx` in a core checkout
and run it with Bun. This intercepts the router before its first step; it does
not modify the TSX design or supply a custom routing algorithm.

```tsx
import { writeFileSync } from "node:fs"
import { RootCircuit } from "./lib"
import { BusLanesAutorouter } from "./lib/utils/autorouting/BusLanesAutorouter"
import Board from "./tests/fixtures/am3352-ram-bus-lanes"

BusLanesAutorouter.prototype.start = function () {
  if (this.input.traces?.length) throw Error("Expected original pads only")
  writeFileSync("am3352-input.json", JSON.stringify(this.input))
  process.exit(0)
}
const circuit = new RootCircuit()
circuit.add(<Board />)
await circuit.renderUntilSettled()
throw Error("The bus-lanes router did not start")
```

## Quality checks

Performance changes retain the four DDR provenance benchmarks, including all
66 fixed fanout traces, complete connectivity, combined-copper DRC, and each
bus's total copper skew. AM3352 validation uses core's unchanged native test:
47 completed traces, zero circuit errors, two terminal vias per trace, a single
carrier layer, bus/pair length matching, pair coupling, and the existing limits
on detours, turns, short jogs, and acute corners. Routed snapshots are exported
only after all these checks pass.

The implementation reuses immutable copper and conflict geometry, updates only
the soft grid edges affected by changed copper, and pools released search
buffers within a request. Active searches have separate leases. A stronger
congestion penalty reduces retries; a clearance-checked pair transition cleanup
aligns staggered approach bends without changing endpoints, shared trunks,
headings, or copper lengths. Smooth tuning reuses its sample and trigonometric
templates, measures trial amplitudes without allocating points, and emits the
same final coordinates.

The four DDR sample solve times were 208, 181, 160, and 140 ms. Each completed
33/33 connections with zero combined-copper DRC errors and all three total bus
skews within 0.1 mm, including its 66 immutable fixed fanouts. All three AM3352
layers and all four DDR images were regenerated and visually inspected after
successful validation.
