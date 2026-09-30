import { expect, test } from "bun:test"
import { chamferPairApproaches } from "../lib/chamfer-pair-approaches"
import { length } from "../lib/geometry"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("acute pair handoffs become clearance-checked 45-degree corners before matching", () => {
  const traces: Trace[] = [
    [
      [0, 10],
      [0, 0],
      [3, 3],
      [5, 3],
    ],
    [
      [-0.22, 10],
      [-0.22, -1],
      [-2, -2],
    ],
  ].map((points, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `t${i}`,
    connection_name: `D${i}`,
    coupledSection: [0, 1],
    route: points.map(([x, y]) => ({
      route_type: "wire",
      x,
      y,
      width: 0.1,
      layer: "bottom",
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -5, maxX: 6, minY: -3, maxY: 11 },
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
  const next = chamferPairApproaches(
    input,
    input.connections,
    traces,
    [],
    0.1,
    0.1,
  )
  expect(length(next[0].route)).toBeLessThan(length(traces[0].route))
  expect(next[0].route[0]).toEqual(traces[0].route[0])
  expect(next[0].route.at(-1)).toEqual(traces[0].route.at(-1))
  expect(next[0].coupledSection).toEqual([0, 1])
  for (let i = 1; i < next[0].route.length - 1; i++) {
    const [a, b, c] = next[0].route.slice(i - 1, i + 2)
    const dot =
      ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
      (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y))
    expect(dot).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-8)
  }
})
