import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { negotiateSurfaceRoutes } from "../lib/negotiate-surface-routes"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

test("warm seed qualification includes owned native approaches in an absolute bus length limit", () => {
  const wire = (x: number, y: number, layer = "top"): Wire => ({
      x,
      y,
      layer,
      width: 0.12,
      route_type: "wire",
    }),
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.12,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minTraceToPadEdgeClearance: 0.08,
      bounds: { minX: -3, maxX: 3, minY: -2, maxY: 2 },
      obstacles: [],
      connections: [
        { name: "data", pointsToConnect: [wire(-2, 0), wire(2, 0)] },
      ],
      buses: [{ busId: "data", connectionNames: ["data"], maxLength: 4.5 }],
    },
    carrier: Trace = {
      type: "pcb_trace",
      pcb_trace_id: "old_body",
      connection_name: "data",
      route: [wire(-2, 1, "bottom"), wire(2, 1, "bottom")],
    },
    escapes: Trace[] = [-2, 2].map((x, index) => ({
      type: "pcb_trace",
      pcb_trace_id: `old_escape_${index}`,
      connection_name: "data",
      route: [
        wire(x, 0),
        wire(x, 1),
        {
          route_type: "via",
          x,
          y: 1,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        wire(x, 1, "bottom"),
      ],
    })),
    state: FlexibleSignalState = {
      native,
      pending: native,
      retained: [],
      traces: [carrier],
      escapes,
    },
    before = structuredClone(state),
    work = negotiateSurfaceRoutes(native, state, { maxRounds: 0 })
  expect(length(carrier.route)).toBe(4)
  expect(length(joinSignalEscapes(carrier, escapes).route)).toBe(6)
  let next = work.next(),
    steps = 0
  try {
    while (!next.done && ++steps < 50000) next = work.next()
    expect(next.done).toBe(true)
    expect(next.value).toBeTruthy()
    expect(state).toEqual(before)
    const result = next.value!,
      joined = joinSignalEscapes(result.traces[0], result.escapes)
    expect(length(joined.route)).toBeLessThanOrEqual(4.5)
    expect(joined.route[0]).toMatchObject(
      native.connections[0].pointsToConnect[0],
    )
    expect(joined.route.at(-1)).toMatchObject(
      native.connections[0].pointsToConnect[1],
    )
    expect(
      validateRoutedCopperDrc({
        inputSrj: native,
        routedSrj: { ...native, traces: [joined] },
        clearance: 0.08,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
  } finally {
    if (!next.done) work.return(null)
  }
})
