import { expect, test } from "bun:test"
import { AnytimeBusLanesSolver } from "../lib"
import type { AnytimeEffort, SimpleRouteJson, Trace } from "../lib"

const input: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  bounds: { minX: -1, maxX: 11, minY: -1, maxY: 1 },
  obstacles: [],
  connections: [
    {
      name: "a",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top" },
        { x: 10, y: 0, layer: "top" },
      ],
    },
  ],
}

test("extra effort can recover a routing-budget failure and follows the same attempt prefix", () => {
  const options = {
    fanout: "none" as const,
    maxSearchIterations: 1,
    iterationsPerX: 1,
  }
  const resumed = new AnytimeBusLanesSolver(input, options)
  expect(resumed.solve().status).toBe("best_effort")
  expect(resumed.improve(2).status).toBe("best_effort")
  const result = resumed.improve(5)
  expect(result.status).toBe("valid")
  expect(result.violations).toEqual([])
  const fresh = new AnytimeBusLanesSolver(input, {
    ...options,
    effort: 5,
  }).solve()
  expect(result.output).toEqual(fresh.output)
  expect(result.score).toEqual(fresh.score)
  const ten = resumed.improve("10x")
  const freshTen = new AnytimeBusLanesSolver(input, {
    ...options,
    effort: 10,
  }).solve()
  expect(ten.status).toBe("valid")
  expect(ten.score.objective).toBeLessThanOrEqual(result.score.objective)
  expect(ten.output).toEqual(freshTen.output)
  expect(ten.score).toEqual(freshTen.score)
  expect(ten.optimizationIterations).toBe(freshTen.optimizationIterations)
})

test("completed seeds are validated and remain detached", () => {
  const completed = new AnytimeBusLanesSolver(input, {
    fanout: "none",
    iterationsPerX: 1,
  })
  completed.solve()
  const traces = completed.traces
  const seeded = AnytimeBusLanesSolver.fromCompleted(input, traces, {
    iterationsPerX: 1,
  })
  traces[0].route[0].x = 100
  expect(seeded.solve().status).toBe("valid")
  expect(seeded.traces[0].route[0].x).toBe(0)
  expect(() => AnytimeBusLanesSolver.fromCompleted(input, traces)).toThrow(
    "original terminal",
  )
  const wrongLayer = completed.traces
  wrongLayer[0].route[0] = {
    ...wrongLayer[0].route[0],
    route_type: "wire",
    layer: "bottom",
    width: 0.1,
  }
  expect(() => AnytimeBusLanesSolver.fromCompleted(input, wrongLayer)).toThrow(
    "original terminal",
  )
})

test.each(["2abc", "10abc", "10", "10X", "20x"])(
  "effort string %s must exactly name a supported level",
  (effort) => {
    expect(
      () =>
        new AnytimeBusLanesSolver(input, { effort: effort as AnytimeEffort }),
    ).toThrow("Effort")
  },
)

test("optimization can continue beyond the named effort presets", () => {
  const matched: SimpleRouteJson = {
    ...input,
    bounds: { minX: -1, maxX: 21, minY: -3, maxY: 5 },
    connections: [
      input.connections[0],
      {
        name: "b",
        pointsToConnect: [
          { x: 0, y: 2, layer: "top" },
          { x: 20, y: 2, layer: "top" },
        ],
      },
    ],
    buses: [{ busId: "data", connectionNames: ["a", "b"], maxLengthSkew: 0.1 }],
  }
  const solver = new AnytimeBusLanesSolver(matched, {
    fanout: "none",
    iterationsPerX: 1,
    effort: 10,
  })
  const before = solver.solve()
  const after = solver.runIterations(100)
  expect(after.status).toBe("valid")
  expect(after.score.objective).toBeLessThanOrEqual(before.score.objective)
  expect(after.optimizationIterations).toBeGreaterThan(
    before.optimizationIterations,
  )
  expect(() => solver.runIterations(-1)).toThrow("positive integer")
})

test.each([false, true])(
  "incremental acceptance rejects unchanged copper crossings, shared alias=%s",
  (sharedAlias) => {
    const board: SimpleRouteJson = {
      ...input,
      bounds: { minX: -1, maxX: 11, minY: -2, maxY: 3 },
      connections: [
        input.connections[0],
        {
          name: "b",
          pointsToConnect: [
            { x: 5, y: -1, layer: "top" },
            { x: 5, y: 1, layer: "top" },
          ],
        },
      ],
    }
    const wire = (x: number, y: number) => ({
      route_type: "wire" as const,
      x,
      y,
      width: 0.1,
      layer: "top",
    })
    const routes: Trace[] = [
      {
        type: "pcb_trace",
        pcb_trace_id: "a",
        connection_name: "a",
        route: [wire(0, 0), wire(2, 2), wire(8, 2), wire(10, 0)],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "b",
        connection_name: "b",
        route: [wire(5, -1), wire(5, 1)],
      },
    ]
    if (sharedAlias) {
      board.connections = board.connections.map((c) => ({
        ...c,
        source_trace_id: "shared_net",
      }))
      for (const trace of routes) trace.source_trace_id = "shared_net"
    }
    const solver = AnytimeBusLanesSolver.fromCompleted(board, routes, {
      fanout: "none",
    })
    const before = solver.getResult()
    const internal = solver as unknown as {
      incumbent: Trace[]
      candidates: Generator<Trace[] | undefined>
    }
    internal.candidates = (function* () {
      yield [
        { ...internal.incumbent[0], route: [wire(0, 0), wire(10, 0)] },
        internal.incumbent[1],
      ]
    })()
    const result = solver.solve()
    expect(result.status).toBe("valid")
    expect(result.acceptedImprovements).toBe(0)
    expect(result.score).toEqual(before.score)
    expect(result.output).toEqual(before.output)
  },
)
