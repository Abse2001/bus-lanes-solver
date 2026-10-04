import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, fixedCopper } from "../lib/vector-scene"
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

test("length-constrained search retains a costly short prefix when a cheaper detour cannot finish", () => {
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
    defaultObstacleMargin: 0.05,
    bounds: { minX: -0.5, maxX: 10.5, minY: -3.5, maxY: 3.5 },
    connections: [connection],
    obstacles: [-1, 1].map((y) => ({
      center: { x: 8, y },
      width: 0.6,
      height: 2,
      layers: ["top"],
      connectedTo: [],
    })),
  }
  const soft = [
    [7.5, 4.25],
    [2.25, 2.5],
    [7.5, 1.5],
  ].map(([a, b], i) => ({
    a: { x: a, y: -3 },
    b: { x: b, y: 3 },
    radius: 0.05,
    layer: "top",
    owners: [`other${i}`],
  }))
  const scene = new VectorScene(input, connection, 0.1, fixedCopper(input))
  const search = new GridVisibilitySearch(
    scene,
    ...(connection.pointsToConnect as [
      (typeof connection.pointsToConnect)[0],
      (typeof connection.pointsToConnect)[0],
    ]),
    soft,
    8,
    undefined,
    { step: 0.25, maxLength: 12.2, paretoLength: true },
  )
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
  expect(length(search.result)).toBeLessThanOrEqual(12.2 + 1e-8)
  expect(scene.pathVisible(search.result)).toBe(true)
  expect(search.result[0]).toEqual(connection.pointsToConnect[0])
  expect(search.result.at(-1)).toEqual(connection.pointsToConnect[1])
})
