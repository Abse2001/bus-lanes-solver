import { expect, test } from "bun:test"
import {
  boardBoundaryReports,
  BusLanesPipelineSolver,
  type Connection,
  type SimpleRouteJson,
} from "../lib"
import { routeAlternateSignalDogbones } from "../lib/alternate-signal-dogbones"
import { signalDogboneOptions } from "../lib/repair-bus-dogbones"

function notchedFanoutInput(): SimpleRouteJson {
  const ys = [0, 0.8, 1.6, 2.4]
  return {
    layerCount: 4,
    allowedLayers: ["bottom"],
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.05,
    bounds: { minX: -6, maxX: 6, minY: -5, maxY: 5 },
    // The first preferred source dogbone goes from (-3, 0) to (-3, 0.4).
    // Both terminals and the via land fit, but the stub crosses this cutout.
    outline: [
      { x: -6, y: -5 },
      { x: 6, y: -5 },
      { x: 6, y: 5 },
      { x: -6, y: 5 },
      { x: -6, y: 0.21 },
      { x: -2.8, y: 0.21 },
      { x: -2.8, y: 0.16 },
      { x: -6, y: 0.16 },
    ],
    obstacles: ys.flatMap((y, index) =>
      [-3, 3].map((x) => ({
        componentId: x < 0 ? "cpu" : "ram",
        shape: "circle" as const,
        center: { x, y },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [`D${index}`],
      })),
    ),
    connections: ys.map((y, index) => ({
      name: `D${index}`,
      pointsToConnect: [-3, 3].map((x) => ({ x, y, layer: "top" })),
    })),
  }
}

test("a generated dogbone crossing a narrow cutout is rejected before accepting its carrier", () => {
  const input = notchedFanoutInput(),
    before = structuredClone(input),
    options = signalDogboneOptions(
      input,
      new Map(
        input.connections.map((connection) => [connection.name, "bottom"]),
      ),
    )
  expect(() => routeAlternateSignalDogbones(input, options, 0)).toThrow(
    "No collision-free local dogbone assignment",
  )
  expect(input).toEqual(before)
  const solver = new BusLanesPipelineSolver(input, {
    smoothTuning: false,
    denseSearch: false,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.traces).toHaveLength(4)
  expect(boardBoundaryReports(input, solver.getOutput().traces).valid).toBe(
    true,
  )
  for (const connection of input.connections) {
    const trace = solver.traces.find(
      (trace) => trace.connection_name === connection.name,
    )!
    expect(trace.route[0]).toMatchObject(connection.pointsToConnect[0])
    expect(trace.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
  }
  expect(input).toEqual(before)
})

function outsideFixedCopperInput(): {
  input: SimpleRouteJson
  fixed: Connection
} {
  const fixed: Connection = {
    name: "POWER",
    pointsToConnect: [
      { x: 5.5, y: 3, layer: "bottom" },
      { x: 6, y: 3, layer: "bottom" },
    ],
  }
  return {
    fixed,
    input: {
      layerCount: 4,
      allowedLayers: ["bottom"],
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.05,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      bounds: { minX: -5, maxX: 5, minY: -4, maxY: 4 },
      connections: [
        {
          name: "A",
          pointsToConnect: [
            { x: -1, y: 0, layer: "top" },
            { x: 1, y: 0, layer: "top" },
          ],
        },
      ],
      obstacles: [],
      traces: [
        {
          type: "pcb_trace",
          pcb_trace_id: "fixed_power_outside_board",
          connection_name: fixed.name,
          route: fixed.pointsToConnect.map((point) => ({
            ...point,
            route_type: "wire",
            width: 0.1,
          })),
        },
      ],
    },
  }
}

test("complete carrier acceptance cannot publish immutable copper outside the board", () => {
  const { input } = outsideFixedCopperInput()
  input.allowedLayers = ["top"]
  const before = structuredClone(input),
    solver = new BusLanesPipelineSolver(input, {
      fanout: "none",
      smoothTuning: false,
      denseSearch: false,
    })
  solver.solve()
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.failureCode).toBe("board_boundary_violation")
  expect(solver.traces).toEqual([])
  expect(() => solver.getOutput()).toThrow()
  expect(input).toEqual(before)
})

test("the connectivity goal also rejects complete output with immutable copper outside the board", () => {
  const { input, fixed } = outsideFixedCopperInput()
  for (const [index, point] of input.connections[0].pointsToConnect.entries())
    point.pcb_port_id = `A_${index}`
  input.obstacles = input.connections[0].pointsToConnect.map(
    (point, index) => ({
      componentId: `package_${index}`,
      shape: "circle",
      center: { x: point.x, y: point.y },
      width: 0.2,
      height: 0.2,
      layers: ["top"],
      connectedTo: ["A", point.pcb_port_id!],
    }),
  )
  const before = structuredClone(input),
    solver = new BusLanesPipelineSolver(input, {
      goal: "connectivity",
      connectivity: { fixedConnections: [fixed], gridStep: 0.1 },
    })
  solver.solve()
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.failureCode).toBe("board_boundary_violation")
  expect(solver.traces).toEqual([])
  expect(() => solver.getOutput()).toThrow()
  expect(input).toEqual(before)
})
