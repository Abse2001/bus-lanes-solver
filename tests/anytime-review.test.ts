import { expect, test } from "bun:test"
import { AnytimeBusLanesSolver } from "../lib"
import { separateAnytimeCarriers } from "../lib/anytime-carriers"
import { fixedRouteLength } from "../lib/route-lengths"
import { length } from "../lib/geometry"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function singleEscapeInput(reverse = false): SimpleRouteJson {
  return {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    obstacles: Array.from({ length: 4 }, (_, i) => ({
      componentId: "U1",
      center: { x: (i % 2) * 0.8, y: 2 + Math.floor(i / 2) * 0.8 },
      width: 0.4,
      height: 0.4,
      shape: "circle" as const,
      layers: ["top"],
      connectedTo: i === 0 ? ["D"] : [],
    })),
    connections: [
      {
        name: "D",
        pointsToConnect: reverse
          ? [
              { x: 0, y: -2, layer: "inner1" },
              { x: 0, y: 2, layer: "top" },
            ]
          : [
              { x: 0, y: 2, layer: "top" },
              { x: 0, y: -2, layer: "inner1" },
            ],
      },
    ],
    buses: [
      { busId: "DATA", connectionNames: ["D"], preferredLayer: "bottom" },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed",
        connection_name: "D",
        route: [
          { route_type: "wire", x: 0, y: -3, layer: "inner1", width: 0.1 },
          { route_type: "wire", x: 0, y: -2, layer: "inner1", width: 0.1 },
        ],
      },
    ],
  }
}

test.each([false, true])(
  "a single-ended pipeline escape remains valid across effort checkpoints, reversed=%s",
  (reverse) => {
    const input = singleEscapeInput(reverse)
    const before = structuredClone(input)
    const solver = new AnytimeBusLanesSolver(input, { iterationsPerX: 8 })
    const one = solver.solve()
    expect(one.status).toBe("valid")
    const route = solver.traces[0].route
    expect(route.filter((p) => p.route_type === "via")).toHaveLength(1)
    const context = separateAnytimeCarriers(input, solver.traces)
    expect(context.traces[0].route.length).toBeGreaterThanOrEqual(2)
    expect(
      context.traces[0].route.every(
        (p) => p.route_type === "wire" && p.layer === "inner1",
      ),
    ).toBe(true)
    const fixedEscape = context.input.traces!.at(-1)!
    for (const effort of [2, 5] as const) {
      const result = solver.improve(effort)
      expect(result.status).toBe("valid")
      expect(result.score.objective).toBeLessThanOrEqual(one.score.objective)
      expect(
        separateAnytimeCarriers(input, solver.traces).input.traces!.at(-1)!
          .route,
      ).toEqual(fixedEscape.route)
    }
    expect(input).toEqual(before)
    expect(solver.getOutput().traces![0]).toEqual(before.traces![0])
  },
)

test("carrier recomposition preserves both fixed curve annotations when the carrier changes vertex count", () => {
  const wire = (x: number, y: number, layer: string): Wire => ({
    route_type: "wire",
    x,
    y,
    layer,
    width: 0.1,
  })
  const original: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "D",
    connection_name: "D",
    curvedSegments: [1, 5, 6, 10, 11],
    coupledSection: [4, 6],
    route: [
      wire(0, 0, "top"),
      wire(0.3, 0.1, "top"),
      {
        route_type: "via",
        x: 0.5,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
      },
      wire(0.5, 0, "bottom"),
      wire(2, 0, "bottom"),
      wire(3, 1, "bottom"),
      wire(4, 0, "bottom"),
      wire(5, 0, "bottom"),
      { route_type: "via", x: 5, y: 0, from_layer: "bottom", to_layer: "top" },
      wire(5, 0, "top"),
      wire(5.2, 0.1, "top"),
      wire(5.5, 0, "top"),
    ],
  }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 7, minY: -2, maxY: 2 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 5.5, y: 0, layer: "top" },
        ],
      },
    ],
  }
  const before = structuredClone({ input, original })
  const context = separateAnytimeCarriers(input, [original])
  expect(context.compose(context.traces)).toEqual([original])
  expect(
    length(context.traces[0].route) + fixedRouteLength(context.input, "D"),
  ).toBeCloseTo(length(original.route), 10)
  const candidate: Trace = {
    ...context.traces[0],
    route: [
      context.traces[0].route[0],
      wire(2, 0.5, "bottom"),
      context.traces[0].route.at(-1)!,
    ],
    curvedSegments: [1, 2],
    coupledSection: [1, 1],
  }
  const result = context.compose([candidate])[0]
  expect(result.route.slice(0, 3)).toEqual(original.route.slice(0, 3))
  expect(result.route.slice(-4)).toEqual(original.route.slice(-4))
  expect(result.curvedSegments).toEqual([1, 4, 5, 8, 9])
  expect(result.coupledSection).toEqual([4, 4])
  expect({ input, original }).toEqual(before)
})

