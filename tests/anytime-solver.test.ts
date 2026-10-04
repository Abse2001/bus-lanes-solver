import { expect, test } from "bun:test"
import { AnytimeBusLanesSolver, type SimpleRouteJson, type Trace } from "../lib"
import { busLengthReports } from "../lib/route-lengths"

const fixture = (): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.1,
  bounds: { minX: -2, maxX: 24, minY: -5, maxY: 6 },
  obstacles: [],
  connections: [
    {
      name: "a",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top" },
        { x: 20, y: 0, layer: "top" },
      ],
    },
    {
      name: "b",
      pointsToConnect: [
        { x: 0, y: 2, layer: "top" },
        { x: 10, y: 2, layer: "top" },
      ],
    },
  ],
  buses: [{ busId: "DATA", connectionNames: ["a", "b"], maxLengthSkew: 0.05 }],
})

const options = {
  fanout: "none" as const,
  maxSearchIterations: 10_000,
  iterationsPerX: 12,
}

test("a complete endpoint-connected approximation is available before the first search step", () => {
  const input = fixture()
  const original = structuredClone(input)
  const solver = new AnytimeBusLanesSolver(input, { ...options, effort: "1x" })
  const result = solver.getResult()
  expect(result.status).toBe("best_effort")
  expect(result.output.traces).toHaveLength(input.connections.length)
  for (const connection of input.connections) {
    const trace = result.output.traces!.find(
      (candidate) => candidate.connection_name === connection.name,
    )!
    expect(trace.route[0]).toMatchObject(connection.pointsToConnect[0])
    expect(trace.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
  }
  expect(Number.isFinite(result.score.objective)).toBe(true)
  expect(solver.solved).toBe(false)
  expect(input).toEqual(original)
})

test.each([10, "10x"] as const)(
  "tenfold effort %s uses the cumulative 5120-step default optimization budget",
  (effort) => {
    const solver = new AnytimeBusLanesSolver(fixture(), {
      fanout: "none",
      effort,
    })
    expect(solver.options.iterationsPerX).toBe(512)
    expect(solver.stats.budget).toBe(5120)
    expect(solver.getResult().optimizationIterations).toBe(0)
    expect(solver.getResult().status).toBe("best_effort")
  },
)

test("an impossible planar wall retains a usable approximation without claiming successful routing", () => {
  const input = fixture()
  input.buses = []
  input.obstacles = [
    {
      center: { x: 5, y: 0 },
      width: 1,
      height: 20,
      layers: ["top"],
      connectedTo: [],
    },
  ]
  const before = structuredClone(input)
  const solver = new AnytimeBusLanesSolver(input, {
    ...options,
    maxSearchIterations: 200,
    effort: 1,
  })
  const result = solver.solve()
  expect(result.status).toBe("best_effort")
  expect(result.violations.length).toBeGreaterThan(0)
  expect(result.output.traces).toHaveLength(input.connections.length)
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(false)
  expect(solver.exhausted).toBe(true)
  expect(() => solver.getOutput()).not.toThrow()
  const ten = solver.improve("10x")
  expect(ten.status).toBe("best_effort")
  expect(ten.output).toEqual(result.output)
  expect(ten.score).toEqual(result.score)
  expect(ten.violations.length).toBeGreaterThanOrEqual(result.violations.length)
  expect(solver.failed).toBe(false)
  expect(solver.exhausted).toBe(true)
  const directTen = new AnytimeBusLanesSolver(input, {
    ...options,
    maxSearchIterations: 200,
    effort: 10,
  }).solve()
  expect(directTen.output).toEqual(ten.output)
  expect(directTen.score).toEqual(ten.score)
  expect(directTen.violations).toEqual(ten.violations)
  expect(input).toEqual(before)
})

test("effort checkpoints retain valid matching and a nonincreasing objective", () => {
  const input = fixture()
  const solver = new AnytimeBusLanesSolver(input, { ...options, effort: "1x" })
  const results = [
    solver.solve(),
    solver.improve("2x"),
    solver.improve("5x"),
    solver.improve("10x"),
  ]
  for (const [index, result] of results.entries()) {
    expect(result.status).toBe("valid")
    expect(result.violations).toEqual([])
    expect(
      busLengthReports(input, result.output.traces!).every((b) => b.matched),
    ).toBe(true)
    if (index) {
      expect(result.score.objective).toBeLessThanOrEqual(
        results[index - 1].score.objective + 1e-10,
      )
      expect(result.optimizationIterations).toBeGreaterThanOrEqual(
        results[index - 1].optimizationIterations,
      )
    }
  }
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const history = solver.history
  expect(history.length).toBeGreaterThan(0)
  expect(history.at(-1)!.score).toEqual(results.at(-1)!.score)
  for (let index = 1; index < history.length; index++) {
    expect(history[index].score.objective).toBeLessThan(
      history[index - 1].score.objective,
    )
    expect(history[index].optimizationIterations).toBeGreaterThan(
      history[index - 1].optimizationIterations,
    )
  }
})

test("continuing an earlier effort checkpoint reproduces a fresh run at the same budget", () => {
  const continued = new AnytimeBusLanesSolver(fixture(), {
    ...options,
    effort: 1,
  })
  continued.solve()
  const two = continued.improve(2)
  const freshTwo = new AnytimeBusLanesSolver(fixture(), {
    ...options,
    effort: "2x",
  }).solve()
  expect(two.output).toEqual(freshTwo.output)
  expect(two.score).toEqual(freshTwo.score)
  expect(two.optimizationIterations).toBe(freshTwo.optimizationIterations)
  const five = continued.improve(5)
  const freshFive = new AnytimeBusLanesSolver(fixture(), {
    ...options,
    effort: "5x",
  }).solve()
  expect(five.output).toEqual(freshFive.output)
  expect(five.score).toEqual(freshFive.score)
  expect(five.optimizationIterations).toBe(freshFive.optimizationIterations)
  const ten = continued.improve(10)
  const directTen = new AnytimeBusLanesSolver(fixture(), {
    ...options,
    effort: "10x",
  })
  const freshTen = directTen.solve()
  expect(ten.output).toEqual(freshTen.output)
  expect(ten.score).toEqual(freshTen.score)
  expect(ten.optimizationIterations).toBe(freshTen.optimizationIterations)
  expect(ten.acceptedImprovements).toBe(freshTen.acceptedImprovements)
  expect(continued.history).toEqual(directTen.history)
  expect(continued.stats.budget).toBe(120)
})

test("returned snapshots cannot modify the stored incumbent or later checkpoints", () => {
  const solver = new AnytimeBusLanesSolver(fixture(), {
    ...options,
    effort: 1,
  })
  solver.solve()
  const snapshot = solver.getResult()
  const expected = structuredClone(snapshot)
  snapshot.output.traces![0].route[0].x += 100
  snapshot.score.objective = -100
  snapshot.violations.push({
    code: "caller_mutation",
    message: "caller mutation",
  })
  expect(solver.getResult()).toEqual(expected)
  const output = solver.getOutput()
  output.traces![0].route[0].y += 100
  expect(solver.getResult()).toEqual(expected)
  const history = solver.history
  const expectedHistory = structuredClone(history)
  history[0].score.objective = -100
  history[0].score.busLengths[0].lengths[0].totalLengthMm = -100
  history.push(history[0])
  expect(solver.history).toEqual(expectedHistory)
  solver.improve("10x")
  expect(solver.history[0]).toEqual(expectedHistory[0])
  expect(solver.history.at(-1)!.score).toEqual(solver.getResult().score)
  expect(expected.output.traces![0].route[0].x).toBe(0)
  expect(expected.score.objective).toBeGreaterThanOrEqual(0)
})

test("scoring and matching include immutable fixed fanouts in total electrical lengths", () => {
  const input = fixture()
  const fixed = (
    name: string,
    y: number,
    start: number,
    end: number,
  ): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `fixed_${name}`,
    source_trace_id: name,
    route: [start, end].map((x) => ({
      route_type: "wire",
      x,
      y,
      layer: "top",
      width: 0.1,
    })),
  })
  input.traces = [fixed("a", 0, 20, 22), fixed("b", 2, 10, 18)]
  const before = structuredClone(input)
  const solver = new AnytimeBusLanesSolver(input, { ...options, effort: 1 })
  const result = solver.solve()
  expect(result.status).toBe("valid")
  expect(result.output.traces!.slice(0, 2)).toEqual(before.traces!)
  const reports = result.score.busLengths
  expect(reports[0].matched).toBe(true)
  expect(reports[0].lengths.map((lane) => lane.fixedLengthMm)).toEqual([2, 8])
  expect(reports[0].skewMm!).toBeLessThanOrEqual(0.05 + 1e-7)
  expect(result.score.totalLengthMm).toBeCloseTo(
    reports[0].lengths.reduce((sum, lane) => sum + lane.totalLengthMm!, 0),
    7,
  )
  solver.improve(10)
  expect(solver.getOutput().traces!.slice(0, 2)).toEqual(before.traces!)
  expect(input).toEqual(before)
})
