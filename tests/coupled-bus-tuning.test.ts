import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { pairCouplingReports } from "../lib/pair-coupling"

test("a pair length-matches its bus by adding shared smooth meanders", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -4, maxY: 4 },
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
      {
        name: "D",
        pointsToConnect: [
          { x: -5, y: -2, layer: "top" },
          { x: 5, y: -2, layer: "top" },
        ],
      },
    ],
    buses: [
      { busId: "DATA", connectionNames: ["P", "N", "D"], maxLengthSkew: 0.1 },
    ],
    differentialPairs: [
      {
        connectionNames: ["P", "N"] as [string, string],
        traceGap: 0.12,
        lengthTolerance: 0.02,
        maxUncoupledLength: 0.01,
      },
    ],
  }
  const solver = new BusLanesSolver(input, { smoothTuning: true })
  solver.solve()
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  expect(busLengthReports(input, solver.traces)[0].matched).toBe(true)
  expect(pairLengthReports(input, solver.traces)[0].matched).toBe(true)
  expect(pairCouplingReports(input, solver.traces)[0].matched).toBe(true)
  expect(
    solver.traces
      .filter((t) => t.connection_name !== "D")
      .every((t) => t.curvedSegments!.length > 0),
  ).toBe(true)
})
