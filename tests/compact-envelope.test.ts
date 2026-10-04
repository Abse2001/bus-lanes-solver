import { expect, test } from "bun:test"
import { compactEnvelopeCandidate } from "../lib/compact-envelope"
import {
  carrierCompactionView,
  signalEnvelope,
} from "../lib/carrier-compaction-view"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { busLengthReports } from "../lib/route-lengths"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { length } from "../lib/geometry"
import { roundedTuningLobes } from "../lib/smooth-tuning"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function fixture(turn = false, reflect = 1) {
  const at = (x: number, y: number) =>
    turn
      ? { x: 30 - y, y: 10 + reflect * x }
      : { x: 30 + reflect * x, y: 10 + y }
  const trace = (name: string, points: number[][]): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    route: points.map(([x, y]) => ({
      ...at(x, y),
      route_type: "wire",
      layer: "top",
      width: 0.1,
    })),
  })
  const matched = trace("matched", [
    [0, 0],
    [1, 0],
    [2, 1],
    [2, 5],
    [3, 6],
    [8, 6],
    [9, 5],
    [9, 1],
    [10, 0],
    [11, 0],
    [12, 1],
    [12, 3],
    [13, 4],
    [18, 4],
    [19, 3],
    [19, 1],
    [20, 0],
    [21, 0],
  ])
  const control = trace("control", [
    [0, -1],
    [1, -2],
    [1, -5],
    [2, -6],
    [19, -6],
    [20, -5],
    [20, -2],
    [21, -1],
  ])
  const p = trace("p", [
    [0, -0.3],
    [21, -0.3],
  ])
  const n = trace("n", [
    [0, -0.52],
    [21, -0.52],
  ])
  p.coupledSection = [0, 1]
  n.coupledSection = [0, 1]
  const fixed = trace("power", [
    [5, -3],
    [15, -3],
  ])
  const traces = [matched, control, p, n]
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: 0, maxX: 60, minY: -20, maxY: 60 },
    obstacles: [
      {
        center: at(10, -3),
        width: turn ? 2 : 4,
        height: turn ? 4 : 2,
        layers: ["top"],
        connectedTo: ["power"],
      },
    ],
    traces: [fixed],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0] as Wire, t.route.at(-1)! as Wire],
    })),
    buses: [{ busId: "bus", connectionNames: ["matched"], maxLengthSkew: 0.1 }],
    differentialPairs: [
      { connectionNames: ["p", "n"], lengthTolerance: 0.1, traceGap: 0.12 },
    ],
  }
  return { input, traces }
}
function propose(
  input: SimpleRouteJson,
  traces: Trace[],
  mode: Parameters<typeof compactEnvelopeCandidate>[2] = "conservative",
) {
  const search = compactEnvelopeCandidate(input, traces, mode)
  let step = search.next()
  while (!step.done) step = search.next()
  return step.value
}

for (const turn of [false, true])
  for (const reflect of [-1, 1])
    test(`compacts envelopes with fixed copper and matched lengths (${turn},${reflect})`, () => {
      const { input, traces } = fixture(turn, reflect),
        before = structuredClone({ input, traces })
      const result = propose(input, traces)
      expect(signalEnvelope(result).areaMm2).toBeLessThan(
        signalEnvelope(traces).areaMm2 * 0.92,
      )
      expect(length(result[0].route)).toBeCloseTo(length(traces[0].route), 7)
      expect(length(result[1].route)).toBeLessThanOrEqual(
        length(traces[1].route) + 1e-8,
      )
      expect(result.slice(2)).toEqual(traces.slice(2))
      for (let i = 0; i < traces.length; i++) {
        expect(result[i].route[0]).toEqual(traces[i].route[0])
        expect(result[i].route.at(-1)).toEqual(traces[i].route.at(-1))
        expect(result[i].route).toHaveLength(traces[i].route.length)
      }
      const validator = BusLanesSolver.forValidation(input, result, {
        smoothTuning: true,
      })
      validator.solve()
      expect(validator.error).toBeNull()
      expect(validator.solved).toBe(true)
      expect({ input, traces }).toEqual(before)
    })

