import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { finishSurfaceTiming } from "../lib/finish-surface-timing"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { length } from "../lib/geometry"
import { busLengthReports } from "../lib/route-lengths"
import { tuneGeneratedOrdinaryEscapes } from "../lib/tune-generated-ordinary-escapes"
import type { Wire, Via, Trace, Connection } from "../lib/types"

test("ordinary matching can spend caller-owned TOP approach length while holding the BOTTOM carrier and all barrels", () => {
  const wire = (x: number, y: number, layer = "top"): Wire => ({
    route_type: "wire",
    x,
    y,
    layer,
    width: 0.1,
  })
  const via = (x: number, y: number): Via => ({
    route_type: "via",
    x,
    y,
    from_layer: "top",
    to_layer: "bottom",
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
  const carriers: Trace[] = [
    trace("data", "data-carrier", [wire(0, 4, "bottom"), wire(0, 8, "bottom")]),
    trace("peer", "peer", [wire(4, 0), wire(4, 12)]),
    trace("p", "paired-p", [wire(6, 0), wire(6, 12)]),
    trace("q", "paired-q", [wire(6.2, 0), wire(6.2, 12)]),
  ]
  const escapes: Trace[] = [
    trace("data", "owned-data-0", [
      wire(0, 0),
      wire(0, 4),
      via(0, 4),
      wire(0, 4, "bottom"),
    ]),
    trace("data", "owned-data-1", [
      wire(0, 10),
      wire(0, 8),
      via(0, 8),
      wire(0, 8, "bottom"),
    ]),
  ]
  const power = trace("power", "supplied-power-fanout", [
    wire(8, 5.5),
    wire(8, 6),
    via(8, 6),
    wire(8, 6, "bottom"),
    wire(8, 6.5, "bottom"),
  ])
  const connections: Connection[] = [
    { name: "data", pointsToConnect: [wire(0, 0), wire(0, 10)] },
    { name: "peer", pointsToConnect: [wire(4, 0), wire(4, 12)] },
    { name: "p", pointsToConnect: [wire(6, 0), wire(6, 12)] },
    { name: "q", pointsToConnect: [wire(6.2, 0), wire(6.2, 12)] },
    { name: "power", pointsToConnect: [wire(8, 5.5), wire(8, 6.5, "bottom")] },
  ]
  const input: any = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    minPlatedHoleDrillEdgeToDrillEdgeClearance: 0.15,
    bounds: { minX: -3, maxX: 10, minY: -2, maxY: 14 },
    connections,
    obstacles: connections.flatMap((c) =>
      c.pointsToConnect.map((p) => ({
        center: { x: p.x, y: p.y },
        shape: "circle",
        width: 0.1,
        height: 0.1,
        layers: [p.layer],
        connectedTo: [c.name],
      })),
    ),
    traces: [power, ...escapes],
    buses: [
      {
        busId: "data-bus",
        connectionNames: ["data", "peer"],
        maxLengthSkew: 0.1,
      },
    ],
    differentialPairs: [
      { connectionNames: ["p", "q"], lengthTolerance: 0.1, traceGap: 0.1 },
    ],
  }
  const before = JSON.stringify({ input, carriers, escapes }),
    barrels = escapes.flatMap((t) =>
      t.route.filter((p) => p.route_type === "via"),
    ),
    work = tuneGeneratedOrdinaryEscapes(input, carriers, escapes, {
      maxCandidatesPerEscape: 2048,
    })
  let next = work.next()
  while (!next.done) next = work.next()
  expect(next.value).not.toBeNull()
  const result = next.value!
  expect(result.matchedNames).toEqual(["data"])
  expect(result.unfinishedNames).toEqual([])
  expect(JSON.stringify({ input, carriers, escapes })).toBe(before)
  expect(result.traces).toBe(carriers)
  expect(result.input.traces![0]).toBe(power)
  expect(
    result.traces.filter((t) => ["p", "q"].includes(t.connection_name!)),
  ).toEqual(carriers.filter((t) => ["p", "q"].includes(t.connection_name!)))
  expect(
    result.escapes.flatMap((t) =>
      t.route.filter((p) => p.route_type === "via"),
    ),
  ).toEqual(barrels)
  const joined = carriers.map((t) =>
    joinSignalEscapes(
      t,
      result.escapes.filter((e) => e.connection_name === t.connection_name),
    ),
  )
  expect(length(joined[0].route)).toBeCloseTo(11.9, 6)
  expect(result.escapes.some((t) => t.curvedSegments?.length)).toBe(true)
  expect(
    busLengthReports({ ...input, traces: [power] }, joined)[0].matched,
  ).toBe(true)
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: [power, ...joined] },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as any)
  if (!drc.valid) console.log(drc.issues)
  expect(drc.valid).toBe(true)
  const suppliedOnly = tuneGeneratedOrdinaryEscapes(input, carriers, [], {
    maxCandidatesPerEscape: 2048,
  })
  let blocked = suppliedOnly.next()
  while (!blocked.done) blocked = suppliedOnly.next()
  expect(blocked.value).toBeNull()
  expect(JSON.stringify({ input, carriers, escapes })).toBe(before)
  const collidingInput = {
    ...input,
    traces: [{ ...power, pcb_trace_id: escapes[0].pcb_trace_id }, ...escapes],
  }
  const collidingBefore = JSON.stringify(collidingInput)
  expect(() =>
    tuneGeneratedOrdinaryEscapes(collidingInput, carriers, escapes).next(),
  ).toThrow("collides with supplied input")
  expect(JSON.stringify(collidingInput)).toBe(collidingBefore)

  const native = {
    ...input,
    differentialPairs: [],
    connections: connections.filter((c) => ["data", "peer"].includes(c.name)),
    traces: [power],
    obstacles: [
      ...input.obstacles,
      ...[-1.25, 1.25].map((x) => ({
        center: { x, y: 6 },
        width: 2,
        height: 6,
        layers: ["bottom"],
        connectedTo: [],
      })),
    ],
  }
  const state: FlexibleSignalState = {
    native,
    pending: { ...native, traces: [power, ...escapes] },
    traces: carriers.slice(0, 2),
    retained: [],
    escapes,
  }
  const finish = finishSurfaceTiming(
    state,
    { smoothTuning: true, denseSearch: true },
    { preserveTiming: true },
  )
  let completed = finish.next()
  while (!completed.done) completed = finish.next()
  expect(completed.value).not.toBeNull()
  expect(completed.value!.traces[0]).toEqual(carriers[0])
  expect(completed.value!.escapes.some((t) => t.curvedSegments?.length)).toBe(
    true,
  )
  expect(
    busLengthReports(completed.value!.pending, completed.value!.traces)[0]
      .matched,
  ).toBe(true)
})

