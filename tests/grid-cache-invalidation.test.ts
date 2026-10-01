import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, type Copper } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

test("reused grid geometry matches fresh searches after copper and clearance changes", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -2, y: 0, layer: "top" },
          { x: 2, y: 0, layer: "top" },
        ],
      },
    ],
  }
  const copper: Copper[] = [
    {
      a: { x: 0, y: -1 },
      b: { x: 0, y: 1 },
      radius: 0.2,
      layer: "top",
      owners: ["OTHER"],
    },
  ]
  const solve = (source: SimpleRouteJson) => {
    const c = source.connections[0]
    const scene = new VectorScene(source, c, source.minTraceWidth, copper)
    const search = new GridVisibilitySearch(
      scene,
      c.pointsToConnect[0],
      c.pointsToConnect[1],
    )
    while (!search.solved && !search.failed) search.step()
    expect(search.solved).toBe(true)
    expect(scene.pathVisible(search.result)).toBe(true)
    return search.result
  }
  const original = solve(input)
  expect(solve(input)).toEqual(original)
  for (let i = 0; i < 12; i++) {
    copper[0].a.y = -1.2 + i * 0.03
    copper[0].b.y = 0.8 + i * 0.04
    input.minTraceToPadEdgeClearance = i % 2 ? 0.1 : 0.15
    input.connections[0].pointsToConnect.reverse()
    expect(solve(input)).toEqual(solve(structuredClone(input)))
  }
})