test("a long single-ended local escape remains fixed when its interconnect is shorter", () => {
  const input = singleEscapeInput()
  input.connections[0].pointsToConnect[1] = { x: 3, y: 2, layer: "inner1" }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "D",
    connection_name: "D",
    route: [
      { route_type: "wire", x: 0, y: 2, layer: "top", width: 0.1 },
      { route_type: "wire", x: 2.8, y: 2, layer: "top", width: 0.1 },
      {
        route_type: "via",
        x: 2.8,
        y: 2,
        from_layer: "top",
        to_layer: "inner1",
      },
      { route_type: "wire", x: 2.8, y: 2, layer: "inner1", width: 0.1 },
      { route_type: "wire", x: 3, y: 2, layer: "inner1", width: 0.1 },
    ],
  }
  const context = separateAnytimeCarriers(input, [trace])
  expect(context.traces[0].route).toEqual(trace.route.slice(3))
  expect(context.compose(context.traces)).toEqual([trace])
})

test("completed seed validation rejects malformed geometry in fixed local escapes", () => {
  const input = singleEscapeInput()
  const solver = new AnytimeBusLanesSolver(input, { iterationsPerX: 1 })
  expect(solver.solve().status).toBe("valid")
  expect(() =>
    AnytimeBusLanesSolver.fromCompleted(input, solver.traces),
  ).not.toThrow()
  const mutations: Array<(traces: Trace[]) => void> = [
    (traces) => {
      for (const point of traces[0].route)
        if (point.route_type === "wire" && point.layer === "top")
          point.width = -1
    },
    (traces) => {
      traces[0].route[1].x = Number.NaN
    },
    (traces) => {
      const via = traces[0].route.find((point) => point.route_type === "via")!
      if (via.route_type === "via") via.via_diameter = -1
    },
    (traces) => {
      const via = traces[0].route.find((point) => point.route_type === "via")!
      if (via.route_type === "via") via.via_hole_diameter = Number.NaN
    },
  ]
  for (const mutate of mutations) {
    const traces = solver.traces
    mutate(traces)
    expect(() => AnytimeBusLanesSolver.fromCompleted(input, traces)).toThrow()
  }
})

test("completed seed validation checks escape copper against board bounds and original edge clearance", () => {
  const input = singleEscapeInput()
  const baseline = new AnytimeBusLanesSolver(input, { iterationsPerX: 1 })
  expect(baseline.solve().status).toBe("valid")
  const outside = baseline.traces
  outside[0].route.splice(1, 0, {
    route_type: "wire",
    x: -100,
    y: 2,
    layer: "top",
    width: 0.1,
  })
  expect(() => AnytimeBusLanesSolver.fromCompleted(input, outside)).toThrow(
    "board-edge clearance",
  )
  const wireEdge = structuredClone(input)
  wireEdge.bounds.minX = -0.049
  expect(() =>
    AnytimeBusLanesSolver.fromCompleted(wireEdge, baseline.traces),
  ).toThrow("board-edge clearance")
  const viaEdge = structuredClone(input)
  viaEdge.bounds.maxX = 0.549
  expect(() =>
    AnytimeBusLanesSolver.fromCompleted(viaEdge, baseline.traces),
  ).toThrow("board-edge clearance")
  const withClearance = structuredClone(input)
  withClearance.bounds.minX = -0.1
  withClearance.minBoardEdgeClearance = 0.051
  expect(() =>
    AnytimeBusLanesSolver.fromCompleted(withClearance, baseline.traces),
  ).toThrow("board-edge clearance")
})

