import { expect, test } from "bun:test"
import { compactEnvelopeCandidate } from "../lib/compact-envelope"
import {
  carrierCompactionView,
  signalEnvelope,
} from "../lib/carrier-compaction-view"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
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
function propose(input: SimpleRouteJson, traces: Trace[]) {
  const search = compactEnvelopeCandidate(input, traces)
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
