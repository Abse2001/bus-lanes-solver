import { expect, test } from "bun:test"
import { alignPairTransitions } from "../lib/align-pair-transitions"
import { offsetPath } from "../lib/coupled-pair-routing"
import { distance, length, pointSegmentDistance } from "../lib/geometry"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

const fixture = (transform: (point: Point) => Point, jog = 0.07) => {
  const routes = [
    [
      [0, 8],
      [0, 5],
      [0, 4.8],
      [-jog, 4.8 - jog],
      [-jog, 0],
    ],
    [
      [0.22, 8],
      [0.22, 5],
      [0.22, 4.8],
      [0.22, 4.43],
      [0.13, 4.34],
      [0.13, 0],
    ],
  ]
  const traces: Trace[] = routes.map((route, side) => ({
    type: "pcb_trace",
    pcb_trace_id: `rail_${side}`,
    connection_name: `D${side}`,
    coupledSection: [0, 2],
    route: route.map(([x, y]) => ({
      ...transform({ x, y }),
      width: 0.1,
      layer: "bottom",
      route_type: "wire",
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    obstacles: [],
    connections: traces.map((trace) => ({
      name: trace.connection_name!,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!].map((p) => ({
        ...p,
        layer: "bottom",
      })),
    })),
  }
  return { input, traces }
}

test("staggered pair jogs align across reflections and 45-degree rotations without changing length, headings, or shared copper", () => {
  const transforms = [
    0,
    Math.PI / 4,
    Math.PI / 2,
    Math.PI,
    -Math.PI / 2,
  ].flatMap((angle) =>
    [1, -1].map((reflection) => (p: Point) => {
      const x = reflection * p.x
      return {
        x: x * Math.cos(angle) - p.y * Math.sin(angle),
        y: x * Math.sin(angle) + p.y * Math.cos(angle),
      }
    }),
  )
  for (const transform of transforms)
    for (const translate of [
      { x: 0, y: 0 },
      { x: 8, y: -3 },
    ]) {
      const { input, traces } = fixture((p) => {
        const rotated = transform(p)
        return {
          x: rotated.x + translate.x,
          y: rotated.y + translate.y,
        }
      })
      const original = JSON.stringify(traces)
      const aligned = alignPairTransitions(
        input,
        input.connections,
        traces,
        [],
        0.1,
        0.12,
        0.1,
        offsetPath,
      )
      expect(aligned[0].route).toEqual(traces[0].route)
      expect(aligned[1].route).not.toEqual(traces[1].route)
      for (let side = 0; side < 2; side++) {
        const path = aligned[side].route,
          old = traces[side].route,
          mate = aligned[1 - side].route
        expect(path).toHaveLength(old.length)
        expect(path[0]).toEqual(old[0])
        expect(path.at(-1)).toEqual(old.at(-1))
        expect(path.slice(0, traces[side].coupledSection![1] + 1)).toEqual(
          old.slice(0, traces[side].coupledSection![1] + 1),
        )
        expect(length(path)).toBeCloseTo(length(old), 10)
        expect(
          new VectorScene(
            input,
            input.connections[side],
            0.1,
            routeCopper(aligned[1 - side]),
          ).pathVisible(path),
        ).toBe(true)
        for (let i = 1; i < path.length; i++) {
          const size = distance(path[i - 1], path[i]),
            before = distance(old[i - 1], old[i])
          expect((path[i].x - path[i - 1].x) / size).toBeCloseTo(
            (old[i].x - old[i - 1].x) / before,
            8,
          )
          expect((path[i].y - path[i - 1].y) / size).toBeCloseTo(
            (old[i].y - old[i - 1].y) / before,
            8,
          )
          const steps = Math.ceil(size / 0.01)
          for (let k = 0; k <= steps; k++) {
            const p = {
              x: path[i - 1].x + ((path[i].x - path[i - 1].x) * k) / steps,
              y: path[i - 1].y + ((path[i].y - path[i - 1].y) * k) / steps,
            }
            const gap =
              Math.min(
                ...mate
                  .slice(1)
                  .map((q, j) => pointSegmentDistance(p, [mate[j], q])),
              ) - 0.1
            expect(gap).toBeGreaterThanOrEqual(0.0999)
            expect(gap).toBeLessThanOrEqual(0.139)
          }
        }
      }
      expect(JSON.stringify(traces)).toBe(original)
    }
})

test("alignment leaves a clearance-blocked staggered transition unchanged", () => {
  const { input, traces } = fixture((p) => p, 0.3)
  input.obstacles.push({
    type: "smtpad",
    shape: "circle",
    center: { x: 0.02, y: 4.52 },
    width: 0.1,
    height: 0.1,
    layers: ["bottom"],
    connectedTo: ["obstacle"],
  })
  const fixed = fixedCopper(input)
  for (let side = 0; side < 2; side++)
    expect(
      new VectorScene(input, input.connections[side], 0.1, [
        ...fixed,
        ...routeCopper(traces[1 - side]),
      ]).pathVisible(traces[side].route),
    ).toBe(true)
  const aligned = alignPairTransitions(
    input,
    input.connections,
    traces,
    fixed,
    0.1,
    0.12,
    0.1,
    offsetPath,
  )
  expect(aligned).toEqual(traces)
})

test("alignment cannot slide a bend across the immutable shared endpoint", () => {
  const { input, traces } = fixture((p) => p)
  traces[1].route[2] = { ...traces[1].route[2], y: 4.6 }
  const original = JSON.stringify(traces)
  const aligned = alignPairTransitions(
    input,
    input.connections,
    traces,
    [],
    0.1,
    0.12,
    0.1,
    offsetPath,
  )
  expect(aligned).toEqual(traces)
  expect(JSON.stringify(traces)).toBe(original)
})