test("completed seed validation rejects a reversal within a local escape", () => {
  const input = singleEscapeInput()
  const baseline = new AnytimeBusLanesSolver(input, { iterationsPerX: 1 })
  expect(baseline.solve().status).toBe("valid")
  const traces = baseline.traces
  traces[0].route.splice(1, 0, {
    route_type: "wire",
    x: -1,
    y: 3,
    layer: "top",
    width: 0.1,
  })
  expect(() => AnytimeBusLanesSolver.fromCompleted(input, traces)).toThrow(
    "nonconventional corner",
  )
})

test("completed seed validation rejects an otherwise smooth closed escape loop", () => {
  const input = singleEscapeInput()
  const baseline = new AnytimeBusLanesSolver(input, { iterationsPerX: 1 })
  expect(baseline.solve().status).toBe("valid")
  const traces = baseline.traces
  const radius = 0.5
  const center = { x: radius / Math.SQRT2, y: 2 + radius / Math.SQRT2 }
  const loop: Wire[] = Array.from({ length: 16 }, (_, i) => {
    const angle = (5 * Math.PI) / 4 + ((i + 1) * Math.PI) / 8
    return {
      route_type: "wire",
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
      layer: "top",
      width: 0.1,
    }
  })
  traces[0].route.splice(1, 0, ...loop)
  traces[0].curvedSegments = Array.from({ length: 16 }, (_, i) => i + 1)
  expect(routeAnglesAreConventional(traces)).toBe(true)
  expect(() => AnytimeBusLanesSolver.fromCompleted(input, traces)).toThrow(
    "escape self-clearance",
  )
})

test("completed seed validation rejects self-intersections between separate runs on the same layer", () => {
  const wire = (x: number, y: number, layer: string): Wire => ({
    route_type: "wire",
    x,
    y,
    layer,
    width: 0.1,
  })
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    obstacles: [],
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "top" },
        ],
      },
    ],
  }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "signal",
    connection_name: "signal",
    route: [
      wire(0, 0, "top"),
      wire(2, 0, "top"),
      {
        route_type: "via",
        x: 2,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.3,
      },
      wire(2, 0, "bottom"),
      wire(0.5, -1.5, "bottom"),
      wire(0.5, -2, "bottom"),
      {
        route_type: "via",
        x: 0.5,
        y: -2,
        from_layer: "bottom",
        to_layer: "top",
        via_diameter: 0.3,
      },
      wire(0.5, -2, "top"),
      wire(0.5, -1, "top"),
      wire(1.5, 0, "top"),
      wire(4, 0, "top"),
    ],
  }
  expect(routeAnglesAreConventional([trace])).toBe(true)
  expect(() => AnytimeBusLanesSolver.fromCompleted(input, [trace])).toThrow(
    "same-layer run self-clearance",
  )
})

test("completed seed validation checks every escape layer and via join for continuity", () => {
  const input = singleEscapeInput()
  const baseline = new AnytimeBusLanesSolver(input, { iterationsPerX: 1 })
  expect(baseline.solve().status).toBe("valid")
  const mutations: Array<(traces: Trace[]) => void> = [
    (traces) => {
      const point = traces[0].route[1]
      if (point.route_type === "wire") point.layer = "inner2"
    },
    (traces) => {
      const via = traces[0].route.find((point) => point.route_type === "via")!
      via.x += 0.1
    },
    (traces) => {
      const via = traces[0].route.find((point) => point.route_type === "via")!
      if (via.route_type === "via") via.layers = ["inner1"]
    },
  ]
  for (const mutate of mutations) {
    const traces = baseline.traces
    mutate(traces)
    expect(() => AnytimeBusLanesSolver.fromCompleted(input, traces)).toThrow(
      "disconnected layer transition",
    )
  }
})

