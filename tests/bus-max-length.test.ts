import { expect, test } from "bun:test"
import { BusLanesSolver, type SimpleRouteJson, type Trace } from "../lib"
import { busLengthReports, maximumCarrierLength } from "../lib/route-lengths"
function fixture(maxLength: number): SimpleRouteJson {
  const wire = (x: number, y: number) => ({
    x,
    y,
    route_type: "wire" as const,
    layer: "top",
    width: 0.1,
  })
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -3, maxX: 12, minY: -2, maxY: 5 },
    obstacles: [],
    connections: [0, 2].map((y) => ({
      name: `D${y}`,
      pointsToConnect: [
        { x: 0, y, layer: "top" },
        { x: 10, y, layer: "top" },
      ],
    })),
    buses: [
      {
        busId: "DATA",
        connectionNames: ["D0", "D2"],
        maxLengthSkew: 0.01,
        maxLength,
      },
    ],
    traces: [0, 2].map((y) => ({
      type: "pcb_trace",
      pcb_trace_id: `escape-${y}`,
      connection_name: `D${y}`,
      route: [wire(-2, y), wire(0, y)],
    })),
  }
}
test("maximum bus length includes fixed copper and retains an exactly feasible route", () => {
  for (const limit of [11.9, 12]) {
    const input = fixture(limit),
      before = structuredClone(input)
    const solver = new BusLanesSolver(input)
    solver.solve()
    expect(solver.solved).toBe(limit === 12)
    expect(input).toEqual(before)
    expect(maximumCarrierLength(input, "D0")).toBeCloseTo(limit - 2, 8)
    if (solver.solved)
      expect(busLengthReports(input, solver.traces)[0].withinLengthLimit).toBe(
        true,
      )
    else expect(() => solver.getOutput()).toThrow()
  }
})
test("validation cannot accept skew-matched routes above their absolute limit", () => {
  const input = fixture(11.9)
  const traces: Trace[] = input.connections.map((c) => ({
    type: "pcb_trace",
    pcb_trace_id: c.name,
    connection_name: c.name,
    route: c.pointsToConnect.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.1,
    })),
  }))
  const report = busLengthReports(input, traces)[0]
  expect(report.matched).toBe(true)
  expect(report.withinLengthLimit).toBe(false)
  expect(busLengthReports(input, traces.slice(1))[0].withinLengthLimit).toBe(
    false,
  )
  const solver = BusLanesSolver.forValidation(input, traces)
  solver.solve()
  expect(solver.solved).toBe(false)
  expect(() => solver.getOutput()).toThrow()
})
test.each([-1, NaN, Infinity])(
  "invalid absolute limit %s is rejected",
  (limit) => {
    const solver = new BusLanesSolver(fixture(limit))
    solver.solve()
    expect(solver.failed).toBe(true)
    expect(solver.error).toContain("Invalid maximum bus length")
  },
)
test("minimum bus length is tuned and independently validated including fixed copper", () => {
  const input = fixture(13)
  input.buses![0].minLength = 12.5
  const solver = new BusLanesSolver(input)
  solver.solve()
  expect(solver.solved).toBe(true)
  const report = busLengthReports(input, solver.traces)[0]
  expect(report.aboveMinimumLength).toBe(true)
  expect(report.withinLengthLimit).toBe(true)
  for (const item of report.lengths)
    expect(item.totalLengthMm).toBeCloseTo(12.5, 6)
  const short: Trace[] = input.connections.map((c) => ({
    type: "pcb_trace",
    pcb_trace_id: c.name,
    connection_name: c.name,
    route: c.pointsToConnect.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.1,
    })),
  }))
  const rejected = BusLanesSolver.forValidation(input, short)
  rejected.solve()
  expect(rejected.solved).toBe(false)
})
test.each([-1, NaN, Infinity, 14])(
  "invalid or conflicting minimum %s is rejected",
  (limit) => {
    const input = fixture(13)
    input.buses![0].minLength = limit
    const solver = new BusLanesSolver(input)
    solver.solve()
    expect(solver.failed).toBe(true)
    expect(solver.error).toContain("Invalid minimum bus length")
  },
)