test("sampled tuning banks retain their exact shape and annotation indices", () => {
  const { input, traces } = fixture()
  const t = traces[0],
    a = t.route[4],
    b = t.route[5]
  const curve = roundedTuningLobes(a, b, 1, 3, -1, 0.12)!
  const wire = a as Wire
  t.route = [
    ...t.route.slice(0, 4),
    ...curve.map((p) => ({ ...wire, ...p })),
    ...t.route.slice(6),
  ]
  t.curvedSegments = Array.from({ length: curve.length - 1 }, (_, i) => i + 5)
  const result = propose(input, traces)
  const displacement = {
    x: result[0].route[4].x - t.route[4].x,
    y: result[0].route[4].y - t.route[4].y,
  }
  for (let i = 4; i < 4 + curve.length; i++) {
    expect(result[0].route[i].x - t.route[i].x).toBeCloseTo(displacement.x, 8)
    expect(result[0].route[i].y - t.route[i].y).toBeCloseTo(displacement.y, 8)
  }
  expect(result[0].curvedSegments).toEqual(t.curvedSegments)
  expect(length(result[0].route)).toBeCloseTo(length(t.route), 7)
})

test("carrier extraction and reassembly preserve vias, escapes and curve indices", () => {
  const { input, traces } = fixture()
  const t = traces[0]
  t.curvedSegments = [4, 5]
  const carrier = structuredClone(t)
  const a = t.route[0] as Wire,
    b = t.route.at(-1)! as Wire
  t.route = [
    { ...a, x: a.x - 1, layer: "bottom" },
    { ...a, layer: "bottom" },
    {
      route_type: "via",
      x: a.x,
      y: a.y,
      from_layer: "bottom",
      to_layer: "top",
      via_diameter: 0.3,
    },
    ...t.route,
    {
      route_type: "via",
      x: b.x,
      y: b.y,
      from_layer: "top",
      to_layer: "bottom",
      via_diameter: 0.3,
    },
    { ...b, layer: "bottom" },
    { ...b, x: b.x + 1, layer: "bottom" },
  ]
  input.connections[0].pointsToConnect = [
    t.route[0] as Wire,
    t.route.at(-1)! as Wire,
  ]
  t.curvedSegments = t.curvedSegments.map((i) => i + 3)
  const before = structuredClone({ input, traces })
  const view = carrierCompactionView(input, traces)!
  expect(view.carriers[0] as Trace).toEqual(carrier)
  expect(view.join(view.carriers)).toEqual(traces)
  expect(view.input.traces!.slice(0, input.traces!.length)).toEqual(
    input.traces!,
  )
  expect(
    view.input
      .traces!.slice(input.traces!.length)
      .flatMap((t) => t.route)
      .filter((p) => p.route_type === "via"),
  ).toHaveLength(2)
  expect({ input, traces }).toEqual(before)
})

test("cancelling a pending compaction leaves accepted copper untouched", () => {
  const { input, traces } = fixture(),
    before = structuredClone(traces)
  const search = compactEnvelopeCandidate(input, traces)
  expect(search.next().done).toBe(false)
  search.return(traces)
  expect(traces).toEqual(before)
})

for (const mode of ["coordinated", "flexible", "guarded"] as const)
  test(`${mode} reduces matched copper within full-pad length bounds`, () => {
    const { input, traces } = fixture()
    const companion = structuredClone(traces[0])
    companion.connection_name = "companion"
    companion.pcb_trace_id = "companion"
    for (const point of companion.route)
      if (point.route_type === "wire") point.layer = "bottom"
    traces.push(companion)
    input.connections.push({
      name: "companion",
      pointsToConnect: [
        companion.route[0] as Wire,
        companion.route.at(-1)! as Wire,
      ],
    })
    input.traces!.push({
      type: "pcb_trace",
      pcb_trace_id: "fixed-companion",
      connection_name: "companion",
      route: [0, 2].map((x) => ({
        route_type: "wire",
        x,
        y: -10,
        width: 0.1,
        layer: "bottom",
      })),
    })
    const initial = length(traces[0].route)
    input.buses = [
      {
        busId: "bounded",
        connectionNames: ["matched", "companion"],
        maxLengthSkew: 2.01,
        minLength: initial - 3,
        maxLength: initial + 2.01,
      },
    ]
    const before = structuredClone({ input, traces })
    const result = propose(input, traces, mode)
    expect(signalEnvelope(result).areaMm2).toBeLessThan(
      signalEnvelope(traces).areaMm2,
    )
    expect(length(result[0].route)).toBeLessThan(initial - 1)
    const report = busLengthReports(input, result)[0]
    expect(report.matched).toBe(true)
    expect(report.aboveMinimumLength).toBe(true)
    expect(report.withinLengthLimit).toBe(true)
    expect(report.lengths[1].fixedLengthMm).toBe(2)
    expect(
      exteriorPairSpacingReports(input, result).every((r) => r.matched),
    ).toBe(true)
    for (let i = 0; i < traces.length; i++) {
      expect(result[i].route[0]).toEqual(traces[i].route[0])
      expect(result[i].route.at(-1)).toEqual(traces[i].route.at(-1))
      expect(length(result[i].route)).toBeLessThanOrEqual(
        length(traces[i].route) + 1e-7,
      )
    }
    expect({ input, traces }).toEqual(before)
    const validator = BusLanesSolver.forValidation(input, result, {
      smoothTuning: true,
    })
    validator.solve()
    expect(validator.error).toBeNull()
    expect(validator.solved).toBe(true)
  })