test("seed auditing resolves source-only fixed fanouts while preserving their provenance", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 12, minY: -1, maxY: 1 },
    obstacles: [],
    connections: [
      {
        name: "signal",
        source_trace_id: "net_signal",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 10, y: 0, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed_signal",
        source_trace_id: "net_signal",
        route: [
          { route_type: "wire", x: 10, y: 0, layer: "top", width: 0.1 },
          { route_type: "wire", x: 11, y: 0, layer: "top", width: 0.1 },
        ],
      },
    ],
  }
  const before = structuredClone(input)
  const baseline = new AnytimeBusLanesSolver(input, {
    fanout: "none",
    iterationsPerX: 1,
  })
  expect(baseline.solve().status).toBe("valid")
  const seeded = AnytimeBusLanesSolver.fromCompleted(input, baseline.traces, {
    iterationsPerX: 1,
  })
  expect(seeded.solve().status).toBe("valid")
  expect(seeded.getOutput().traces![0]).toEqual(before.traces![0])
  expect(seeded.getResult().score.totalLengthMm).toBeCloseTo(11, 10)
  expect(input).toEqual(before)
})

test("completed seeds retain wider legal local escapes while validating their carrier width", () => {
  const input = singleEscapeInput()
  const baseline = new AnytimeBusLanesSolver(input, { iterationsPerX: 1 })
  expect(baseline.solve().status).toBe("valid")
  const traces = baseline.traces
  for (const point of traces[0].route)
    if (point.route_type === "wire" && point.layer === "top") point.width = 0.2
  const seeded = AnytimeBusLanesSolver.fromCompleted(input, traces, {
    iterationsPerX: 1,
  })
  expect(seeded.solve().status).toBe("valid")
  expect(
    seeded.traces[0].route.filter(
      (p) => p.route_type === "wire" && p.layer === "top",
    ),
  ).toEqual(
    traces[0].route.filter((p) => p.route_type === "wire" && p.layer === "top"),
  )
})

test("completed seed endpoints can use explicitly permitted terminal layers", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 11, minY: -1, maxY: 1 },
    obstacles: [],
    connections: [
      {
        name: "signal",
        pointsToConnect: [0, 10].map((x) => ({
          x,
          y: 0,
          layer: "top",
          layers: ["top", "bottom"],
        })),
      },
    ],
  }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "signal",
    connection_name: "signal",
    route: [0, 10].map((x) => ({
      route_type: "wire",
      x,
      y: 0,
      layer: "bottom",
      width: 0.1,
    })),
  }
  const seeded = AnytimeBusLanesSolver.fromCompleted(input, [trace], {
    iterationsPerX: 1,
  })
  expect(seeded.solve().status).toBe("valid")
  expect(
    seeded.traces[0].route.every(
      (p) => p.route_type === "wire" && p.layer === "bottom",
    ),
  ).toBe(true)
})

test("iteration chunks bound a newly valid seed and preserve later named-effort continuation", () => {
  const input = singleEscapeInput()
  const baseline = new AnytimeBusLanesSolver(input, { iterationsPerX: 1 })
  expect(baseline.solve().status).toBe("valid")
  const continued = AnytimeBusLanesSolver.fromCompleted(input, baseline.traces)
  expect(continued.getResult().optimizationIterations).toBe(0)
  const chunk = continued.runIterations(3)
  expect(chunk.status).toBe("valid")
  expect(chunk.optimizationIterations).toBe(3)
  expect(chunk.exhausted).toBe(true)
  const resumed = continued.improve(2)
  const fresh = AnytimeBusLanesSolver.fromCompleted(input, baseline.traces, {
    effort: 2,
  }).solve()
  expect(resumed.output).toEqual(fresh.output)
  expect(resumed.score).toEqual(fresh.score)
  expect(resumed.optimizationIterations).toBe(fresh.optimizationIterations)
})
