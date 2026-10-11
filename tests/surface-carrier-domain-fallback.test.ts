import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { distance, length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { negotiateSignalSites } from "../lib/negotiate-signal-sites"
import type { SimpleRouteJson, Wire } from "../lib/types"

const physical = ["top", "inner1", "inner2", "bottom"]

function crossedSurfaceFixture(): FlexibleSignalState {
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
        name: "first",
        pointsToConnect: [
          { x: 0, y: -0.8, layer: "top" },
          { x: 4, y: 0.8, layer: "top" },
        ],
      },
      {
        name: "second",
        pointsToConnect: [
          { x: 0, y: 0.8, layer: "top" },
          { x: 4, y: -0.8, layer: "top" },
        ],
      },
    ],
    obstacles: [],
    traces: [],
  }
  const blockedSites = new Set<string>()
  for (const connection of native.connections)
    for (const pad of connection.pointsToConnect) {
      native.obstacles.push({
        type: "rect",
        shape: "circle",
        componentId: pad.x === 0 ? "left_package" : "right_package",
        center: { x: pad.x, y: pad.y },
        width: 0.25,
        height: 0.25,
        layers: ["top"],
        connectedTo: [connection.name],
      })
      // The native surface remains clear, but every adjacent manufactured
      // barrel intersects immutable copper on the other physical layers.
      for (const dx of [-0.8, 0, 0.8])
        for (const dy of [-0.8, 0, 0.8]) {
          if (dx === 0 && dy === 0) continue
          const point = { x: pad.x + dx, y: pad.y + dy }
          const key = JSON.stringify(point)
          if (blockedSites.has(key)) continue
          blockedSites.add(key)
          native.obstacles.push({
            type: "rect",
            shape: "circle",
            center: point,
            width: 0.3,
            height: 0.3,
            layers: ["inner1", "inner2", "bottom"],
            connectedTo: ["fixed_power"],
          })
        }
    }
  // These native-layer walls make the reversed terminal order a real
  // routing conflict; one individually reachable Top carrier cannot
  // supply a compatible route for the other connection.
  for (const x of [-0.35, 4.35])
    native.obstacles.push({
      type: "rect",
      center: { x, y: 0 },
      width: 0.2,
      height: 6,
      layers: ["top"],
      connectedTo: ["fixed_power"],
    })
  return {
    native,
    pending: {
      ...native,
      connections: native.connections.map((connection) => ({
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((point) => ({
          ...point,
          layer: "bottom",
        })),
      })),
    },
    retained: [],
    traces: [],
    escapes: [],
  }
}

function solve(
  state: FlexibleSignalState,
  names: string[],
  allowExpandedSites: boolean,
) {
  const work = negotiateSignalSites(state, new Set(names), false, false, {
    allowExpandedSites,
    expandOnlyWhenBlocked: true,
  })
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

test("a reachable native carrier does not suppress a missing carrier's manufactured sites", () => {
  const state = crossedSurfaceFixture()
  const before = structuredClone(state)
  for (const connection of state.native.connections) {
    const cheap = solve(state, [connection.name], false)
    expect(cheap).toBeTruthy()
    expect(cheap!.traces).toHaveLength(1)
    expect(cheap!.traces[0].route[0]).toMatchObject({ layer: "top" })
    expect(cheap!.escapes.flatMap((trace) => trace.route)).not.toContainEqual(
      expect.objectContaining({ route_type: "via" }),
    )
  }
  const result = solve(
    state,
    state.native.connections.map((connection) => connection.name),
    true,
  )
  expect(result).toBeTruthy()
  expect(result!.traces).toHaveLength(2)
  expect(
    result!.traces.every(
      (trace) =>
        trace.route[0].route_type === "wire" &&
        trace.route[0].layer === "bottom",
    ),
  ).toBe(true)
  const joined = result!.traces.map((trace) =>
    joinSignalEscapes(
      trace,
      result!.escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
  for (const trace of joined) {
    const connection = state.native.connections.find(
      (candidate) => candidate.name === trace.connection_name,
    )!
    expect(
      distance(trace.route[0], connection.pointsToConnect[0]),
    ).toBeLessThan(1e-8)
    expect(
      distance(trace.route.at(-1)!, connection.pointsToConnect[1]),
    ).toBeLessThan(1e-8)
    expect(
      trace.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(2)
  }
  for (const escape of result!.escapes) {
    const via = escape.route.find((point) => point.route_type === "via")!
    expect(via).toMatchObject({
      layers: physical,
      via_diameter: 0.3,
      via_hole_diameter: 0.15,
    })
    expect(distance(escape.route[0], via)).toBeGreaterThan(1.2)
    const approach = escape.route.filter(
      (point) => point.route_type === "wire" && point.layer === "top",
    ) as Wire[]
    expect(length(approach)).toBeLessThanOrEqual(2 + 1e-8)
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: state.native,
    routedSrj: { ...state.native, traces: joined },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.valid).toBe(true)
  expect(drc.issues).toEqual([])
  expect(state).toEqual(before)
}, 30000)
