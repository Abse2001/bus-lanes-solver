import { expect, test } from "bun:test"
import { BoardBoundary } from "../lib/board-boundary"
import { gridBoardBoundaryMask } from "../lib/grid-board-boundary"
import type { Point, SimpleRouteJson } from "../lib/types"

const shapes: Point[][] = [
  [
    { x: -2, y: -2 },
    { x: 2, y: -2 },
    { x: 2, y: 2 },
    { x: -2, y: 2 },
  ],
  [
    { x: -2, y: -2 },
    { x: 2, y: -1.5 },
    { x: 1.5, y: 2 },
    { x: -1.5, y: 1.5 },
  ],
  [
    { x: -2, y: -2 },
    { x: 2, y: -2 },
    { x: 2, y: 2 },
    { x: 0.5, y: 2 },
    { x: 0, y: -0.5 },
    { x: -0.5, y: 2 },
    { x: -2, y: 2 },
  ],
]

function input(outline?: Point[]): SimpleRouteJson {
  return {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    outline,
    connections: [],
    obstacles: [],
  }
}

test("scanline boundary occupancy agrees with exact continuous containment", () => {
  const xs = Float64Array.from({ length: 91 }, (_, i) => -2.25 + i * 0.05),
    ys = Float64Array.from({ length: 89 }, (_, i) => -2.17 + i * 0.05)
  for (const outline of [
    undefined,
    ...shapes,
    ...shapes.map((s) => [...s].reverse()),
  ])
    for (const radius of [0, 0.025, 0.1, 0.3])
      for (const clearance of [0, 0.125]) {
        const boundary = new BoardBoundary({
          ...input(outline),
          minBoardEdgeClearance: clearance,
        })
        const mask = gridBoardBoundaryMask(boundary, xs, ys, radius)
        for (let y = 0; y < ys.length; y++)
          for (let x = 0; x < xs.length; x++) {
            const p = { x: xs[x], y: ys[y] }
            expect(mask[x + y * xs.length]).toBe(
              boundary.containsSegment(p, p, radius) ? 0 : 1,
            )
          }
      }
})

test("boundary masks retain independent copies and invalidate changed geometry", () => {
  const xs = Float64Array.from({ length: 41 }, (_, i) => -2 + i * 0.1),
    ys = xs.slice(),
    native = input(structuredClone(shapes[0])),
    first = new BoardBoundary(native),
    original = gridBoardBoundaryMask(first, xs, ys, 0.05),
    expected = original.slice()
  original.fill(1)
  expect(
    gridBoardBoundaryMask(new BoardBoundary({ ...native }), xs, ys, 0.05),
  ).toEqual(expected)
  native.outline![1].x = 1
  const updated = gridBoardBoundaryMask(new BoardBoundary(native), xs, ys, 0.05)
  expect(updated).not.toEqual(expected)
  native.minBoardEdgeClearance = 0.4
  expect(
    gridBoardBoundaryMask(new BoardBoundary(native), xs, ys, 0.05),
  ).not.toEqual(updated)
})
