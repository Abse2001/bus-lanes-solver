import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene } from "../lib/vector-scene"
import { length } from "../lib/geometry"

test("bounded grid search rejects an impossible length budget and preserves feasible endpoints", () => {
  const connection = {
    name: "D",
    pointsToConnect: [
      { x: 0, y: 0, layer: "top" },
      { x: 10, y: 0, layer: "top" },
    ],
  }
  const input = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 11, minY: -2, maxY: 2 },
    obstacles: [],
    connections: [connection],
  }
  const scene = new VectorScene(input, connection, 0.1, [])
  for (const limit of [9, 10]) {
    const search = new GridVisibilitySearch(
      scene,
      connection.pointsToConnect[0],
      connection.pointsToConnect[1],
      [],
      0,
      undefined,
      { maxLength: limit },
    )
    while (!search.solved && !search.failed) search.step()
    expect(search.solved).toBe(limit === 10)
    if (search.solved) {
      expect(length(search.result)).toBeLessThanOrEqual(limit + 1e-8)
      expect(search.result[0]).toEqual(connection.pointsToConnect[0])
      expect(search.result.at(-1)).toEqual(connection.pointsToConnect[1])
    }
  }
})
