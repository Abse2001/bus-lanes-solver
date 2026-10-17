import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import {
  negotiateSurfaceRoutes,
  type SurfaceNegotiationProgress,
} from "../lib/negotiate-surface-routes"
import type { SimpleRouteJson } from "../lib/types"

function finish<T>(work: Generator<void, T>) {
  let result = work.next(),
    iterations = 0
  try {
    while (!result.done && ++iterations < 10000) result = work.next()
    expect(result.done).toBe(true)
    return result.value as T
  } finally {
    if (!result.done) work.return(null as T)
  }
}

test("a timed lane can explicitly negotiate four physical surface transitions without weakening DRC", () => {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.15,
    minBoardEdgeClearance: 0.05,
    bounds: { minX: -4, maxX: 4, minY: -0.7, maxY: 0.7 },
    connections: [
      {
        name: "data",
        pointsToConnect: [
          { x: -3, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
    ],
    buses: [{ busId: "data", connectionNames: ["data"], maxLengthSkew: 0.1 }],
    obstacles: [-1.5, 0, 1.5].map((x, index) => ({
      center: { x, y: 0 },
      width: 0.2,
      height: 2,
      layers: [index === 1 ? "bottom" : "top"],
      connectedTo: [],
    })),
  }
  const state: FlexibleSignalState = {
      native,
      pending: native,
      escapes: [],
      retained: [],
      traces: [],
    },
    before = structuredClone(state),
    settings = {
      maxRounds: 0,
      maxExpansions: 40000,
      maxInitialExpansions: 80000,
    }
  expect(finish(negotiateSurfaceRoutes(native, state, settings))).toBeNull()
  const progress: SurfaceNegotiationProgress[] = []
  const result = finish(
    negotiateSurfaceRoutes(native, state, {
      ...settings,
      maxTimedVias: 4,
      congestionHistory: true,
      onProgress: (p) => progress.push(p),
    }),
  )!
  expect(result).not.toBeNull()
  expect(state).toEqual(before)
  const joined = joinSignalEscapes(result.traces[0], result.escapes)
  expect(joined.route.filter((p) => p.route_type === "via")).toHaveLength(4)
  expect(progress.at(-1)).toMatchObject({
    stage: "complete",
    routedSignals: 1,
    mutuallyClearSignals: 1,
    requestedSignals: 1,
    conflicts: 0,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: { ...native, traces: [joined] },
      clearance: native.minTraceToPadEdgeClearance!,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
})
