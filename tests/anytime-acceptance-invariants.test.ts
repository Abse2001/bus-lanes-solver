import { expect, test } from "bun:test"
import { AnytimeBusLanesSolver } from "../lib"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const wire = (x: number, y: number, layer = "top"): Wire => ({
  route_type: "wire",
  x,
  y,
  layer,
  width: 0.1,
})

function ordinarySeed() {
  const traces: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "a",
      connection_name: "a",
      route: [wire(0, 0), wire(2, -2), wire(18, -2), wire(20, 0)],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "b",
      connection_name: "b",
      route: [wire(0, 3), wire(10, 3)],
    },
  ]
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 21, minY: -3, maxY: 4 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        x: p.x,
        y: p.y,
        layer: "top",
      })),
    })),
  }
  return { input, traces }
}

function escapedSeed() {
  const traces: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "a",
      connection_name: "a",
      route: [
        wire(0, 0),
        wire(0.5, 0),
        {
          route_type: "via",
          x: 0.5,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        wire(0.5, 0, "bottom"),
        wire(2.5, 2, "bottom"),
        wire(7.5, 2, "bottom"),
        wire(9.5, 0, "bottom"),
        {
          route_type: "via",
          x: 9.5,
          y: 0,
          from_layer: "bottom",
          to_layer: "top",
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        wire(9.5, 0),
        wire(10, 0),
      ],
    },
  ]
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    bounds: { minX: -1, maxX: 11, minY: -1, maxY: 3 },
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
  return { input, traces }
}

function expectRejected(
  seed: ReturnType<typeof ordinarySeed>,
  mutate: (candidate: Trace[]) => void,
  escaped = false,
) {
  const solver = AnytimeBusLanesSolver.fromCompleted(seed.input, seed.traces, {
    fanout: "none",
    iterationsPerX: 1,
  })
  const before = solver.getResult()
  const candidate = structuredClone(seed.traces)
  if (escaped) candidate[0].route.splice(4, 2)
  else candidate[0].route = [candidate[0].route[0], candidate[0].route.at(-1)!]
  mutate(candidate)
  const internal = solver as unknown as {
    candidates: Generator<Trace[] | undefined>
  }
  internal.candidates = (function* () {
    yield candidate
  })()
  const result = solver.solve()
  expect(result.status).toBe("valid")
  expect(result.violations).toEqual([])
  expect(result.acceptedImprovements).toBe(0)
  expect(result.output).toEqual(before.output)
  expect(result.score).toEqual(before.score)
  expect(solver.stats.validationRejected).toBe(1)
  expect(solver.failed).toBe(false)
}

test.each([
  [
    "source coordinate",
    (candidate: Trace[]) => {
      candidate[0].route[0].x = 0.2
    },
  ],
  [
    "destination coordinate",
    (candidate: Trace[]) => {
      candidate[0].route.at(-1)!.x = 19
    },
  ],
  [
    "terminal layer",
    (candidate: Trace[]) => {
      for (const p of candidate[0].route)
        if (p.route_type === "wire") p.layer = "bottom"
    },
  ],
] as const)(
  "incremental acceptance retains the incumbent after a changed original %s",
  (_, mutate) => {
    expectRejected(ordinarySeed(), mutate)
  },
)

test.each([0.01, 0.2])(
  "incremental acceptance rejects a %s mm carrier with the wrong specified width",
  (width) => {
    expectRejected(ordinarySeed(), (candidate) => {
      for (const p of candidate[0].route)
        if (p.route_type === "wire") p.width = width
    })
  },
)

test.each([
  [
    "duplicate connection",
    (candidate: Trace[]) => {
      candidate[1].connection_name = "a"
    },
  ],
  [
    "missing connection",
    (candidate: Trace[]) => {
      candidate.pop()
    },
  ],
  [
    "unknown connection",
    (candidate: Trace[]) => {
      candidate[1].connection_name = "unknown"
    },
  ],
  [
    "reordered ownership",
    (candidate: Trace[]) => {
      candidate.reverse()
    },
  ],
] as const)("incremental acceptance rejects corrupted %s", (_, mutate) => {
  expectRejected(ordinarySeed(), mutate)
})

test.each([
  [
    "nonfinite x",
    (candidate: Trace[]) => {
      candidate[0].route.splice(1, 0, wire(Number.NaN, 0))
    },
  ],
  [
    "nonfinite y",
    (candidate: Trace[]) => {
      candidate[0].route.splice(1, 0, wire(5, Infinity))
    },
  ],
  [
    "nonfinite width",
    (candidate: Trace[]) => {
      const p = candidate[0].route[0]
      if (p.route_type === "wire") p.width = Number.NaN
    },
  ],
  [
    "infinite width",
    (candidate: Trace[]) => {
      const p = candidate[0].route[0]
      if (p.route_type === "wire") p.width = Infinity
    },
  ],
  [
    "negative width",
    (candidate: Trace[]) => {
      const p = candidate[0].route[0]
      if (p.route_type === "wire") p.width = -0.1
    },
  ],
] as const)(
  "incremental acceptance retains valid copper after a primitive with %s",
  (_, mutate) => {
    expectRejected(ordinarySeed(), mutate)
  },
)

test.each([
  [
    "escape coordinate",
    (candidate: Trace[]) => {
      candidate[0].route[1].x = 0.6
    },
  ],
  [
    "escape width",
    (candidate: Trace[]) => {
      const p = candidate[0].route[1]
      if (p.route_type === "wire") p.width = 0.2
    },
  ],
  [
    "via coordinate",
    (candidate: Trace[]) => {
      candidate[0].route[2].x = 0.6
    },
  ],
  [
    "via diameter",
    (candidate: Trace[]) => {
      const p = candidate[0].route[2]
      if (p.route_type === "via") p.via_diameter = 0.4
    },
  ],
  [
    "nonfinite via pad",
    (candidate: Trace[]) => {
      const p = candidate[0].route[2]
      if (p.route_type === "via") p.via_diameter = Number.NaN
    },
  ],
  [
    "nonfinite via hole",
    (candidate: Trace[]) => {
      const p = candidate[0].route[2]
      if (p.route_type === "via") p.via_hole_diameter = Infinity
    },
  ],
] as const)(
  "incremental acceptance rejects a changed immutable %s",
  (_, mutate) => {
    expectRejected(escapedSeed(), mutate, true)
  },
)
