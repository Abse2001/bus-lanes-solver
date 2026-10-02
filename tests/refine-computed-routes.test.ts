import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"
const wire = (x: number, y: number): Wire => ({
  x,
  y,
  layer: "bottom",
  width: 0.1,
  route_type: "wire",
})
const fixture = () => {
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "signal",
    connection_name: "signal",
    route: [wire(0, 0), wire(4, 0)],
  }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -1, maxX: 5, minY: -2, maxY: 2 },
    connections: [
      { name: "signal", pointsToConnect: [wire(0, 0), wire(4, 0)] },
    ],
    obstacles: [],
  }
  return { input, trace }
}
const finish = (input: SimpleRouteJson, traces: Trace[]) => {
  const solver = BusLanesSolver.forRefinement(input, traces, {
    smoothTuning: true,
  })
  for (let i = 0; i < 100 && !solver.solved && !solver.failed; i++)
    solver.step()
  return solver
}
test("computed-route refinement preserves caller geometry and validates a complete route", () => {
  const { input, trace } = fixture(),
    before = structuredClone({ input, trace })
  const solver = finish(input, [trace])
  expect(solver.solved).toBe(true)
  expect({ input, trace }).toEqual(before)
  expect(solver.traces[0]).not.toBe(trace)
})
test("computed-route refinement cannot accept missing connectivity", () => {
  const { input } = fixture(),
    solver = finish(input, [])
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.error).toContain("Missing lane")
})
test("computed-route refinement cannot accept a broken endpoint", () => {
  const { input, trace } = fixture()
  trace.route[0] = wire(0.5, 0)
  const solver = finish(input, [trace])
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.error).toContain("Broken lane endpoints")
})
test("computed-route refinement cannot accept a fixed-copper crossing", () => {
  const { input, trace } = fixture()
  input.obstacles.push({
    center: { x: 2, y: 0 },
    width: 0.5,
    height: 0.5,
    layers: ["bottom"],
    connectedTo: ["power"],
  })
  const solver = finish(input, [trace])
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.error).toContain("Final copper clearance violation")
})