test("ordinary escape matching includes supplied same-net copper in its target and matched-name report", () => {
  const wire = (x: number, y: number, layer = "top"): Wire => ({
      x,
      y,
      layer,
      width: 0.1,
      route_type: "wire",
    }),
    via = (y: number): Via => ({
      x: 0,
      y,
      route_type: "via",
      from_layer: "top",
      to_layer: "bottom",
      layers: ["top", "inner1", "inner2", "bottom"],
      via_diameter: 0.3,
      via_hole_diameter: 0.15,
    }),
    make = (name: string, id: string, route: Trace["route"]): Trace => ({
      type: "pcb_trace",
      pcb_trace_id: id,
      connection_name: name,
      route,
    }),
    carriers = [
      make("data", "held-data", [wire(0, 4, "bottom"), wire(0, 8, "bottom")]),
      make("peer", "held-peer", [wire(4, 0), wire(4, 12)]),
    ],
    escapes = [
      make("data", "owned-source", [
        wire(0, 0),
        wire(0, 4),
        via(4),
        wire(0, 4, "bottom"),
      ]),
      make("data", "owned-target", [
        wire(0, 10),
        wire(0, 8),
        via(8),
        wire(0, 8, "bottom"),
      ]),
    ],
    supplied = make("data", "supplied-data", [wire(-2, -1), wire(-1, -1)]),
    input = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.1,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
      bounds: { minX: -4, maxX: 6, minY: -3, maxY: 14 },
      obstacles: [],
      connections: [
        { name: "data", pointsToConnect: [wire(0, 0), wire(0, 10)] },
        { name: "peer", pointsToConnect: [wire(4, 0), wire(4, 12)] },
      ],
      traces: [supplied, ...escapes],
      buses: [
        {
          busId: "data-bus",
          connectionNames: ["data", "peer"],
          maxLengthSkew: 0.1,
        },
      ],
    },
    before = structuredClone({ input, carriers, escapes }),
    work = tuneGeneratedOrdinaryEscapes(input, carriers, escapes, {
      maxCandidatesPerEscape: 2048,
    })
  let next = work.next()
  while (!next.done) next = work.next()
  expect(next.value).toBeTruthy()
  const result = next.value!
  expect(result.matchedNames).toEqual(["data"])
  expect(result.unfinishedNames).toEqual([])
  expect(result.traces).toBe(carriers)
  expect(result.input.traces).toContain(supplied)
  const joined = joinSignalEscapes(carriers[0], result.escapes)
  expect(length(joined.route)).toBeCloseTo(10.9, 6)
  expect(length(joined.route) + length(supplied.route)).toBeCloseTo(11.9, 6)
  expect(
    busLengthReports({ ...input, traces: [supplied] }, [joined, carriers[1]])[0]
      .matched,
  ).toBe(true)
  expect({ input, carriers, escapes }).toEqual(before)
})
