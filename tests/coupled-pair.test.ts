import { expect, test } from "bun:test"
import { BusLanesSolver, HypergraphBusLanesSolver } from "../lib"
import { pairCouplingReports } from "../lib/pair-coupling"

test("a declared pair shares its corridor and meets the total uncoupled budget", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -3, maxY: 3 },
    obstacles: [],
    connections: [
      {
        name: "P",
        pointsToConnect: [
          { x: -4, y: -0.11, layer: "top" },
          { x: 4, y: -0.11, layer: "top" },
        ],
      },
      {
        name: "N",
        pointsToConnect: [
          { x: -4, y: 0.11, layer: "top" },
          { x: 4, y: 0.11, layer: "top" },
        ],
      },
    ],
    differentialPairs: [
      {
        connectionNames: ["P", "N"] as [string, string],
        lengthTolerance: 0.127,
        traceGap: 0.12,
        maxUncoupledLength: 0.01,
      },
    ],
  }
  for (const Solver of [BusLanesSolver, HypergraphBusLanesSolver]) {
    const solver = new Solver(input)
    solver.solve()
    expect(solver.error).toBeNull()
    expect(solver.solved).toBe(true)
    expect(pairCouplingReports(input, solver.traces)[0].matched).toBe(true)
    expect(
      solver.traces.every((t) => t.route.every((p) => p.route_type === "wire")),
    ).toBe(true)
  }
})
