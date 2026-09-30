import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene } from "../lib/vector-scene"

test("legal exact-clearance channels remain routable after translation", () => {
  for (const y of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
    const connection = {
      name: "D",
      pointsToConnect: [
        { x: -0.8, y, layer: "top" },
        { x: 0.8, y, layer: "top" },
      ],
    }
    const input = {
      layerCount: 2,
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.1,
      bounds: { minX: -1, maxX: 1, minY: y - 0.2, maxY: y + 0.2 },
      obstacles: [],
      connections: [connection],
    }
    const scene = new VectorScene(
      input,
      connection,
      0.1,
      [-1, 1].map((sign) => ({
        a: { x: -1, y: y + sign * 0.2 },
        b: { x: 1, y: y + sign * 0.2 },
        radius: 0.05,
        layer: "top",
        owners: ["OTHER"],
      })),
    )
    expect(scene.pathVisible(connection.pointsToConnect)).toBe(true)
    const search = new GridVisibilitySearch(
      scene,
      connection.pointsToConnect[0],
      connection.pointsToConnect[1],
    )
    while (!search.solved && !search.failed) search.step()
    expect(search.solved).toBe(true)
    expect(scene.pathVisible(search.result)).toBe(true)
  }
})