for (const turn of [false, true])
  test(`flexible tuning keeps every sampled bend rigid (${turn})`, () => {
    const { input, traces } = fixture(turn)
    const t = traces[0],
      a = t.route[4],
      b = t.route[5]
    const curve = roundedTuningLobes(a, b, 4, 3, -1, 0.12)!
    t.route = [
      ...t.route.slice(0, 4),
      ...curve.map((p) => ({ ...a, ...p })),
      ...t.route.slice(6),
    ]
    t.curvedSegments = t.route.slice(1).flatMap((p, i) => {
      const dx = Math.abs(p.x - t.route[i].x),
        dy = Math.abs(p.y - t.route[i].y)
      return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8 ? [i + 1] : []
    })
    const result = propose(input, traces, "flexible")[0]
    expect(signalEnvelope([result]).areaMm2).toBeLessThan(
      signalEnvelope([t]).areaMm2,
    )
    expect(result.curvedSegments).toEqual(t.curvedSegments)
    for (const i of t.curvedSegments) {
      expect(result.route[i].x - result.route[i - 1].x).toBeCloseTo(
        t.route[i].x - t.route[i - 1].x,
        8,
      )
      expect(result.route[i].y - result.route[i - 1].y).toBeCloseTo(
        t.route[i].y - t.route[i - 1].y,
        8,
      )
    }
    expect(result.route[0]).toEqual(t.route[0])
    expect(result.route.at(-1)).toEqual(t.route.at(-1))
  })

test("coordinated compaction moves coupled rails together", async () => {
  const { offsetPath } = await import("../lib/coupled-pair-routing")
  const center = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 1 },
    { x: 2, y: 5 },
    { x: 3, y: 6 },
    { x: 8, y: 6 },
    { x: 9, y: 5 },
    { x: 9, y: 1 },
    { x: 10, y: 0 },
    { x: 11, y: 0 },
  ]
  const traces: Trace[] = [-0.11, 0.11].map((offset, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `rail${i}`,
    connection_name: `rail${i}`,
    coupledSection: [0, center.length - 1],
    route: offsetPath(center, offset).map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.1,
      layer: "top",
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 20, minY: -10, maxY: 20 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0] as Wire, t.route.at(-1)! as Wire],
    })),
    differentialPairs: [
      {
        connectionNames: ["rail0", "rail1"],
        traceGap: 0.12,
        lengthTolerance: 0.127,
      },
    ],
  }
  const result = propose(input, traces, "coordinated")
  expect(signalEnvelope(result).areaMm2).toBeLessThan(
    signalEnvelope(traces).areaMm2 * 0.8,
  )
  expect(
    exteriorPairSpacingReports(input, result).every((r) => r.matched),
  ).toBe(true)
  const validator = BusLanesSolver.forValidation(input, result, {
    smoothTuning: true,
  })
  validator.solve()
  expect(validator.error).toBeNull()
  expect(validator.solved).toBe(true)
})

test("guarded compaction keeps the existing terminal-via approach", async () => {
  const { createTerminalViaClearanceChecker } = await import(
    "../lib/terminal-via-clearance"
  )
  const { input, traces } = fixture()
  const start = traces[0].route[0]
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "matched-via",
    connection_name: "matched",
    route: [
      {
        route_type: "via",
        x: start.x,
        y: start.y,
        from_layer: "bottom",
        to_layer: "top",
        via_diameter: 0.6,
      },
    ],
  })
  const before = structuredClone(input)
  const result = propose(input, traces, "guarded")
  expect(result[0].route.slice(0, 2)).toEqual(traces[0].route.slice(0, 2))
  expect(signalEnvelope(result).areaMm2).toBeLessThan(
    signalEnvelope(traces).areaMm2,
  )
  expect(
    createTerminalViaClearanceChecker(input, traces[0])(result[0].route),
  ).toBe(true)
  expect(input).toEqual(before)
})
