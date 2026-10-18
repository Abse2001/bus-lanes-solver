import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { negotiateSurfaceRoutes } from "../lib/negotiate-surface-routes"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("surface negotiation supplements the board lattice when supplied copper leaves an exact-clearance via channel", () => {
  const rails: Trace[] = [-1.4, -0.638, 0.6, 1.362].map((x, index) => ({
      type: "pcb_trace",
      pcb_trace_id: `rail_${index}`,
      connection_name: `rail_${index}`,
      route: [-1.4492, 1.4492].map((y) => ({
        x,
        y,
        route_type: "wire",
        layer: "top",
        width: 0.1016,
      })),
    })),
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.1016,
      minTraceToPadEdgeClearance: 0.1016,
      minViaPadDiameter: 0.4572,
      minViaHoleDiameter: 0.254,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
      bounds: { minX: -3, maxX: 3, minY: -1.5, maxY: 1.5 },
      obstacles: [],
      connections: [
        {
          name: "target",
          pointsToConnect: [-1, 1].map((x) => ({ x, y: 0, layer: "top" })),
        },
      ],
      traces: rails,
    },
    state: FlexibleSignalState = {
      native,
      pending: native,
      retained: [],
      traces: [],
      escapes: [],
    },
    before = structuredClone(state),
    finish = (criticalGridOrigins: boolean, endpointViaAttachments = false) => {
      const search = negotiateSurfaceRoutes(native, state, {
        criticalGridOrigins,
        endpointViaAttachments,
        surfaceGridStep: 0.1,
        maxRounds: 0,
        maxClosureSize: 0,
        maxInitialSoftExpansions: 10000,
        maxInitialExpansions: 10000,
      })
      let result = search.next(),
        work = 0
      while (!result.done && ++work < 10000) result = search.next()
      if (!result.done) search.return(null)
      expect(result.done).toBe(true)
      return result.value
    }
  expect(finish(false)).toBeNull()
  const input = {
    ...native,
    connections: [
      ...native.connections,
      ...rails.map((trace) => ({
        name: trace.connection_name!,
        pointsToConnect: trace.route,
      })),
    ],
  }
  for (const result of [finish(true), finish(false, true)]) {
    expect(result).toBeTruthy()
    expect(state).toEqual(before)
    const joined = joinSignalEscapes(result!.traces[0], result!.escapes)
    expect(
      joined.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(2)
    expect(
      validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: { ...input, traces: [...rails, joined] },
        clearance: 0.1016,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
  }
})
