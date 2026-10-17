import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { criticalSurfaceGridOrigins } from "../lib/critical-surface-grid-origins"
import {
  routeSurfaceBridge,
  surfaceBridgeGridGeometry,
} from "../lib/route-surface-bridge"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import type { Point, SimpleRouteJson, Trace, Via } from "../lib"

function channel(horizontal: boolean, offset: number): SimpleRouteJson {
  const transform = (point: Point) => ({
    x: (horizontal ? point.y : point.x) + offset,
    y: (horizontal ? point.x : point.y) + offset,
  })
  const traces: Trace[] = [-1.4, -0.638, 0.6, 1.362].map((x, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `rail-${i}`,
    connection_name: `rail-${i}`,
    route: [-1.4492, 1.4492].map((y) => ({
      ...transform({ x, y }),
      route_type: "wire",
      layer: "top",
      width: 0.1016,
    })),
  }))
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1016,
    minTraceToPadEdgeClearance: 0.1016,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
    bounds: horizontal
      ? {
          minX: -1.5 + offset,
          maxX: 1.5 + offset,
          minY: -3 + offset,
          maxY: 3 + offset,
        }
      : {
          minX: -3 + offset,
          maxX: 3 + offset,
          minY: -1.5 + offset,
          maxY: 1.5 + offset,
        },
    obstacles: [],
    connections: [
      {
        name: "target",
        pointsToConnect: [-1, 1].map((x) => ({
          ...transform({ x, y: 0 }),
          layer: "top",
        })),
      },
      ...traces.map((trace) => ({
        name: trace.connection_name!,
        pointsToConnect: trace.route.map((point) => ({
          x: point.x,
          y: point.y,
          layer: "top",
        })),
      })),
    ],
    traces,
  }
}

function finish(input: SimpleRouteJson, gridOrigin?: Point) {
  const search = routeSurfaceBridge(input, input.connections[0], {
    gridStep: 0.1,
    gridOrigin,
    viaPenalty: 0,
    maxExpansions: 10000,
  })
  let step = search.next(),
    count = 0
  while (!step.done && count++ < 1000) step = search.next()
  expect(step.done).toBe(true)
  return step.value
}

test("critical phases route exact-clearance via channels missed by every default raster row", () => {
  for (const horizontal of [false, true])
    for (const offset of [0, 0.013719]) {
      const input = channel(horizontal, offset),
        before = JSON.stringify(input)
      // Center separation .762 = .4572 land + two .0508 rail radii
      // + two .1016 clearances. A legal land center has zero lateral slack.
      expect(finish(input)).toBeNull()
      const origins = criticalSurfaceGridOrigins(
        input,
        input.connections[0],
        0.1,
      )
      expect(origins).toHaveLength(1)
      const result = finish(input, origins[0])
      expect(result).toBeTruthy()
      const joined = joinSignalEscapes(result!.carrier, result!.escapes)
      const vias = joined.route.filter(
        (point): point is Via => point.route_type === "via",
      )
      expect(vias).toHaveLength(2)
      for (const [i, via] of vias.entries())
        expect((horizontal ? via.y : via.x) - offset).toBeCloseTo(
          i === 0 ? -1.019 : 0.981,
          8,
        )
      const report = validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: { ...input, traces: [...input.traces!, joined] },
        clearance: 0.1016,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0])
      expect(report.valid).toBe(true)
      expect(JSON.stringify(input)).toBe(before)
    }
})

test("custom phases remain bounded, validated and supplemental to the board lattice", () => {
  const input = channel(false, 0)
  for (const gridOrigin of [
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
  ])
    expect(
      routeSurfaceBridge(input, input.connections[0], { gridOrigin }).next(),
    ).toEqual({ done: true, value: null })
  for (const budget of [4, 9, 100]) {
    const grid = surfaceBridgeGridGeometry(
      input.bounds,
      input.bounds,
      0.1,
      budget,
      { x: -1.019, y: input.bounds.minY },
    )!
    expect(grid).toBeTruthy()
    expect(grid.columns * grid.rows).toBeLessThanOrEqual(budget)
  }
  expect(
    criticalSurfaceGridOrigins(input, input.connections[0], 0.1, 1),
  ).toHaveLength(1)
  expect(
    criticalSurfaceGridOrigins(input, input.connections[0], 0.1, 0),
  ).toEqual([])
})
