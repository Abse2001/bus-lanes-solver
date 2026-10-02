# Hypergraph initial routes

`HypergraphBusLanesSolver` is an opt-in `BusLanesPipelineSolver` variant. It
computes routes from the current geometry, rather than loading saved solutions.
The original visibility variant is unchanged by default. The four AM3352 Cosmos
pages all instantiate the same hypergraph pipeline, on every routing attempt and
for both matched-bus and control-signal passes. They never switch to visibility
routing; only diagnostic topology capture is enabled specifically for the debugger.

This is not yet a strict improvement over the visibility solver for every input.
For example, `tests/negotiated-pair-lanes.test.ts` requires a shared coupled section
when a pair declares `traceGap`. The visibility solver supplies it; the hypergraph
variant currently permits independent pair tracks unless `maxUncoupledLength` is
also supplied. On that fixture, the independent coupling audit measures about
94.5% and 94.8% coupled copper for the visibility solver versus approximately 0%
for both hypergraph-routed conductors. The four DDR completion results therefore
do not justify replacing
the general-purpose default while preserving its existing behavior.

## Representation and search

- A hypergraph vertex represents a signal demand. A hyperedge contains a
  geometric route alternative, or an atomic pair of alternatives covering both
  differential-pair demands.
- Continuous copper-distance tests establish exclusions between hyperedges.
  A bounded, cost-ordered exact-cover search chooses one compatible covering
  edge per demand. Forward checking prunes exclusions; independent layer
  components and unchanged domain results are cached.
- Negotiated grid searches and package-derived waypoints generate additional
  alternatives. Pair candidates remain indivisible. Supplied copper stays hard;
  provisional routes may be displaced until the cover is complete.
- The first attempt reserves matched bus corridors before placing controls.
  On failure, buses and controls participate in the same initial solve. The
  local dogbone matcher is then evaluated in a routing coordinate frame and
  its new outputs are transformed back. Original pads, fixed fanouts and their provenance do not
  move. Failed attempts try another frame.
- A finer bounded search repairs raster returning jogs when needed. It can use
  diagonal edges between occupied orthogonal neighbors only when the actual
  continuous edge passes clearance checks.
- Corridor expansion retains the package approaches and their octilinear joins.
  The smooth tuner can distribute a length deficit across several clear
  segments. Final checks still require connectivity, self-clearance, continuous
  copper clearance, legal layers and declared length/coupling bounds.

The hypergraph is over route alternatives; the geometric path generator remains
an octilinear grid search. Candidate and search budgets make this a heuristic,
not a proof of global optimality or routability.

Pairs with an explicit `maxUncoupledLength` use coupled corridors. With only
`lengthTolerance` and `traceGap`, the hypergraph variant treats the pair as an
atomic length-matched choice but does not impose an undeclared maximum separated
length. This differs from the default solver's preference for a shared pair
corridor and does not establish the reference board's extra pair-shape limits.

## Correction to PR #10's placements

The imported `connectedTo` arrays contain net-wide aliases, including the port
IDs on the other component. The old fixture generator used those arrays to
identify RAM terminals, so moving RAM also translated CPU signal terminals. For
example, the above placement put CPU terminals outside the board.

The generator, independent audit, and placement test now use each obstacle's
`circuitJsonMetadata.pcb_port_id` as its physical pad identity. A separate
regression checks that every signal terminal coincides with its own component
pad and remains inside the board. The native capture, board rules, signal
membership, component pad geometry, power ownership and all 161 saved power
fanouts are retained.

## Reproduction

```sh
bun install
bun test
bun run typecheck
bun run test:package
./benchmark.sh --solver hypergraph --require-all-solved \
  --timeout-seconds 600 --output benchmark-hypergraph-results.json \
  --artifacts docs/hypergraph-am3352
```

Workers run serially in fresh processes. A success requires 47/47 original
pad-to-pad connections, 161 unchanged power dogbones, zero combined-copper DRC
issues, exactly two local signal vias per net, via-free carriers, byte-bus skew
at most 0.635 mm, and pair skew at most 0.127 mm. Lengths include the dogbones.
Artifacts are written only after solver completion and an independent audit.

