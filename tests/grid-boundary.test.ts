import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, fixedCopper } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

test("fractional board dimensions do not allow a route through rounded-up grid cells", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: 0, maxX: 1.05, minY: 0, maxY: 1.05 },
    obstacles: [
      {
        center: { x: 0.525, y: 0.525 },
        width: 0.1,
        height: 0.9,
        layers: ["top"],
        connectedTo: [],
      },
    ],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: 0.2, y: 0.5, layer: "top" },
          { x: 0.85, y: 0.5, layer: "top" },
        ],
      },
    ],
  }
  const scene = new VectorScene(
    input,
    input.connections[0],
    0.1,
    fixedCopper(input),
  )
  const search = new GridVisibilitySearch(
    scene,
    input.connections[0].pointsToConnect[0],
    input.connections[0].pointsToConnect[1],
  )
  // ceil(1.05 / 0.1) includes a clear row at y=1.1. The physical board edge
  // still blocks that row, and the wall covers every legal crossing.
  expect(search.cellCount).toBe(144)
  while (!search.solved && !search.failed) search.step()
  expect(search.failed).toBe(true)
  expect(search.solved).toBe(false)
  expect(search.result).toEqual([])
})
