import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import {
  clearanceToCopper,
  VectorScene,
  type Copper,
} from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

test("row rasterization matches exhaustive clearance for every fine-grid cell", () => {
  const input: SimpleRouteJson = {
    bounds: { minX: -1.013, maxX: 1.027, minY: -1.017, maxY: 1.023 },
    layerCount: 1,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.08,
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -0.9, y: -0.9, layer: "top" },
          { x: 0.9, y: 0.9, layer: "top" },
        ],
      },
    ],
  }
  let seed = 921
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const copper: Copper[] = Array.from({ length: 12 }, (_, i) => {
    const a = { x: random() * 2 - 1, y: random() * 2 - 1 }
    const b = { x: random() * 2 - 1, y: random() * 2 - 1 }
    if (i % 4 === 0) b.x = a.x
    if (i % 4 === 1) b.y = a.y
    if (i % 4 === 2) Object.assign(b, a)
    return {
      a,
      b,
      radius: 0.02 + random() * 0.07,
      owners: [],
      layer: "top",
      ...(i % 4 === 3
        ? { rect: { minX: a.x, maxX: a.x + 0.12, minY: a.y, maxY: a.y + 0.17 } }
        : {}),
    }
  })
  for (const step of [0.01, 0.037, 0.11]) {
    const c = input.connections[0]
    const scene = new VectorScene(input, c, input.minTraceWidth, copper)
    const search = new GridVisibilitySearch(
      scene,
      c.pointsToConnect[0],
      c.pointsToConnect[1],
      [],
      0,
      undefined,
      { step },
    )
    const grid = search as any
    try {
      for (let y = 0; y < grid.ny; y++)
        for (let x = 0; x < grid.nx; x++) {
          const p = { x: grid.xs[x], y: grid.ys[y] }
          const blocked = copper.some(
            (c) => clearanceToCopper(p, p, c) < scene.margin - 1e-8,
          )
          expect(Boolean(grid.blocked[x + y * grid.nx])).toBe(blocked)
        }
    } finally {
      search.cancel()
    }
  }
})
