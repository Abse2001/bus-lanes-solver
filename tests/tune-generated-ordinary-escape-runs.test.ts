import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { finishSurfaceTiming } from "../lib/finish-surface-timing"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { busLengthReports } from "../lib/route-lengths"
import { tuneGeneratedOrdinaryEscapeRuns } from "../lib/tune-generated-ordinary-escape-runs"
import type { SimpleRouteJson, Trace, Via, Wire } from "../lib/types"

const wire = (x: number, y: number, layer = "top"): Wire => ({
  x,
  y,
  layer,
  width: 0.1,
  route_type: "wire",
})
const via = (y: number, from_layer: string, to_layer: string): Via => ({
  x: 0,
  y,
  route_type: "via",
  from_layer,
  to_layer,
  layers: ["top", "inner1", "inner2", "bottom"],
  via_diameter: 0.3,
  via_hole_diameter: 0.15,
})
const trace = (name: string, id: string, route: Trace["route"]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  connection_name: name,
  source_trace_id: name,
  route,
})

function finish<T>(work: Generator<void, T>): T {
  let next = work.next(),
    yields = 0
  while (!next.done && yields++ < 10000) next = work.next()
  if (!next.done) throw Error("Owned run tuning exceeded its bound")
  return next.value
}

function fixture() {
  const firstViaEnd = {
      ...wire(0, 0.5, "bottom"),
      pointId: "first-held-via-end",
    },
    secondViaStart = {
      ...wire(0, 4.5, "bottom"),
      pointId: "second-held-via-start",
    }
  const carriers = [
    trace("data", "held-carrier", [wire(0, 8, "bottom"), wire(0, 9, "bottom")]),
    trace("peer", "held-peer", [wire(4, 0), wire(4, 14.5)]),
    trace("P", "held-pair-P", [wire(6, 0), wire(6, 14.5)]),
    trace("N", "held-pair-N", [wire(6.2, 0), wire(6.2, 14.5)]),
  ]
  const source = trace("data", "owned-three-via", [
      wire(0, 0),
      wire(0, 0.5),
      via(0.5, "top", "bottom"),
      firstViaEnd,
      secondViaStart,
      via(4.5, "bottom", "top"),
      wire(0, 4.5),
      wire(0, 8),
      via(8, "top", "bottom"),
      wire(0, 8, "bottom"),
    ]),
    target = trace("data", "owned-one-via", [
      wire(0, 10),
      wire(0, 9.5),
      via(9.5, "top", "bottom"),
      wire(0, 9.5, "bottom"),
      wire(0, 9, "bottom"),
    ]),
    escapes = [source, target],
    supplied = trace("data", "supplied-same-net-stub", [
      wire(-3, -2),
      wire(-3, -1),
    ])
  source.curvedSegments = [1, 7]
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    bounds: { minX: -4, maxX: 10, minY: -3, maxY: 16 },
    connections: [
      { name: "data", pointsToConnect: [wire(0, 0), wire(0, 10)] },
      ...carriers.slice(1).map((carrier) => ({
        name: carrier.connection_name!,
        pointsToConnect: carrier.route as Wire[],
      })),
    ],
    obstacles: [-0.3, 0.3].map((x) => ({
      type: "rect",
      center: { x, y: 6.25 },
      width: 0.2,
      height: 2.5,
      layers: ["top"],
      connectedTo: ["hard-channel-wall"],
    })),
    traces: [supplied, ...escapes],
    buses: [
      {
        busId: "matched-data",
        connectionNames: ["data", "peer"],
        maxLengthSkew: 0.1,
        maxLength: 14.5,
      },
    ],
    differentialPairs: [
      { connectionNames: ["P", "N"], traceGap: 0.1, lengthTolerance: 0.1 },
    ],
  }
  return { input, carriers, escapes, supplied }
}

