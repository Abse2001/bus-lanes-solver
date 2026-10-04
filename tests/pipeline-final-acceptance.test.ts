import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { BusLanesPipelineSolver, type SimpleRouteJson } from "../lib"
import { busLengthReports } from "../lib/route-lengths"

const fixture = (): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  bounds: { minX: -6, maxX: 6, minY: -4, maxY: 4 },
  obstacles: [],
  connections: [0, 1].map((y) => ({
    name: `signal${y}`,
    pointsToConnect: [-4, 4].map((x) => ({ x, y, layer: "top" })),
  })),
  buses: [
    {
      busId: "bus",
      connectionNames: ["signal0", "signal1"],
      maxLengthSkew: 0.635,
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "power",
      connection_name: "VCC",
      route: [-4, 4].map((x) => ({
        route_type: "wire",
        x,
        y: -2,
        layer: "bottom",
        width: 0.2,
      })),
    },
  ],
})

class InterruptedOptimizer extends BusLanesPipelineSolver {
  closed = false
  protected *optimizeEnvelope(): Generator<void, void> {
    try {
      // An intermediate candidate is deliberately incomplete and wrong.
      this.traces[0].route[0].x = 100
      this.traces.pop()
      while (true) yield
    } finally {
      this.closed = true
    }
  }
}

function atOptimization(solver: BusLanesPipelineSolver) {
  while (
    !solver.solved &&
    !solver.failed &&
    solver.phase !== "optimize_envelope"
  )
    solver.step()
  expect(solver.phase).toBe("optimize_envelope")
  expect(solver.failed).toBe(false)
  return structuredClone(solver.traces)
}

for (const stop of ["explicit", "iteration-budget"] as const)
  test(`${stop} restores the accepted full route during envelope optimization`, () => {
    const input = fixture(),
      original = structuredClone(input)
    const solver = new InterruptedOptimizer(input, { fanout: "none" })
    const accepted = atOptimization(solver)
    expect(() => solver.getOutput()).toThrow()
    if (stop === "iteration-budget")
      solver.MAX_ITERATIONS = solver.iterations + 1
    solver.step()
    if (stop === "explicit") solver.tryFinalAcceptance()
    expect(solver.solved).toBe(true)
    expect(solver.failed).toBe(false)
    expect(solver.error).toBeNull()
    expect(solver.failureCode).toBeNull()
    expect(solver.closed).toBe(true)
    expect(solver.traces).toEqual(accepted)
    expect(solver.stats.optimizationStoppedEarly).toBe(true)
    expect(busLengthReports(input, solver.traces).every((r) => r.matched)).toBe(
      true,
    )
    expect(
      validateRoutedCopperDrc({
        inputSrj: {
          ...input,
          connections: [
            ...input.connections,
            {
              name: "VCC",
              pointsToConnect: input.traces![0].route.filter(
                (p) => p.route_type === "wire",
              ),
            },
          ],
        },
        routedSrj: solver.getOutput(),
        clearance: 0.1,
      } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
    expect(input).toEqual(original)
    const output = structuredClone(solver.getOutput())
    solver.tryFinalAcceptance()
    expect(solver.getOutput()).toEqual(output)
  })

test("optimizer exceptions preserve a complete solution", () => {
  class BrokenOptimizer extends BusLanesPipelineSolver {
    protected *optimizeEnvelope(): Generator<void, void> {
      throw Error("optimizer failed")
    }
  }
  const solver = new BrokenOptimizer(fixture(), { fanout: "none" })
  const accepted = atOptimization(solver)
  solver.step()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toEqual(accepted)
  expect(solver.stats.optimizationError).toContain("optimizer failed")
})

test("final acceptance cannot turn an unfinished route into success", () => {
  const solver = new BusLanesPipelineSolver(fixture(), {
    fanout: "none",
    maxSearchIterations: 0,
  })
  solver.step()
  solver.tryFinalAcceptance()
  expect(solver.solved).toBe(false)
  expect(solver.traces).toEqual([])
  expect(() => solver.getOutput()).toThrow()
})

test("the real compactor can be interrupted without changing accepted copper", () => {
  const solver = new BusLanesPipelineSolver(fixture(), { fanout: "none" })
  const accepted = atOptimization(solver)
  solver.step()
  expect(solver.solved).toBe(false)
  solver.tryFinalAcceptance()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toEqual(accepted)
  expect(solver.stats.optimizationStoppedEarly).toBe(true)
})

test("interruption after a coordinated improvement retains the improved route", () => {
  const input = fixture()
  input.connections = input.connections.slice(0, 1)
  input.buses![0].connectionNames = ["signal0"]
  input.bounds.maxY = 8
  const solver = new BusLanesPipelineSolver(input, { fanout: "none" })
  atOptimization(solver)
  const initial = [
    {
      type: "pcb_trace" as const,
      pcb_trace_id: "signal0",
      connection_name: "signal0",
      route: [
        [-4, 0],
        [-3, 0],
        [-2, 1],
        [-2, 4],
        [-1, 5],
        [1, 5],
        [2, 4],
        [2, 1],
        [3, 0],
        [4, 0],
      ].map(([x, y]) => ({
        route_type: "wire" as const,
        x,
        y,
        layer: "top",
        width: 0.1,
      })),
    },
  ]
  // Seed a valid detour at the optimizer boundary to exercise a later accepted
  // branch without relying on the routing search to choose that detour.
  ;(solver as unknown as { acceptedTraces: typeof initial }).acceptedTraces =
    structuredClone(initial)
  solver.traces = structuredClone(initial)
  for (let i = 0; i < 1000 && !solver.solved; i++) {
    solver.step()
    const area = solver.stats.envelopeOptimization
    if (area && area.afterAreaMm2 < area.beforeAreaMm2 - 1e-6) break
  }
  expect(solver.solved).toBe(false)
  expect(solver.stats.envelopeOptimization.afterAreaMm2).toBeLessThan(
    solver.stats.envelopeOptimization.beforeAreaMm2,
  )
  solver.tryFinalAcceptance()
  expect(solver.solved).toBe(true)
  expect(solver.traces).not.toEqual(initial)
  expect(busLengthReports(input, solver.traces).every((r) => r.matched)).toBe(
    true,
  )
  expect(solver.getOutput().traces[0]).toEqual(input.traces![0])
})
