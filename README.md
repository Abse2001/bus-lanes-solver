# @tscircuit/bus-lanes-solver

Step-based, via-free bus routing for `SimpleRouteJson`, with `BaseSolver` and `GenericSolverDebugger` from `@tscircuit/solver-utils`.

```ts
import { BusLanesSolver } from "@tscircuit/bus-lanes-solver"

const solver = new BusLanesSolver(simpleRouteJson)
solver.solve()
if (solver.failed) throw new Error(solver.error!)
const routed = solver.getOutput()
```

Each connection must have exactly two terminals on the same fixed layer. The solver never emits vias, changes terminal layers, or falls back to a multilayer router. Existing copper and obstacles remain fixed. Geometric winding sweeps, seam rotations and reverse searches choose lane order; planar congestion, crossed lane orders, unsupported constraints, and exhausted search budgets produce explicit failures. A bounded visibility-graph search failure is not a proof that no continuous planar solution exists.

## Constraints

- `buses[].connectionNames`: connections belonging to the bus, in routing order.
- `buses[].maxLengthSkew`: maximum difference in total planar copper lengths, in millimeters, including fixed traces associated by `source_trace_id` or `connection_name`. The solver adds clearance-checked tuning detours and verifies the final result.
- `buses[].traceWidth`: explicit width in millimeters; otherwise uses connection `nominalTraceWidth` / `width`, then `minTraceWidth`.
- `buses[].allowedLayers`: must contain the fixed terminal layer.
- `differentialPairs[].lengthTolerance`: supported as a routed-length constraint. Coupled-pair `traceGap` and `maxUncoupledLength` constraints are explicitly rejected; this solver does not yet enforce coupled-pair geometry.

Matching includes both fixed fanouts and the routes produced by this phase. It measures XY copper length; via depth, layer-dependent propagation velocity, and package delays are not inferred. No impedance or delay defaults are supplied. Matching uses the existing core SRJ fields: bus `maxLengthSkew` and differential-pair `lengthTolerance` (mapped from the JSX pair’s `maxLengthSkew`). Routes already inside the bound remain untuned; shorter routes grow only to the permitted lower bound. Overlapping bus and pair constraints are resolved together without forcing exact equality.

## tscircuit integration

The accompanying core/props changes introduce:

```tsx
<autoroutingphase name="DATA_LANES" phaseIndex={1} autorouter="bus_lanes" />
<bus
  name="DATA"
  connections={["DATA0", "DATA1"]}
  routingPhaseIndex={1}
  maxLengthSkew="0.1mm"
  pcbTraceWidth="0.15mm"
/>
```

Fanout phases must establish matching fixed-layer endpoints before this phase runs. Failed lane routing does not trigger a global-router fallback.

## Debugger

```sh
bun install
bun run start
bun run build:site
```

Cosmos shows four full AM62L DDR phase captures and a skew-tolerance example.
Each AM62L page has two separate, real `FanoutSolver` outputs and all 33 DDR
signals waiting to be routed. The enclosing regions are 17.76 mm apart, with a
4 mm transverse package offset. Fixed and newly routed copper share stable
layer colors; all layers are present at iteration zero, including via rings.
The SoC remains unrotated.

```sh
bun test
bun run typecheck
./benchmark.sh
bun run format:check
```