test("an owned three-via middle run supplies missing copper without moving barrels, other runs or fixed traces", () => {
  const { input, carriers, escapes, supplied } = fixture(),
    before = structuredClone({ input, carriers, escapes }),
    result = finish(
      tuneGeneratedOrdinaryEscapeRuns(input, carriers, escapes, {
        maxCandidatesPerRun: 4096,
      }),
    )
  expect(result).toBeTruthy()
  if (!result) throw Error("Expected a useful Bottom escape-run tuning bank")
  expect(result.traces).toBe(carriers)
  expect(result.matchedNames).toEqual(["data"])
  expect(result.unfinishedNames).toEqual([])
  expect(result.input.traces).toContain(supplied)
  expect(result.escapes[1]).toBe(escapes[1])
  const changed = result.escapes[0],
    old = escapes[0],
    secondViaIndex = changed.route.findIndex(
      (point) => point.route_type === "via" && point.y === 4.5,
    ),
    oldTopEnd = changed.route.findIndex(
      (point) =>
        point.route_type === "wire" && point.layer === "top" && point.y === 8,
    ),
    joined = joinSignalEscapes(carriers[0], result.escapes)
  expect(changed.route.slice(0, 4)).toEqual(old.route.slice(0, 4))
  expect(changed.route.slice(secondViaIndex)).toEqual(old.route.slice(5))
  expect(changed.route[secondViaIndex - 1]).toEqual(old.route[4])
  expect(changed.curvedSegments).toContain(1)
  expect(changed.curvedSegments).toContain(oldTopEnd)
  expect(changed.route.filter((point) => point.route_type === "via")).toEqual(
    old.route.filter((point) => point.route_type === "via"),
  )
  expect(length(joined.route)).toBeCloseTo(13.4, 6)
  expect(length(joined.route) + length(supplied.route)).toBeCloseTo(14.4, 6)
  expect(routeAnglesAreConventional([joined])).toBe(true)
  const complete = carriers.map((carrier) =>
    joinSignalEscapes(
      carrier,
      result.escapes.filter(
        (escape) => escape.connection_name === carrier.connection_name,
      ),
    ),
  )
  expect(
    busLengthReports({ ...input, traces: [supplied] }, complete)[0].matched,
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [supplied, ...complete] },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect({ input, carriers, escapes }).toEqual(before)
})

test("paired and supplied escape copper is never treated as an owned tuning run", () => {
  const { input, carriers, escapes } = fixture(),
    before = structuredClone({ input, carriers, escapes })
  expect(
    finish(
      tuneGeneratedOrdinaryEscapeRuns(input, carriers, [], {
        maxCandidatesPerRun: 512,
      }),
    ),
  ).toBeNull()
  const pairedInput: SimpleRouteJson = {
    ...input,
    differentialPairs: [
      {
        connectionNames: ["data", "peer"],
        traceGap: 0.1,
        lengthTolerance: 0.1,
      },
    ],
  }
  expect(
    finish(
      tuneGeneratedOrdinaryEscapeRuns(pairedInput, carriers, escapes, {
        maxCandidatesPerRun: 512,
      }),
    ),
  ).toBeNull()
  expect({ input, carriers, escapes }).toEqual(before)
})

test("duplicate owned identifiers and collisions with supplied input are refused without mutation", () => {
  const { input, carriers, escapes, supplied } = fixture(),
    duplicate = [...escapes, { ...escapes[0] }],
    collisionInput = {
      ...input,
      traces: [
        { ...supplied, pcb_trace_id: escapes[0].pcb_trace_id },
        ...escapes,
      ],
    },
    before = structuredClone({
      input,
      carriers,
      escapes,
      duplicate,
      collisionInput,
    })
  expect(() =>
    tuneGeneratedOrdinaryEscapeRuns(input, carriers, duplicate).next(),
  ).toThrow()
  expect(() =>
    tuneGeneratedOrdinaryEscapeRuns(collisionInput, carriers, escapes).next(),
  ).toThrow()
  expect({ input, carriers, escapes, duplicate, collisionInput }).toEqual(
    before,
  )
})

test("default surface timing spends a multivia owned run before declaring carrier-only matching impossible", () => {
  const { input, carriers, escapes, supplied } = fixture(),
    native = { ...input, traces: [supplied], differentialPairs: [] },
    state: FlexibleSignalState = {
      native,
      pending: input,
      retained: [],
      traces: carriers,
      escapes,
    },
    before = structuredClone(state),
    result = finish(
      finishSurfaceTiming(
        state,
        { smoothTuning: true, denseSearch: false },
        { maxSteps: 30000 },
      ),
    )
  expect(result).toBeTruthy()
  if (!result) throw Error("Expected default timing to expose the owned run")
  const all = [...result.retained, ...result.traces]
  expect(
    busLengthReports(result.pending, all).every((report) => report.matched),
  ).toBe(true)
  const changed = result.escapes.find(
    (escape) => escape.pcb_trace_id === escapes[0].pcb_trace_id,
  )!
  expect(length(changed.route)).toBeGreaterThan(length(escapes[0].route))
  expect(changed.route.filter((point) => point.route_type === "via")).toEqual(
    escapes[0].route.filter((point) => point.route_type === "via"),
  )
  expect(result.pending.traces).toContain(supplied)
  expect(state).toEqual(before)
})
