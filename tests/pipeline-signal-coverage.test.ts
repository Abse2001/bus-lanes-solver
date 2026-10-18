import { expect, test } from "bun:test"
import { BusLanesPipelineSolver } from "../lib/bus-lanes-pipeline-solver"
import type { SimpleRouteJson, Trace } from "../lib/types"

function fixture(): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    obstacles: [],
    connections: [0, 1].map((y) => ({
      name: `signal_${y}`,
      pointsToConnect: [-1, 1].map((x) => ({ x, y, layer: "top" })),
    })),
  }
}

function childOutput(input: SimpleRouteJson): Trace[] {
  return input.connections.map((connection) => ({
    type: "pcb_trace",
    pcb_trace_id: connection.name,
    connection_name: connection.name,
    route: connection.pointsToConnect.map((point) => ({
      ...point,
      route_type: "wire",
      width: 0.1,
    })),
  }))
}

test("a child cannot publish missing, duplicate, or foreign owner traces without buses or optimization", () => {
  for (const failure of ["missing", "duplicate", "foreign"] as const) {
    const input = fixture(),
      traces = childOutput(input)
    if (failure === "missing") traces.pop()
    else
      traces[1].connection_name =
        failure === "duplicate" ? "signal_0" : "unknown"
    const solver = new BusLanesPipelineSolver(input, {
      smoothTuning: false,
      fanout: "none",
    })
    // Fault injection at a child boundary exercises final pipeline acceptance,
    // independently of the child's own coverage validation.
    ;(
      solver as unknown as {
        nativeSingleCarrier: Generator<void, Trace[] | null>
      }
    ).nativeSingleCarrier = (function* () {
      return traces
    })()
    solver.step()
    expect(solver.solved).toBe(false)
    expect(solver.failed).toBe(true)
    expect(solver.error).toContain("Final signal coverage")
    expect(solver.failureCode).toBe("signal_coverage_violation")
    expect(() => solver.getOutput()).toThrow()
  }
})

test("connectivity child coverage errors retain their own failure code", () => {
  const input = fixture(),
    traces = childOutput(input).slice(0, 1)
  const solver = new BusLanesPipelineSolver(input, {
    smoothTuning: false,
    fanout: "none",
  })
  ;(solver as unknown as { connectivitySolver: unknown }).connectivitySolver = {
    step() {},
    solved: true,
    failed: false,
    error: null,
    stats: {},
    traces,
  }
  solver.step()
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.failureCode).toBe("signal_coverage_violation")
  expect(solver.error).toContain("Final signal coverage")
})

test("complete child ownership remains publishable", () => {
  const input = fixture(),
    traces = childOutput(input)
  const solver = new BusLanesPipelineSolver(input, {
    smoothTuning: false,
    fanout: "none",
  })
  ;(
    solver as unknown as {
      nativeSingleCarrier: Generator<void, Trace[] | null>
    }
  ).nativeSingleCarrier = (function* () {
    return traces
  })()
  solver.step()
  expect(solver.solved).toBe(true)
  expect(solver.getOutput().traces).toEqual(traces)
})
