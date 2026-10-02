import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { HypergraphBusLanesSolver } from "../lib/hypergraph-bus-lanes-solver"
import type { SimpleRouteJson } from "../lib/types"

test("exhausting quick terminal choices retains the broader routing fallback", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: -5, maxX: 5, minY: -2, maxY: 2 },
    layerCount: 2,
    minTraceWidth: 0.1,
    obstacles: [],
    connections: [-0.11, 0.11].map((y, i) => ({
      name: `D${i}`,
      pointsToConnect: [
        { x: -4, y, layer: "top" },
        { x: 4, y, layer: "top" },
      ],
    })),
    differentialPairs: [
      { connectionNames: ["D0", "D1"], traceGap: 0.12, lengthTolerance: 0.127 },
    ],
  }
  const before = structuredClone(input)
  const starts: number[] = [],
    budgets: number[] = []
  const original = BusLanesSolver.prototype._step
  BusLanesSolver.prototype._step = function () {
    if (this.phase === "validate")
      budgets.push(this.options.maxTopologyRetries!)
    if (this.options.maxTopologyRetries === 0) {
      this.failed = true
      this.phase = "failed"
      this.failureCode = "no_planar_route"
      this.error = "Quick candidate search exhausted"
    } else original.call(this)
  }
  try {
    const solver = new HypergraphBusLanesSolver(input, {
      onStage: (stage) => {
        if (stage.stage === "local_dogbones") starts.push(stage.attempt!)
      },
    })
    solver.solve()
    expect(solver.solved).toBe(true)
    expect(solver.traces).toHaveLength(2)
    expect(starts).toEqual([0, 1, 2])
    expect(budgets).toEqual([0, 0, 4])
    expect(solver.attemptFailures.map((f) => f.attempt)).toEqual([0, 1])
    expect(input).toEqual(before)
  } finally {
    BusLanesSolver.prototype._step = original
  }
})
