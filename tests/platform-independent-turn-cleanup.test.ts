import { expect, test } from "bun:test"
import { reduceOrdinaryTurns } from "../lib/reduce-ordinary-turns"
import { VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

test("equal-length shortcuts choose the same bend on ARM and x86", () => {
  // Board-world mm. These computed decimal endpoints reproduce an AM3352
  // control shortcut whose two diagonal placements differ by one native-hypot
  // ulp on x86 but have equal lengths on ARM.
  const start = { x: -1.5999999999999992, y: -4.799999999999999 }
  const end = { x: -1.9999999999999964, y: -31.3 }
  const connection = {
    name: "control",
    pointsToConnect: [start, end].map((point) => ({ ...point, layer: "top" })),
  }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -35, maxY: 0 },
    obstacles: [],
    connections: [connection],
  }
  const path = [start, { x: start.x, y: -10 }, { x: end.x, y: -10 }, end]
  const result = reduceOrdinaryTurns(
    path,
    new VectorScene(input, connection, 0.1, []),
  )
  expect(result).toEqual([
    start,
    { x: end.x, y: start.y - Math.abs(end.x - start.x) },
    end,
  ])
  expect(result[0]).toBe(start)
  expect(result.at(-1)).toBe(end)
})
