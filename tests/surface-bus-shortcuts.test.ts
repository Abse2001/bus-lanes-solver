import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { surfaceBusShortcutCandidates } from "../lib/surface-bus-shortcuts"
import { surfaceBridgeSelfShorts } from "../lib/route-surface-bridge"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const route = (name: string, points: number[][]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  source_trace_id: name,
  connection_name: name,
  route: points.map(
    ([x, y]): Wire => ({
      route_type: "wire",
      x,
      y,
      layer: "top",
      width: 0.1,
    }),
  ),
})

function fixture(): FlexibleSignalState {
  const traces = [
    route("A", [
      [-2, 0],
      [-2, 2.4],
      [2, 2.4],
      [2, 0],
    ]),
    route("B", [
      [-2, -2.4],
      [-2, -3],
      [2, -3],
      [2, -2.4],
    ]),
  ]
  const paired = [
    route("P", [
      [-0.5, 3.2],
      [0.5, 3.2],
    ]),
    route("Q", [
      [-0.5, 3.5],
      [0.5, 3.5],
    ]),
  ]
  const fixed = route("POWER", [
    [3, -1],
    [3, -1.4],
  ])
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    bounds: { minX: -4, maxX: 4, minY: -4, maxY: 4 },
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.1,
        height: 4,
        layers: ["top"],
        connectedTo: ["WALL"],
      },
    ],
    traces: [fixed],
    connections: [...traces, ...paired, fixed].map((trace) => ({
      name: trace.connection_name!,
      source_trace_id: trace.source_trace_id,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
    })),
    buses: [
      {
        busId: "BYTE",
        connectionNames: ["A", "B"],
        traceWidth: 0.1,
        maxLengthSkew: 0.1,
      },
    ],
    differentialPairs: [{ connectionNames: ["P", "Q"], lengthTolerance: 0.1 }],
  }
  return {
    native,
    pending: { ...native, traces: [fixed, ...paired] },
    traces,
    retained: paired,
    escapes: [],
  }
}

function run(state: FlexibleSignalState, maxExpansions?: number) {
  const search = surfaceBusShortcutCandidates(state, { maxExpansions })
  let result = search.next(),
    steps = 0
  while (!result.done && steps++ < 100000) result = search.next()
  expect(result.done).toBe(true)
  return result.done ? result.value : []
}

function drc(input: SimpleRouteJson, traces: Trace[]) {
  return validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: [...(input.traces ?? []), ...traces] },
    clearance: 0.05,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0])
}

test("bus shortcuts lower the actual longest copper target and retain every matching fallback", () => {
  const previous = fixture()
  const original = structuredClone(previous)
  expect(
    drc(previous.native, [...previous.retained, ...previous.traces]).issues,
  ).toEqual([])
  const candidates = run(previous)
  expect(candidates[0]).toBe(previous)
  expect(candidates.length).toBeGreaterThan(1)
  const first = candidates[1]
  const improved = first.traces.find((trace) => trace.connection_name === "A")!
  const joined = joinSignalEscapes(
    improved,
    first.escapes.filter((trace) => trace.connection_name === "A"),
  )
  expect(length(joined.route)).toBeLessThan(5.2)
  expect(
    joined.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(2)
  expect(first.traces.find((trace) => trace.connection_name === "B")).toBe(
    previous.traces[1],
  )
  for (const candidate of candidates) {
    const complete = [...candidate.retained, ...candidate.traces].map((trace) =>
      joinSignalEscapes(
        trace,
        candidate.escapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      ),
    )
    expect(candidate.retained).toEqual(previous.retained)
    expect(candidate.native.traces).toEqual(previous.native.traces)
    expect(candidate.native.buses).toEqual(previous.native.buses)
    expect(drc(candidate.native, complete).issues).toHaveLength(0)
    for (const trace of complete)
      expect(
        surfaceBridgeSelfShorts(
          candidate.native,
          candidate.native.connections.find(
            (connection) => connection.name === trace.connection_name,
          )!,
          trace,
        ),
      ).toBe(false)
  }
  expect(previous).toEqual(original)
})

test("an exhausted shortcut search preserves the original matching checkpoint", () => {
  const previous = fixture()
  const original = structuredClone(previous)
  expect(run(previous, 0)).toEqual([previous])
  expect(previous).toEqual(original)
})

test("a singleton skew constraint does not trigger an unnecessary shortcut search", () => {
  const previous = fixture()
  previous.native.buses![0].connectionNames = ["A"]
  const before = structuredClone(previous)
  // A has a shorter physical path in the two-member fixture above, but no
  // other member in this bus needs tuning to its current length.
  expect(run(previous)).toEqual([previous])
  expect(previous).toEqual(before)
})

test("an explicit four-via shortcut crosses alternating surface barriers", () => {
  const wire = (x: number, y: number, layer: string): Wire => ({
    route_type: "wire",
    x,
    y,
    layer,
    width: 0.1,
  })
  const makeTrace = (name: string, y: number, detourY: number): Trace => {
    const points: Trace["route"] = [wire(-3, y, "top")]
    if (detourY !== y) points.push(wire(-3, detourY, "top"))
    let layer = "top"
    for (const x of [-2.5, -0.8, 0.8, 2.5]) {
      const nextLayer = layer === "top" ? "bottom" : "top"
      points.push(
        wire(x, detourY, layer),
        {
          route_type: "via",
          x,
          y: detourY,
          from_layer: layer,
          to_layer: nextLayer,
          layers: ["top", "inner1", "inner2", "bottom"],
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        wire(x, detourY, nextLayer),
      )
      layer = nextLayer
    }
    if (detourY !== y) points.push(wire(3, detourY, "top"))
    points.push(wire(3, y, "top"))
    return {
      type: "pcb_trace",
      pcb_trace_id: name,
      connection_name: name,
      source_trace_id: name,
      route: points,
    }
  }
  const traces = [makeTrace("A", 0, 2), makeTrace("B", -2, -2)]
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    bounds: { minX: -4, maxX: 4, minY: -3, maxY: 3 },
    obstacles: [-1.5, 0, 1.5].map((x) => ({
      type: "rect" as const,
      center: { x, y: 0 },
      width: 0.2,
      height: 6,
      layers: [x === 0 ? "bottom" : "top"],
      connectedTo: ["WALL"],
    })),
    connections: traces.map((trace) => ({
      name: trace.connection_name!,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
    })),
    buses: [
      {
        busId: "BYTE",
        connectionNames: ["A", "B"],
        traceWidth: 0.1,
        maxLengthSkew: 0.1,
      },
    ],
  }
  const previous: FlexibleSignalState = {
    native,
    pending: native,
    traces,
    retained: [],
    escapes: [],
  }
  const before = structuredClone(previous)
  expect(drc(native, traces).issues).toEqual([])
  expect(run(previous)).toEqual([previous])
  const search = surfaceBusShortcutCandidates(previous, {
    maxVias: 4,
    maxExpansions: 100000,
  })
  let next = search.next()
  while (!next.done) next = search.next()
  expect(next.value.length).toBeGreaterThan(1)
  const last = next.value.at(-1)!
  const complete = last.traces.map((trace) =>
    joinSignalEscapes(
      trace,
      last.escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
  expect(length(complete[0].route)).toBeLessThan(6.2)
  expect(
    complete[0].route.filter((point) => point.route_type === "via"),
  ).toHaveLength(4)
  expect(drc(native, complete).issues).toEqual([])
  expect(previous).toEqual(before)
})
