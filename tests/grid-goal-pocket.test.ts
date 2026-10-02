import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, type Copper } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

function setup(open: boolean, together = false) {
  const input: SimpleRouteJson = {
    layerCount: 1,
    minTraceWidth: 0.04,
    minTraceToPadEdgeClearance: 0.01,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: together ? -0.05 : -2, y: 0, layer: "top" },
          { x: 0.05, y: 0, layer: "top" },
        ],
      },
    ],
  }
  const edges = [
    [-0.2, -0.2, 0.2, -0.2],
    [0.2, -0.2, 0.2, 0.2],
    [0.2, 0.2, -0.2, 0.2],
    ...(!open ? [[-0.2, 0.2, -0.2, -0.2]] : []),
  ]
  const copper: Copper[] = edges.map(([x1, y1, x2, y2]) => ({
    a: { x: x1, y: y1 },
    b: { x: x2, y: y2 },
    radius: 0.03,
    owners: [],
    layer: "top",
  }))
  const c = input.connections[0],
    scene = new VectorScene(input, c, 0.04, copper)
  return {
    scene,
    search: new GridVisibilitySearch(
      scene,
      c.pointsToConnect[0],
      c.pointsToConnect[1],
      [],
      0,
      undefined,
      { step: 0.01 },
    ),
  }
}

test("a sealed goal pocket fails before A* expands the surrounding open board", () => {
  const { search } = setup(false)
  expect(search.failed).toBe(true)
  expect(search.expanded).toBe(0)
})

for (const together of [false, true])
  test(`goal component preflight preserves ${together ? "two endpoints in one pocket" : "an open escape"}`, () => {
    const { search, scene } = setup(!together, together)
    expect(search.failed).toBe(false)
    while (!search.failed && !search.solved) search.step()
    expect(search.solved).toBe(true)
    expect(scene.pathVisible(search.result)).toBe(true)
  })
