import { expect, test } from "bun:test"
import { BusLanesSolver, HypergraphBusLanesSolver } from "../lib"
import { pairCouplingReports } from "../lib/pair-coupling"
import { routeCopper, VectorScene } from "../lib/vector-scene"

test("dense negotiation routes paired rails and ordinary lanes together", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 12, minY: -2, maxY: 10 },
    obstacles: [],
    connections: Array.from({ length: 13 }, (_, i) => ({
      name: `D${i}`,
      pointsToConnect: [
        { x: 0, y: i * 0.4, layer: "top" },
        { x: 10, y: i * 0.4 + 2, layer: "top" },
      ],
    })),
    differentialPairs: [
      {
        connectionNames: ["D0", "D1"] as [string, string],
        traceGap: 0.1,
        lengthTolerance: 0.1,
      },
    ],
  }
  for (const Solver of [BusLanesSolver, HypergraphBusLanesSolver]) {
    const solver = new Solver(input, {
      denseSearch: true,
      smoothTuning: true,
    })
    solver.solve()
    expect(solver.error).toBeNull()
    expect(solver.solved).toBe(true)
    expect(solver.traces).toHaveLength(13)
    const copper = solver.traces.flatMap(routeCopper)
    for (const connection of input.connections) {
      const trace = solver.traces.find(
        (t) => t.connection_name === connection.name,
      )!
      expect(
        new VectorScene(input, connection, 0.1, copper).pathVisible(
          trace.route,
        ),
      ).toBe(true)
    }
    for (const name of ["D0", "D1"])
      expect(
        solver.traces.find((t) => t.connection_name === name)!.coupledSection,
      ).toBeDefined()
    expect(
      pairCouplingReports(input, solver.traces)[0].conductors.every(
        (c) => c.coupledFraction > 0.94,
      ),
    ).toBe(true)
  }
})
