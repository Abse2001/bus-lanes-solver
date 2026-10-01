import { expect, test } from "bun:test"
import {
  HypergraphBusLanesSolver,
  type RoutingStageSnapshot,
  type SimpleRouteJson,
} from "../lib"
import { RoutingStageSolver } from "../lib/routing-stage-solver"
const input: SimpleRouteJson = {
  layerCount: 1,
  minTraceWidth: 0.1,
  bounds: { minX: -2, maxX: 12, minY: -4, maxY: 6 },
  obstacles: [],
  connections: [
    {
      name: "a",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top" },
        { x: 10, y: 0, layer: "top" },
      ],
    },
    {
      name: "b",
      pointsToConnect: [
        { x: 0, y: 2, layer: "top" },
        { x: 8, y: 2, layer: "top" },
      ],
    },
  ],
  buses: [{ busId: "data", connectionNames: ["a", "b"], maxLengthSkew: 0.5 }],
}
test("stage capture preserves the pre-tuning cover without changing the solution", () => {
  const snapshots: RoutingStageSnapshot[] = []
  const observed = new HypergraphBusLanesSolver(input, {
    fanout: "none",
    onStage: (s) => snapshots.push(s),
  })
  const normal = new HypergraphBusLanesSolver(input, { fanout: "none" })
  observed.solve()
  normal.solve()
  expect(observed.error).toBeNull()
  expect(observed.solved).toBe(true)
  expect(observed.getOutput()).toEqual(normal.getOutput())
  expect(snapshots.map((s) => s.stage)).toEqual([
    "hypergraph_cover",
    "route_cleanup",
    "tuning_corridor",
    "length_matching",
    "validated_lanes",
    "assembled_output",
  ])
  const initial = snapshots[0]
  expect(initial.stats.selection).toBe("exact_cover")
  expect(initial.routingStage).toBe("all_signals")
  expect(initial.traces).not.toEqual(snapshots[3].traces)
  initial.traces[0].route[0].x = 999
  initial.input.connections[0].pointsToConnect[0].x = 999
  expect(observed.getOutput()).toEqual(normal.getOutput())
  expect(snapshots[1].traces[0].route[0].x).not.toBe(999)
})
test("the debugger adapter renders vias by layer and identifies intermediates", () => {
  const s = new RoutingStageSolver(
    {
      stage: "local_dogbones",
      input: { ...input, layerCount: 2 },
      stats: {},
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "escape",
          connection_name: "a",
          route: [
            { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "top" },
            { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "top" },
            {
              route_type: "via",
              x: 1,
              y: 0,
              from_layer: "top",
              to_layer: "bottom",
              via_diameter: 0.6,
            },
            { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "bottom" },
          ],
        },
      ],
    },
    "bottom",
  )
  expect(s.stats.intermediate).toBe(true)
  expect(s.visualize().circles?.length).toBeGreaterThan(0)
  expect(s.visualize().circles?.every((c) => c.layer === "bottom")).toBe(true)
  expect(s.visualize().lines?.every((l) => l.layer === "bottom")).toBe(true)
})

test("native debugger pipeline advances the real engine incrementally and retains stages", async () => {
  const { HypergraphDebugPipelineSolver } = await import(
    "../lib/hypergraph-debug-pipeline-solver"
  )
  const debug = new HypergraphDebugPipelineSolver(input)
  expect(debug.solved).toBe(false)
  debug.step()
  expect(debug.engine.iterations).toBe(0)
  debug.step()
  expect(debug.engine.iterations).toBe(1)
  expect(debug.solved).toBe(false)
  const phases = new Set<string>()
  while (!debug.solved && !debug.failed) {
    const before = debug.engine.iterations
    debug.step()
    expect(debug.engine.iterations - before).toBeLessThanOrEqual(1)
    phases.add(debug.engine.phase)
  }
  expect(debug.error).toBeNull()
  expect(debug.solved).toBe(true)
  expect(phases.has("lanes_hypergraph_cover")).toBe(true)
  expect(phases.has("lanes_tuning_corridor")).toBe(true)
  expect(phases.has("lanes_length_matching")).toBe(true)
  expect(debug.pipelineDef.length).toBeGreaterThan(5)
  const plain = new HypergraphBusLanesSolver(input)
  plain.solve()
  expect(debug.getOutput()).toEqual(plain.getOutput())
  const stage = debug.getSolver(debug.pipelineDef[2].solverName)!
  expect(stage.solved).toBe(true)
  expect(stage.visualize().lines?.length).toBeGreaterThan(0)
})

test("the four Cosmos inputs equal the corrected benchmark inputs", async () => {
  const { am3352SamplePlacements, loadAm3352Sample } = await import(
    "../scripts/am3352-samples"
  )
  for (const { name } of am3352SamplePlacements) {
    const { input } = await loadAm3352Sample(name)
    expect(
      await Bun.file(
        new URL(`../pages/data/hypergraph-${name}.json`, import.meta.url),
      ).json(),
    ).toEqual(input)
  }
})
