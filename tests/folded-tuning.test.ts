import { expect, test } from "bun:test"
import { foldedPairedLobes } from "../lib/folded-tuning"
import { distance, length, segmentDistance } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import type { Point, Trace } from "../lib/types"

const trace = (route: Point[]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: "test",
  route: route.map((p) => ({
    ...p,
    route_type: "wire",
    layer: "top",
    width: 0.1,
  })),
})

test("folded cells add exact length with smooth, separated offset rails under rotation and reflection", () => {
  for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI])
    for (const side of [-1, 1])
      for (const folds of [1, 2, 3]) {
        const a = { x: 4.2, y: -7.8 },
          b = { x: a.x + 10 * Math.cos(angle), y: a.y + 10 * Math.sin(angle) }
        const rails = foldedPairedLobes(a, b, 0.22, 10, folds, side, 0.12)!
        expect(rails).not.toBeNull()
        expect(routeAnglesAreConventional(rails.map(trace))).toBe(true)
        for (const rail of rails) {
          expect(length(rail)).toBeCloseTo(20, 8)
          expect(tuningPathIsSelfClear(rail, 0.175)).toBe(true)
          for (let i = 1; i < rail.length - 1; i++) {
            const p = rail[i - 1],
              q = rail[i],
              r = rail[i + 1]
            const cross = Math.abs(
              (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x),
            )
            if (cross > 1e-12)
              expect(
                (distance(p, q) * distance(q, r) * distance(r, p)) /
                  (2 * cross),
              ).toBeGreaterThanOrEqual(0.12 - 1e-7)
          }
        }
        let gap = Infinity
        for (let i = 1; i < rails[0].length; i++)
          for (let j = 1; j < rails[1].length; j++)
            gap = Math.min(
              gap,
              segmentDistance(
                [rails[0][i - 1], rails[0][i]],
                [rails[1][j - 1], rails[1][j]],
              ),
            )
        expect(gap).toBeGreaterThan(0.219)
        for (const index of [0, rails[0].length - 1])
          expect(distance(rails[0][index], rails[1][index])).toBeCloseTo(
            0.22,
            8,
          )
      }
})

test("additional folds fit the same correction in a shorter, taller pocket", () => {
  const a = { x: 0, y: 0 },
    b = { x: 10, y: 0 }
  const wide = foldedPairedLobes(a, b, 0, 12, 1, 1, 0.12)![0]
  const folded = foldedPairedLobes(a, b, 0, 12, 3, 1, 0.12)![0]
  const raised = (p: Point[]) => p.filter((p) => p.y > 0.001)
  expect(Math.max(...raised(folded).map((p) => p.x))).toBeLessThan(2.1)
  expect(Math.max(...raised(folded).map((p) => p.y))).toBeLessThan(1.7)
  expect(Math.max(...raised(wide).map((p) => p.x))).toBeGreaterThan(5)
  expect(length(folded)).toBeCloseTo(length(wide), 8)
  expect(foldedPairedLobes(a, { x: 0.5, y: 0 }, 0, 12, 3, 1, 0.12)).toBeNull()
  expect(foldedPairedLobes(a, b, 0, 0.1, 3, 1, 0.12)).toBeNull()
})

test("the tuner uses a folded cell inside a blocked pocket without widening the route", async () => {
  const { tuneSmoothLengths } = await import("../lib/smooth-length-tuning")
  const { VectorScene, fixedCopper, routeCopper } = await import(
    "../lib/vector-scene"
  )
  const t = {
    ...trace([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    connection_name: "D",
  }
  const input: import("../lib/types").SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -1, maxX: 11, minY: -1, maxY: 5 },
    connections: [
      { name: "D", pointsToConnect: t.route as import("../lib/types").Wire[] },
    ],
    obstacles: [
      {
        center: { x: 5, y: -0.4 },
        width: 12,
        height: 0.5,
        layers: ["top"],
        connectedTo: [],
      },
      {
        center: { x: 5, y: 1.4 },
        width: 12,
        height: 1,
        layers: ["top"],
        connectedTo: [],
      },
      {
        center: { x: 7, y: 2 },
        width: 6,
        height: 3.5,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
  const before = structuredClone(input)
  const result = tuneSmoothLengths(input, [t], new Map([["D", 18]]), {
    packMeanders: true,
    maxCandidates: 4096,
  })
  expect(length(result[0].route)).toBeCloseTo(18, 8)
  expect(
    result[0].route.some(
      (p, i) => i > 0 && p.x < result[0].route[i - 1].x - 0.01,
    ),
  ).toBe(true)
  expect(Math.max(...result[0].route.map((p) => p.y))).toBeLessThan(0.775)
  expect(routeAnglesAreConventional(result)).toBe(true)
  expect(tuningPathIsSelfClear(result[0].route, 0.175)).toBe(true)
  expect(
    new VectorScene(input, input.connections[0], 0.1, [
      ...fixedCopper(input),
      ...result.flatMap(routeCopper),
    ]).pathVisible(result[0].route),
  ).toBe(true)
  expect(input).toEqual(before)
})
