import { expect, test } from "bun:test"
import { chamferPairApproaches } from "../lib/chamfer-pair-approaches"
import { extendPairApproaches } from "../lib/extend-pair-approaches"
import { offsetPath } from "../lib/coupled-pair-routing"
import { pointSegmentDistance, distance } from "../lib/geometry"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("a paired bend with staggered rail vertices continues at the declared pitch", () => {
  const traces: Trace[] = [
    [
      [0, 10],
      [0, 0],
      [3, 3],
      [5, 3],
    ],
    [
      [-0.22, 9.95],
      [-0.22, -0.4],
      [0.3, -0.4],
      [3.48, 2.78],
      [5, 2.78],
    ],
  ].map((points, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `t${i}`,
    connection_name: `D${i}`,
    coupledSection: [0, 1],
    route: points.map(([x, y]) => ({
      x,
      y,
      route_type: "wire",
      width: 0.1,
      layer: "bottom",
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -2, maxX: 6, minY: -2, maxY: 11 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        x: p.x,
        y: p.y,
        layer: "bottom",
      })),
    })),
  }
  const chamfered = chamferPairApproaches(
    input,
    input.connections,
    traces,
    [],
    0.1,
    0.1,
  )
  const next = extendPairApproaches(
    input,
    input.connections,
    chamfered,
    [],
    0.1,
    0.12,
    0.1,
    offsetPath,
  )
  expect(next[1].route).not.toEqual(chamfered[1].route)
  for (let side = 0; side < 2; side++) {
    const path = next[side].route,
      mate = next[1 - side].route
    expect(path[0]).toEqual(traces[side].route[0])
    expect(path.at(-1)).toEqual(traces[side].route.at(-1))
    for (let i = 1; i < path.length; i++) {
      expect(distance(path[i - 1], path[i])).toBeGreaterThan(1e-8)
      for (let j = 0; j <= 20; j++) {
        const p = {
          x: path[i - 1].x + ((path[i].x - path[i - 1].x) * j) / 20,
          y: path[i - 1].y + ((path[i].y - path[i - 1].y) * j) / 20,
        }
        const gap =
          Math.min(
            ...mate
              .slice(1)
              .map((q, k) => pointSegmentDistance(p, [mate[k], q])),
          ) - 0.1
        expect(gap).toBeGreaterThanOrEqual(0.1199)
        expect(gap).toBeLessThanOrEqual(0.139)
      }
    }
  }
})
