import { expect, test } from "bun:test"
import { tightenPairApproaches } from "../lib/tighten-pair-approaches"
import { routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("parallel approaches close onto pair pitch without moving endpoints or changing headings", () => {
  const routes = [
    [
      [0, 2],
      [1, 1],
      [8, 1],
      [9, 2],
    ],
    [
      [0, 0.7],
      [9, 0.7],
    ],
  ]
  const traces: Trace[] = routes.map((points, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `t${i}`,
    connection_name: `D${i}`,
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
    bounds: { minX: -1, maxX: 10, minY: -1, maxY: 3 },
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
  const next = tightenPairApproaches(
    input,
    input.connections,
    traces,
    [],
    0.1,
    0.12,
    0.1,
  )
  expect(next[0].route[1].y - next[1].route[0].y).toBeCloseTo(0.22, 8)
  for (const [i, t] of next.entries()) {
    expect(t.route[0]).toEqual(traces[i].route[0])
    expect(t.route.at(-1)).toEqual(traces[i].route.at(-1))
    expect(
      new VectorScene(
        input,
        input.connections[i],
        0.1,
        routeCopper(next[1 - i]),
      ).pathVisible(t.route),
    ).toBe(true)
    for (let k = 1; k < t.route.length; k++) {
      const dx = Math.abs(t.route[k].x - t.route[k - 1].x),
        dy = Math.abs(t.route[k].y - t.route[k - 1].y)
      expect(Math.min(dx, dy, Math.abs(dx - dy))).toBeLessThan(1e-8)
    }
  }
  expect(traces[0].route[1].y).toBe(1)
  const blocked = tightenPairApproaches(
    input,
    input.connections,
    traces,
    [
      {
        a: { x: 4, y: 0.65 },
        b: { x: 5, y: 0.65 },
        radius: 0.15,
        layer: "bottom",
        owners: ["foreign"],
      },
    ],
    0.1,
    0.12,
    0.1,
  )
  expect(blocked[0].route).toEqual(traces[0].route)
})
