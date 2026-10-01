import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, copperTooClose, type Copper } from "../lib/vector-scene"
import type { Connection, SimpleRouteJson } from "../lib/types"

const connection: Connection = {
  name: "empty-soft",
  pointsToConnect: [
    { x: -2.5, y: -2.5, layer: "top" },
    { x: 2.5, y: 1.5, layer: "top" },
  ],
}
function scene(clearance: number) {
  const input: SimpleRouteJson = {
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: clearance,
    layerCount: 2,
    obstacles: [],
    connections: [connection],
  }
  return new VectorScene(input, connection, input.minTraceWidth, [])
}
function finish(search: GridVisibilitySearch) {
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
}

test("empty layer-filtered soft copper preserves memoized zero-cost search decisions", () => {
  const ignored: Copper[] = [
    {
      a: { x: 0, y: 0 },
      b: { x: 0, y: 0 },
      radius: 0,
      layer: "bottom",
      owners: [],
      rect: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    },
  ]
  for (const clearance of [-0.15, -0.05, 0.075])
    for (const penalty of [-10, 0, 10, Number.NaN])
      for (const soft of [[], ignored]) {
        const s = scene(clearance)
        const history = Float32Array.from({ length: 61 * 61 }, (_, i) =>
          i % 7 === 0 ? 0.25 : 0,
        )
        const fast = new GridVisibilitySearch(
          s,
          connection.pointsToConnect[0],
          connection.pointsToConnect[1],
          soft,
          penalty,
          history,
          { maxLength: 12 },
        ) as any
        const reference = new GridVisibilitySearch(
          s,
          connection.pointsToConnect[0],
          connection.pointsToConnect[1],
          soft,
          penalty,
          history,
          { maxLength: 12 },
        ) as any
        // Enable the original per-edge memo bookkeeping: every empty-scene
        // predicate is clear, so it can only contribute the same zero cost.
        reference.hasSoftCopper = true
        reference.softEdgeKnown = new Uint8Array(reference.cellCount)
        reference.softEdgeBlocked = new Uint8Array(reference.cellCount)
        expect(fast.hasSoftCopper).toBe(false)
        expect(fast.softBuckets).toBeUndefined()
        expect(fast.softMemoLease).toBeUndefined()
        expect(fast.softEdgeKnown.length).toBe(0)
        expect(fast.softEdgeBlocked.length).toBe(0)
        finish(fast)
        finish(reference)
        expect(fast.result).toEqual(reference.result)
        expect(fast.expanded).toBe(reference.expanded)
      }
})

test("a same-layer degenerate rectangle still receives exact clearance checks", () => {
  const s = scene(0.075)
  const soft: Copper = {
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
    radius: 0,
    layer: "top",
    owners: [],
    rect: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  }
  const search = new GridVisibilitySearch(
    s,
    connection.pointsToConnect[0],
    connection.pointsToConnect[1],
    [soft],
  ) as any
  expect(search.hasSoftCopper).toBe(true)
  expect(search.softEdgeKnown.length).toBe(search.cellCount)
  const a = { x: -0.1, y: 0 },
    b = { x: 0.1, y: 0 }
  expect(search.edgeClear(a.x, a.y, b.x, b.y, search.softBuckets)).toBe(
    !copperTooClose(a, b, soft, s.margin - 1e-8),
  )
  search.cancel()
})
