import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { distance, length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { negotiateSignalSites } from "../lib/negotiate-signal-sites"
import type { SimpleRouteJson, Wire } from "../lib/types"

function nativeState(): FlexibleSignalState {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minBoardEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 7, minY: -3, maxY: 3 },
    connections: [
      {
        name: "signal",
        pointsToConnect: [0, 4].map((x) => ({ x, y: 0, layer: "top" })),
      },
      {
        name: "power",
        pointsToConnect: [-2, -1.5].map((x) => ({ x, y: -2, layer: "top" })),
      },
    ],
    buses: [
      {
        busId: "bottom_bus",
        connectionNames: ["signal"],
        allowedLayers: ["bottom"],
      },
    ],
    obstacles: [0, 4].flatMap((x) =>
      [0, 1.6].flatMap((dx) =>
        [0, 1.6].map((y) => ({
          componentId: `package_${x}`,
          shape: "circle" as const,
          center: { x: x + dx, y },
          width: 0.25,
          height: 0.25,
          layers: ["top"],
          connectedTo:
            dx === 0 && y === 0 ? ["signal"] : [`other_${x}_${dx}_${y}`],
        })),
      ),
    ),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "immutable_power",
        connection_name: "power",
        route: [-2, -1.5].map((x) => ({
          x,
          y: -2,
          layer: "top",
          width: 0.1,
          route_type: "wire",
        })),
      },
    ],
  }
  return {
    native,
    pending: {
      ...native,
      connections: native.connections.map((connection) => ({
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((point) => ({
          ...point,
          layer: connection.name === "signal" ? "bottom" : point.layer,
        })),
      })),
    },
    escapes: [],
    retained: [],
    traces: [],
  }
}

function solve(
  state: FlexibleSignalState,
  options: Parameters<typeof negotiateSignalSites>[4],
  expandNonNativeSites = false,
) {
  const work = negotiateSignalSites(
    state,
    new Set(["signal"]),
    false,
    expandNonNativeSites,
    options,
  )
  let next = work.next()
  try {
    for (let steps = 0; !next.done && steps < 100000; steps++)
      next = work.next()
    expect(next.done).toBe(true)
    return next.done ? next.value : null
  } finally {
    if (!next.done) work.return(null)
  }
}

test("a retained physical site without a reachable carrier cannot suppress blocked-only expansion", () => {
  const original = nativeState()
  const originalBefore = structuredClone(original)
  const routed = solve(original, { allowExpandedSites: false })
  expect(routed).toBeTruthy()
  expect(original).toEqual(originalBefore)
  // The new hard wall blocks every adjacent carrier choice, while the old
  // native approaches remain physical. A bounded top approach can place a
  // new bottom handoff on the other side without moving the fixed copper.
  const native = {
    ...routed!.native,
    obstacles: [
      ...routed!.native.obstacles,
      {
        center: { x: 1.2, y: 0 },
        width: 0.2,
        height: 6,
        layers: ["bottom"],
        connectedTo: ["fixed_wall"],
      },
    ],
  }
  const changed = {
    ...routed!,
    native,
    pending: { ...routed!.pending, obstacles: native.obstacles },
  }
  const before = structuredClone(changed)
  const options = { retainExistingRoutes: true, expandOnlyWhenBlocked: true }
  expect(solve(changed, { ...options, allowExpandedSites: false })).toBeNull()
  // Default callers retain their existing local-site policy.
  expect(solve(changed, { retainExistingRoutes: true })).toBeNull()
  const collective = solve(changed, { retainExistingRoutes: true }, true)
  const fallback = solve(changed, options)
  expect(collective).toBeTruthy()
  expect(fallback).toBeTruthy()
  expect(fallback).toEqual(collective)
  expect(fallback!.traces).toHaveLength(1)
  const joined = joinSignalEscapes(fallback!.traces[0], fallback!.escapes)
  const endpoints = [joined.route[0], joined.route.at(-1)!]
  for (const [end, point] of native.connections[0].pointsToConnect.entries()) {
    expect(distance(endpoints[end], point)).toBeLessThan(1e-8)
    expect(endpoints[end]).toMatchObject({ route_type: "wire", layer: "top" })
  }
  for (const escape of fallback!.escapes) {
    const approach = escape.route.filter(
      (point): point is Wire =>
        point.route_type === "wire" && point.layer === "top",
    )
    expect(length(approach)).toBeLessThanOrEqual(2 + 1e-8)
    const via = escape.route.find((point) => point.route_type === "via")!
    expect(via.layers).toEqual(["top", "inner1", "inner2", "bottom"])
    expect(via.via_diameter).toBe(0.3)
    expect(via.via_hole_diameter).toBe(0.15)
  }
  const output = { ...native, traces: [...native.traces!, joined] }
  const drc = validateRoutedCopperDrc({
    inputSrj: native,
    routedSrj: output,
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.valid).toBe(true)
  expect(drc.issues).toEqual([])
  expect(output.traces.slice(0, native.traces!.length)).toEqual(native.traces!)
  expect(changed).toEqual(before)
})
