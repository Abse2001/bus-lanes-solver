import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { negotiateSignalSites } from "../lib/negotiate-signal-sites"
import { routeFreshSurfaceSeeds } from "../lib/route-fresh-surface-buses"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { distance, length } from "../lib/geometry"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import type { SimpleRouteJson, Wire } from "../lib/types"

const physical = ["top", "inner1", "inner2", "bottom"]

function fixture(blockAdjacent: boolean): FlexibleSignalState {
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
          type: "rect",
          center: { x: x + dx, y },
          width: 0.25,
          height: 0.25,
          layers: ["top"],
          connectedTo:
            dx === 0 && y === 0 ? ["signal"] : [`other_${x}_${dx}_${y}`],
        })),
      ),
    ),
    traces: [],
  }
  if (blockAdjacent)
    for (const x of [0, 4])
      for (const dx of [-0.8, 0, 0.8])
        for (const y of [-0.8, 0, 0.8]) {
          if (dx === 0 && y === 0) continue
          native.obstacles.push({
            type: "rect",
            shape: "circle",
            center: { x: x + dx, y },
            width: 0.3,
            height: 0.3,
            layers: physical,
            connectedTo: ["fixed_power"],
          })
        }
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
  options: Parameters<typeof negotiateSignalSites>[4],
): FlexibleSignalState | null {
  const work = negotiateSignalSites(
    state,
    new Set(["signal"]),
    false,
    false,
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

function verifyManufacturedConnection(
  state: FlexibleSignalState,
  result: FlexibleSignalState,
) {
  expect(result.traces).toHaveLength(1)
  const trace = joinSignalEscapes(result.traces[0], result.escapes)
  const endpoints = [trace.route[0], trace.route.at(-1)!]
  for (const [
    index,
    point,
  ] of state.native.connections[0].pointsToConnect.entries()) {
    expect(distance(point, endpoints[index])).toBeLessThan(1e-8)
    expect(endpoints[index]).toMatchObject({ route_type: "wire", layer: "top" })
  }
  expect(
    trace.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(2)
  for (const escape of result.escapes) {
    const via = escape.route.find((point) => point.route_type === "via")!
    expect(via.layers).toEqual(physical)
    const approach = escape.route.filter(
      (point) => point.route_type === "wire" && point.layer === "top",
    ) as Wire[]
    expect(length(approach)).toBeLessThanOrEqual(2 + 1e-8)
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: state.native,
    routedSrj: { ...state.native, traces: [trace] },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.valid).toBe(true)
  expect(drc.issues).toEqual([])
}

test("a blocked local domain receives a bounded expanded fallback without changing explicit denial", () => {
  const state = fixture(true)
  const before = structuredClone(state)
  expect(
    solve(state, { allowExpandedSites: false, expandOnlyWhenBlocked: true }),
  ).toBeNull()
  const result = solve(state, {
    allowExpandedSites: true,
    expandOnlyWhenBlocked: true,
  })
  expect(result).toBeTruthy()
  verifyManufacturedConnection(state, result!)
  expect(state).toEqual(before)
})

test("reachable local choices preserve the cheap routing geometry", () => {
  const state = fixture(false)
  const before = structuredClone(state)
  const cheap = solve(state, { allowExpandedSites: false })
  const fallback = solve(state, {
    allowExpandedSites: true,
    expandOnlyWhenBlocked: true,
  })
  expect(cheap).toBeTruthy()
  expect(fallback).toEqual(cheap)
  expect(state).toEqual(before)
})

test("the initial surface seed caller uses blocked-only expansion to keep a connected timing checkpoint", () => {
  const state = fixture(true)
  const before = structuredClone(state)
  const work = routeFreshSurfaceSeeds(
    state.native,
    state.pending,
    [],
    new Map([["signal", ["bottom"]]]),
    { smoothTuning: true, denseSearch: true },
  )
  let next = work.next()
  let timing: FlexibleSignalState | undefined
  try {
    for (let steps = 0; !next.done && steps < 100000; steps++) {
      if (next.value?.phase === "timing") timing = next.value.state
      next = work.next()
    }
    expect(next.done).toBe(true)
    expect(timing).toBeDefined()
    verifyManufacturedConnection(state, timing!)
  } finally {
    if (!next.done) work.return(null)
  }
  expect(state).toEqual(before)
})
