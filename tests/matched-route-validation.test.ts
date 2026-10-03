import { expect, test } from "bun:test"
import { BusLanesSolver, type SimpleRouteJson, type Trace } from "../lib"

function fixture() {
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["inner1", "inner2"],
    minTraceWidth: 0.1,
    bounds: { minX: -4, maxX: 4, minY: -2, maxY: 3 },
    obstacles: [],
    connections: [0, 1].map((y) => ({
      name: `lane-${y}`,
      pointsToConnect: [
        { x: -3, y, layer: "inner1" },
        { x: 3, y, layer: "inner1" },
      ],
    })),
    buses: [
      {
        busId: "parallel",
        connectionNames: ["lane-0", "lane-1"],
        maxLengthSkew: 0.1,
      },
    ],
  }
  const traces: Trace[] = input.connections.map((c) => ({
    type: "pcb_trace",
    pcb_trace_id: c.name,
    connection_name: c.name,
    route: c.pointsToConnect.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.1,
    })),
  }))
  return { input, traces }
}

test("already matched candidates still pass the complete output validator", () => {
  const { input, traces } = fixture(),
    before = structuredClone({ input, traces })
  const solver = BusLanesSolver.forValidation(input, traces, {
    smoothTuning: true,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect({ input, traces }).toEqual(before)
})

test.each(["missing", "layer", "short", "corner", "crossing"])(
  "candidate validation rejects %s violations without repairing or accepting them",
  (violation) => {
    const { input, traces } = fixture()
    if (violation === "missing") traces.pop()
    if (violation === "layer")
      for (const point of traces[0].route)
        if (point.route_type === "wire") point.layer = "inner2"
    if (violation === "short") {
      input.connections[1].pointsToConnect[1].x = 2
      traces[1].route.at(-1)!.x = 2
    }
    if (violation === "corner")
      traces[0].route = [
        [-3, 0],
        [-1, 0],
        [-1, 0.5],
        [1, 0.5],
        [1, 0],
        [3, 0],
      ].map(([x, y]) => ({
        route_type: "wire",
        x,
        y,
        layer: "inner1",
        width: 0.1,
      }))
    if (violation === "crossing")
      traces[1].route = [
        [-3, 1],
        [-2, 0],
        [2, 0],
        [3, 1],
      ].map(([x, y]) => ({
        route_type: "wire",
        x,
        y,
        layer: "inner1",
        width: 0.1,
      }))
    const solver = BusLanesSolver.forValidation(input, traces, {
      smoothTuning: true,
    })
    solver.solve()
    expect(solver.solved).toBe(false)
    expect(solver.failed).toBe(true)
    expect(() => solver.getOutput()).toThrow()
  },
)
