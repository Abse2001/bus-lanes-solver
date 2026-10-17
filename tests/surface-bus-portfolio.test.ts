import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  BusLanesPipelineSolver,
  busLengthReports,
  type SimpleRouteJson,
} from "../lib"

function parallelBus(count: number): SimpleRouteJson {
  const connections = Array.from({ length: count }, (_, index) => ({
    name: `D${index}`,
    pointsToConnect: [-4, 4].map((x) => ({ x, y: index * 0.65, layer: "top" })),
  }))
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.15,
    bounds: { minX: -8, maxX: 8, minY: -2, maxY: count * 0.65 + 2 },
    connections,
    obstacles: connections.flatMap((connection) =>
      connection.pointsToConnect.map((point, end) => ({
        componentId: end ? "receiver" : "driver",
        shape: "circle" as const,
        center: { x: point.x, y: point.y },
        width: 0.18,
        height: 0.18,
        layers: ["top"],
        connectedTo: [connection.name],
      })),
    ),
    buses: [0, 1].map((half) => ({
      busId: `bus${half}`,
      connectionNames: connections
        .slice((half * count) / 2, ((half + 1) * count) / 2)
        .map((connection) => connection.name),
      maxLengthSkew: 0.15,
    })),
    differentialPairs: [],
    traces: [],
  }
}

for (const surfaceRouting of ["auto", "sites", "joint"] as const) {
  test(`${surfaceRouting} surface portfolio connects fresh buses without changing their geometry or matching rules`, () => {
    const input = parallelBus(surfaceRouting === "auto" ? 32 : 4)
    const original = structuredClone(input)
    const solver = new BusLanesPipelineSolver(input, { surfaceRouting })
    solver.solve()
    expect(solver.solved).toBe(true)
    expect(solver.error).toBeNull()
    expect(input).toEqual(original)
    const output = solver.getOutput()
    expect(output.traces).toHaveLength(input.connections.length)
    expect(
      output.traces.every((trace) =>
        trace.route.every((point) =>
          point.route_type === "wire"
            ? ["top", "bottom"].includes(point.layer)
            : point.layers?.length === 4,
        ),
      ),
    ).toBe(true)
    expect(
      busLengthReports(input, output.traces).every((report) => report.matched),
    ).toBe(true)
    expect(
      validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: output,
        clearance: input.minTraceToPadEdgeClearance!,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
  }, 15000)
}
