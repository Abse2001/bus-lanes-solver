import { expect, spyOn, test } from "bun:test"
import { BusLanesPipelineSolver, BusLanesSolver } from "../lib"
import { loadAm3352Sample } from "../scripts/am3352-samples"

test("a dense bus can converge beyond the old per-layer cutoff while retaining work for controls", async () => {
  const { input } = await loadAm3352Sample("control")
  const stages: number[] = []
  const step = spyOn(BusLanesSolver.prototype, "_step").mockImplementation(
    function (this: BusLanesSolver) {
      // Model completion timing just after the old 200k cutoff. These straight
      // placeholder routes test scheduling, not physical routing quality.
      // The unconstrained control stage needs only one step.
      if (this.input.buses?.length && this.iterations < 200100) return
      stages.push(this.input.connections.length)
      this.traces = this.input.connections.map((connection) => ({
        type: "pcb_trace",
        pcb_trace_id: `budget_test_${connection.name}`,
        connection_name: connection.name,
        route: connection.pointsToConnect.map((point) => ({
          ...point,
          route_type: "wire",
          width: this.input.minTraceWidth,
        })),
      }))
      this.solved = true
    },
  )
  try {
    // Isolate the shared search budget from geometric post-processing.
    const solver = new BusLanesPipelineSolver(input, { smoothTuning: false })
    solver.solve()
    expect(solver.solved).toBe(true)
    expect(solver.failed).toBe(false)
    expect(stages).toEqual([24, 23])
    expect(solver.iterations).toBeLessThan(solver.MAX_ITERATIONS)
    expect(solver.getOutput().traces!.slice(0, 161)).toEqual(input.traces!)
  } finally {
    step.mockRestore()
  }
})

test("an explicit child search budget is retained across layer retries", async () => {
  const { input } = await loadAm3352Sample("control")
  const budgets: number[] = []
  const step = spyOn(BusLanesSolver.prototype, "_step").mockImplementation(
    function (this: BusLanesSolver) {
      budgets.push(this.MAX_ITERATIONS)
      this.failed = true
      this.error = "Unsatisfiable test scene"
    },
  )
  try {
    const solver = new BusLanesPipelineSolver(input, {
      maxSearchIterations: 73,
    })
    solver.solve()
    expect(solver.failed).toBe(true)
    expect(budgets).toEqual([73, 73, 73, 73])
    expect(solver.MAX_ITERATIONS).toBe(73 * input.layerCount)
  } finally {
    step.mockRestore()
  }
})