The repository follows the [handbook bootstrapping guide](https://github.com/tscircuit/handbook/blob/main/guides/bootstrapping-repos.md): Bun, vanilla TypeScript package exports, Biome, CI and a Vite/React Cosmos site. `vercel.json` exports Cosmos for deployment.

## DDR benchmark

`./benchmark.sh` measures four complete DDR interconnect inputs captured from
an actual `bus_lanes` phase. Every sample contains 66 fixed paths produced by
`@tscircuit/fanout-solver@0.0.78`. Input/options/output records are committed in
[`examples/fanout-solver-outputs`](./examples/fanout-solver-outputs). Tests rerun
all eight package fanouts and compare the generated paths.

Before routing, the benchmark verifies record hashes, original output geometry,
continuous wire/via joins, 33 paths per package, at least 6 mm region separation,
exact exits, and independent fixed-copper DRC. Exit-layer mismatches are reported
as routing failures, not repaired or removed from the denominator. Complete
interconnects must also pass independent combined-copper DRC.

**Current result: 4/4 full interconnects (132/132 signals), with combined-copper
DRC and length matching passing.** All four core circuit builds complete with zero circuit errors.
All three logical DDR groups in every sample request a 0.1 mm maximum skew. The measured total copper skew stays within that bound in all 12 groups; the previous routing-only samples had up to 24.7 mm skew.
The measured solves take 100–306 ms on the development machine; the benchmark
records solve time and time including output DRC separately.

FanoutSolver receives compatible handoff layers and winding guidance. The left
case locks successful SoC layer assignments, guides the strobe-pair order, and
uses a RAM corner bank for the remaining data group. Bottom escapes the SoC's
left-side ball field before turning toward its bottom boundary. Neither changes
the SoC ball positions or rotation. Every fixed path is a real saved solver
output; generated coordinates are never edited. These are routing checks, not
complete DDR timing closure or equal-transition-count claims for fixed fanouts.

Samples run one at a time in separate processes to avoid timing interference, with the solver's ordinary 200,000
iteration budget and a one-second benchmark deadline. Override the deadline with
`./benchmark.sh --timeout-seconds 2`. Timeouts and partial paths are failures.
Results are written to `benchmark-results.json`; a failed positive sample makes
the command exit nonzero. Four original mixed-layer negatives are counted separately.

The [tscircuit examples](./examples/README.md) load these exact fanouts and use
`<autoroutingphase autorouter="bus_lanes" />`. Capturing the input is separate
from solving it, so a failed router cannot hide the input that caused it.

The older 12 carrier-prefix cases remain available with `--legacy`; they are
excluded from the default score and Cosmos pages. The prior grid-generated,
aligned two-fanout data is superseded as well.

The router uses a continuous octilinear visibility graph built from offset
copper geometry. Lane ordering starts with layer-separated transverse winding
sweeps, routes the outside of a bend first, and retains alternate seams. Clear
analytic paths skip visibility-graph construction entirely. `maxLaneIterations` bounds vertex expansions
per lane (4,000 by default); `maxSearchIterations` bounds the whole solve
(200,000). There is no grid resolution option.

See the [visual iteration audit](./docs/vector-routing.md) for inspected baseline
and replacement snapshots. Cosmos includes a staggered obstacle channel in
addition to all four real AM62L captures.

Future changes must be submitted through pull requests with reviewed visual snapshots for all four DDR samples. See [AGENTS.md](./AGENTS.md).

### Meander geometry

Length tuning prioritizes long runs over short terminal approaches and centers evenly pitched, chamfered serpentine lobes along them. Lobe count scales with the required added length, spreading large corrections without turning small corrections into dense teeth. Chamfers scale with lobe dimensions instead of a fixed microscopic corner cut. Returning arms retain at least three trace widths of center-to-center spacing (and the requested copper clearance). When the shortest lanes leave no room, the router opens an octilinear central corridor in winding order and rematches all affected bus lengths. Endpoints and fixed fanouts remain unchanged.

Snapshots include [individual layer views](./docs/iterations/skew-tolerances) as well as complete boards. All new carrier bends in the DDR samples are checked to turn by at most 45 degrees; length matching and combined-copper DRC remain mandatory.

## Integrated local-dogbone pipeline (experimental)

`BusLanesPipelineSolver(input, { fanout: "auto" })` composes local terminal
escapes with the fixed-layer lane solver. It honors bus layer restrictions and
preferences, keeps overlapping bus/pair groups atomic, and uses existing local
via access when assigning remaining unconstrained signals. `fanout: "none"`
retains the fixed-layer input contract. A failed pipeline emits no partial
successful trace output.

The pipeline enables smooth length tuning and dense routing search. Declared
pairs use a common corridor and shared tuning curves; skew checks include fixed
fanout copper. Ordinary-run cleanup minimizes turns without increasing length.
The strict `BusLanesSolver` export remains available for callers that already
supply fanout handoffs.

The AM3352/RAM integration regression is still a blocking case for this
experimental pipeline. Existing two-fanout DDR benchmark success does not imply
that arbitrary dense original-pad inputs route successfully.