Fresh serial run on 2026-10-01, Bun 1.3.2: **4/4 solved**. Skews measure total pad-to-pad copper, including local signal dogbones. The limits are 0.635 mm per byte bus and 0.127 mm per pair (with the validator's existing floating-point epsilon). All 161 fixed power fanouts and the original input are unchanged in every case. Solve times include unsuccessful fallback attempts; export and audit time are excluded.

| Placement | Signals | DRC issues | Byte 0 skew (mm) | Byte 1 skew (mm) | Max pair skew (mm) | Solve time (s) |
| --- | --- | --- | --- | --- | --- | --- |
| Control | 47/47 | 0 | 0.635000 | 0.635000 | 0.000109 | 10.552 |
| Right | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 16.288 |
| Left | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 151.233 |
| Above | 47/47 | 0 | 0.635000 | 0.635000 | 0.127000 | 426.372 |

The complete report is [benchmark-hypergraph-results.json](../benchmark-hypergraph-results.json).
Snapshots show top, inner1, inner2 and bottom separately:

| Placement | Completed routing |
| --- | --- |
| Control, RAM `(0, -27)` | [Snapshot](hypergraph-am3352/control-solved.png) |
| Right, RAM `(27, 0)` | [Snapshot](hypergraph-am3352/right-solved.png) |
| Left, RAM `(-27, 0)` | [Snapshot](hypergraph-am3352/left-solved.png) |
| Above, RAM `(0, 27)` | [Snapshot](hypergraph-am3352/above-solved.png) |

The artifact command also writes ignored `*-solved.json` files containing the
full routed SRJ for inspection. The solver never reads those generated files.

## Live Cosmos stage debugger

The `am3352-ram-below`, `am3352-ram-right`, `am3352-ram-left` and
`am3352-ram-above` Cosmos pages each render only `GenericSolverDebugger`.
`below` is the benchmark's original `control` placement.
They load the corrected input fixtures and compute routes live; no solved trace
recording is loaded by the browser. Run `bun start` and choose a sample.

`Step` advances at most one underlying solver iteration. `Next Stage` advances
to the next phase solver, including dogbones, hypergraph search, abstract topology, selected
route geometry, cleanup, corridor preparation, length matching and validation. Retries
and the separate control-signal pass appear as additional stages. Once solved,
the native visualization step selector exposes the retained stage views.

`HypergraphTopology` now retains an abstract incidence diagram, separate from
`HypergraphRouteGeometry`. A blue circle is a signal demand, a square is a
candidate hyperedge, and a link means that candidate covers that demand. An
atomic differential-pair candidate links to both demands. Green squares are the
selected exact cover; every demand must be covered exactly once. Candidate costs
are the longest member-route length in millimeters. These are route alternatives,
not junctions in a spatial routing mesh.

The right-hand diagram uses the same candidate IDs. Red links are copper
collisions already tested by the search and forbid selecting both candidates.
An absent red link does not prove compatibility: that pair may be untested.
To keep large searches readable, each demand group shows at most eight candidates,
always retaining the selected candidates; the legend reports shown and total
counts. Abstract objects have no copper layer, so an existing PCB layer filter
does not hide them. Enable the debugger's object interaction to inspect candidate
IDs, membership, copper layer, and cost. Only this debug wrapper enables topology
capture; ordinary solves do no additional topology or collision work.

The geometric cover is exposed before turn reduction and fine route repair.
Corridor preparation and length matching yield separately so their outputs can
be inspected before validation. The debugger reports actual search iterations;
it does not solve the whole board inside one step.

For offline intermediate images from an independently audited Control run:

```sh
bun scripts/capture-hypergraph-stages.ts work/hypergraph-stages
bun scripts/render-hypergraph-stage-overview.ts work/hypergraph-stage-overview.png
```

These are explicitly intermediate diagnostics requested for understanding the
pipeline, not completed-routing artifacts. Capture is optional via `onStage`;
its detached snapshots cannot be changed by subsequent tuning or retries.
