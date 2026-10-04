import { expect, test } from "bun:test"
import { BusLanesPipelineSolver, type SimpleRouteJson } from "../lib"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"

const input: SimpleRouteJson = {
  layerCount: 4,
  allowedLayers: ["inner1", "inner2"],
  minTraceWidth: 0.1,
  defaultObstacleMargin: 0.1,
  bounds: { minX: -16, maxX: 16, minY: -10, maxY: 10 },
  obstacles: [],
  connections: [
    {
      name: "DATA0",
      pointsToConnect: [
        { x: -10, y: 3, layer: "inner1" },
        { x: 10, y: 3, layer: "inner1" },
      ],
    },
    {
      name: "DATA1",
      pointsToConnect: [
        { x: -10, y: -3, layer: "inner2" },
        { x: 10, y: -3, layer: "inner2" },
      ],
    },
    {
      name: "DQS+",
      pointsToConnect: [
        { x: -10, y: 0, layer: "inner2" },
        { x: 10, y: 0, layer: "inner2" },
      ],
    },
    {
      name: "DQS-",
      pointsToConnect: [
        { x: -10, y: -0.22, layer: "inner2" },
        { x: 10, y: -0.22, layer: "inner2" },
      ],
    },
  ],
  buses: [
    {
      busId: "byte",
      connectionNames: ["DATA0", "DATA1", "DQS+", "DQS-"],
      maxLengthSkew: 0.2,
      allowedLayers: ["inner1", "inner2"],
    },
  ],
  differentialPairs: [
    {
      connectionNames: ["DQS+", "DQS-"],
      lengthTolerance: 0.05,
      traceGap: 0.12,
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed_data0",
      connection_name: "DATA0",
      route: [
        { route_type: "wire", x: -12, y: 3, layer: "inner1", width: 0.1 },
        { route_type: "wire", x: -10, y: 3, layer: "inner1", width: 0.1 },
      ],
    },
  ],
}

test("a matched byte spans existing handoff layers without re-dogboning or separating its strobe", () => {
  const before = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input)
  solver.solve()
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toHaveLength(4)
  expect(input).toEqual(before)
  for (const trace of solver.traces) {
    const layer = input.connections.find(
      (c) => c.name === trace.connection_name,
    )!.pointsToConnect[0].layer
    expect(
      trace.route.every((p) => p.route_type === "wire" && p.layer === layer),
    ).toBe(true)
  }
  const report = busLengthReports(input, solver.traces)[0]
  expect(report.matched).toBe(true)
  expect(report.lengths.find((l) => l.name === "DATA0")!.fixedLengthMm).toBe(2)
  expect(pairLengthReports(input, solver.traces)[0].matched).toBe(true)
})
