import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeJointSurfaceBuses } from "../lib/route-joint-surface-buses"
import { routeSurfaceBridge } from "../lib/route-surface-bridge"
import type { SimpleRouteJson } from "../lib/types"

function finish<T>(work: Generator<void, T>) {
  let result = work.next(),
    iterations = 0
  try {
    while (!result.done && ++iterations < 50000) result = work.next()
    expect(result.done).toBe(true)
    return result.value as T
  } finally {
    if (!result.done) work.return(null as T)
  }
}

test("a package-window failure expands across the unchanged board instead of rejecting a legal outer-layer detour", () => {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.12,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.08,
    minBoardEdgeClearance: 0.2,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    outline: [
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
    ],
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
    obstacles: [
      ...[-3, 3].map((x) => ({
        componentId: x < 0 ? "driver" : "receiver",
        center: { x, y: 0 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: ["data"],
      })),
      {
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 12,
        layers: ["top", "bottom"],
        connectedTo: [],
      },
    ],
  }
  const before = structuredClone(native)
  expect(
    finish(
      routeSurfaceBridge(native, native.connections[0], {
        searchPadding: 4,
        maxExpansions: 400000,
      }),
    ),
  ).toBeNull()
  const routed = finish(
    routeJointSurfaceBuses(native, native, [], new Map(), {
      smoothTuning: true,
      denseSearch: true,
    }),
  )!
  expect(routed).not.toBeNull()
  expect(native).toEqual(before)
  const joined = joinSignalEscapes(routed.traces[0], routed.escapes)
  expect(joined.route.some((p) => Math.abs(p.y) > 6.1)).toBe(true)
  expect(
    joined.route.every(
      (p) => p.x >= -9.8 && p.x <= 9.8 && p.y >= -9.8 && p.y <= 9.8,
    ),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: { ...native, traces: [joined] },
      clearance: native.minTraceToPadEdgeClearance!,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
}, 30000)
