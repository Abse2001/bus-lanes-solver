import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, copperTooClose, type Copper } from "../lib/vector-scene"
import type { Connection, SimpleRouteJson } from "../lib/types"

for (const size of [10, 300]) {
  test(`${size > 10 ? "sparse" : "dense"} grid copper queries preserve exhaustive continuous clearance`, () => {
    let seed = 1234
    const random = () =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
    const copper: Copper[] = Array.from({ length: 80 }, (_, i) => {
      const a = { x: random() * 8 - 4, y: random() * 8 - 4 }
      const b = i % 2 ? a : { x: random() * 8 - 4, y: random() * 8 - 4 }
      return {
        a,
        b,
        radius: 0.05 + random() * 0.15,
        layer: "top",
        owners: [],
        ...(i % 5 === 0
          ? {
              rect: {
                minX: a.x - 0.15,
                maxX: a.x + 0.15,
                minY: a.y - 0.15,
                maxY: a.y + 0.15,
              },
            }
          : {}),
      }
    })
    const connection: Connection = {
      name: "query",
      pointsToConnect: [
        { x: -4.9, y: -4.9, layer: "top" },
        { x: 4.9, y: 4.9, layer: "top" },
      ],
    }
    const input: SimpleRouteJson = {
      bounds: {
        minX: -size / 2,
        maxX: size / 2,
        minY: -size / 2,
        maxY: size / 2,
      },
      minTraceWidth: 0.1,
      layerCount: 1,
      obstacles: [],
      connections: [connection],
    }
    const scene = new VectorScene(
      input,
      connection,
      input.minTraceWidth,
      copper,
    )
    const search = new GridVisibilitySearch(
      scene,
      connection.pointsToConnect[0],
      connection.pointsToConnect[1],
      copper,
      4,
      undefined,
      { step: size > 10 ? 3 : 0.1 },
    ) as any
    for (let i = 0; i < 3000; i++) {
      const a = { x: random() * 10 - 5, y: random() * 10 - 5 }
      const b = {
        x: a.x + (random() - 0.5) * 0.2,
        y: a.y + (random() - 0.5) * 0.2,
      }
      const expected = !copper.some((c) =>
        copperTooClose(a, b, c, scene.margin - 1e-8),
      )
      expect(search.edgeClear(a.x, a.y, b.x, b.y, search.copperBuckets)).toBe(
        expected,
      )
      expect(search.edgeClear(a.x, a.y, b.x, b.y, search.softBuckets)).toBe(
        expected,
      )
    }
  })
}
