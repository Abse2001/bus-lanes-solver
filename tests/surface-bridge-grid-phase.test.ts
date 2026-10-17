import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  routeSurfaceBridge,
  surfaceBridgeGridGeometry,
} from "../lib/route-surface-bridge"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import type { SimpleRouteJson, Via } from "../lib"

test("growing bridge windows keep one translated board lattice", () => {
  const board = { minX: -10.013, maxX: 11, minY: -8.019, maxY: 10 }
  const windows = [
    { minX: -4.121, maxX: 5.832, minY: -1.41, maxY: 7.631 },
    { minX: -7.121, maxX: 8.832, minY: -4.41, maxY: 9.631 },
  ]
  const grids = windows.map(
    (window) => surfaceBridgeGridGeometry(board, window, 0.05)!,
  )
  expect(grids[0].step).toBe(0.05)
  expect(grids[1].step).toBe(0.05)
  for (const axis of ["minX", "minY"] as const) {
    const difference = (grids[0][axis] - grids[1][axis]) / 0.05
    expect(difference).toBeCloseTo(Math.round(difference), 9)
  }
  const delta = 0.013719
  const shifted = (bounds: typeof board) =>
    Object.fromEntries(
      Object.entries(bounds).map(([key, value]) => [key, value + delta]),
    ) as typeof board
  const translated = surfaceBridgeGridGeometry(
    shifted(board),
    shifted(windows[0]),
    0.05,
  )!
  expect(translated.minX - delta).toBeCloseTo(grids[0].minX, 10)
  expect(translated.minY - delta).toBeCloseTo(grids[0].minY, 10)
  expect(translated.columns).toBe(grids[0].columns)
  expect(translated.rows).toBe(grids[0].rows)
})

test("phase alignment respects the original raster cell budget and board bounds", () => {
  const board = { minX: -12, maxX: 9.7, minY: -5, maxY: 8.4 },
    window = { minX: -3.013, maxX: 7.919, minY: -2.417, maxY: 7.771 }
  for (const budget of [4, 9, 100, 10000]) {
    const grid = surfaceBridgeGridGeometry(board, window, 0.05, budget)!
    expect(grid).toBeTruthy()
    expect(grid.columns * grid.rows).toBeLessThanOrEqual(budget)
    expect(grid.minX).toBeGreaterThanOrEqual(board.minX)
    expect(grid.minY).toBeGreaterThanOrEqual(board.minY)
    expect(grid.minX + (grid.columns - 1) * grid.step).toBeLessThanOrEqual(
      window.maxX + 1e-9,
    )
    expect(grid.minY + (grid.rows - 1) * grid.step).toBeLessThanOrEqual(
      window.maxY + 1e-9,
    )
  }
})

function viaWindows(): SimpleRouteJson {
  const rect = (
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    layers: string[],
  ) => ({
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    width: maxX - minX,
    height: maxY - minY,
    layers,
    connectedTo: [],
  })
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1016,
    minTraceToPadEdgeClearance: 0.1016,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
    bounds: { minX: -4, maxX: 4, minY: -6, maxY: 6 },
    connections: [
      {
        name: "target",
        pointsToConnect: [
          { x: -2, y: 0.4, layer: "top" },
          { x: 2, y: 0.4, layer: "top" },
        ],
      },
    ],
    obstacles: [
      // These inner-plane rectangles leave two 0.67 mm land windows. With
      // the declared 0.4572 mm land and 0.1016 mm clearance, each legal via
      // center interval is only 0.0096 mm wide around y=0.4.
      rect(-4, 4, -6, 0.065, ["inner1"]),
      rect(-4, 4, 0.735, 6, ["inner1"]),
      rect(-4, -1.335, 0.065, 0.735, ["inner1"]),
      rect(-0.665, 0.665, 0.065, 0.735, ["inner1"]),
      rect(1.335, 4, 0.065, 0.735, ["inner1"]),
      rect(-0.1, 0.1, -6, 6, ["top"]),
      ...[-2, 2].map((x, i) => ({
        shape: "circle" as const,
        center: { x, y: 0.4 },
        width: 0.42,
        height: 0.42,
        componentId: String(i),
        layers: ["top"],
        connectedTo: ["target"],
      })),
    ],
  }
}

test("board alignment reaches narrow manufactured via sites missed by the local window phase", () => {
  // A window-relative origin at pad.minY - 4 = -3.81 puts its nearest row
  // at y=0.39, outside both legal intervals. The old phase cannot cross the
  // top-layer wall because it has no manufactured through-via landing.
  const oldNearest = -3.81 + Math.round((0.4 + 3.81) / 0.05) * 0.05
  expect(Math.abs(oldNearest - 0.4)).toBeGreaterThan(0.0048)
  for (const offset of [0, 0.013719]) {
    const input = viaWindows()
    for (const key of ["minX", "maxX", "minY", "maxY"] as const)
      input.bounds[key] += offset
    for (const connection of input.connections)
      for (const point of connection.pointsToConnect) {
        point.x += offset
        point.y += offset
      }
    for (const obstacle of input.obstacles) {
      obstacle.center.x += offset
      obstacle.center.y += offset
    }
    const search = routeSurfaceBridge(input, input.connections[0], {
      gridStep: 0.05,
      viaPenalty: 0,
      maxExpansions: 30000,
    })
    let step = search.next(),
      count = 0
    while (!step.done && count++ < 1000) step = search.next()
    expect(step.done).toBe(true)
    expect(step.value).toBeTruthy()
    const result = step.value!
    const joined = joinSignalEscapes(result.carrier, result.escapes)
    const vias = joined.route.filter(
      (point): point is Via => point.route_type === "via",
    )
    expect(vias).toHaveLength(2)
    expect(vias.map((via) => via.x - offset)).toEqual([-1, 1])
    for (const via of vias) expect(via.y - offset).toBeCloseTo(0.4, 9)
    expect(
      validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: { ...input, traces: [joined] },
        clearance: 0.1016,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
  }
})
