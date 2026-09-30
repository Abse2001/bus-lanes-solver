import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, fixedCopper } from "../lib/vector-scene"
import { length } from "../lib/geometry"
import type { SimpleRouteJson } from "../lib/types"

test("legal parallel BGA lanes are not penalized as collisions", () => {
  const connection = {
    name: "D",
    pointsToConnect: [
      { x: 0, y: 0, layer: "top" },
      { x: 4, y: 0, layer: "top" },
    ],
  }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, maxX: 5, minY: -2, maxY: 2 },
    connections: [connection],
    obstacles: [
      {
        type: "rect",
        shape: "circle",
        componentId: "U1",
        center: { x: 2, y: -1 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["other-pad"],
      },
    ],
  }
  const scene = new VectorScene(input, connection, 0.1, fixedCopper(input))
  const search = new GridVisibilitySearch(
    scene,
    ...(connection.pointsToConnect as [
      (typeof connection.pointsToConnect)[0],
      (typeof connection.pointsToConnect)[0],
    ]),
    [
      {
        a: { x: 0, y: 0.2 },
        b: { x: 4, y: 0.2 },
        radius: 0.05,
        layer: "top",
        owners: ["neighbor"],
      },
    ],
    100,
  )
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
  expect(length(search.result)).toBeCloseTo(4, 10)
})
