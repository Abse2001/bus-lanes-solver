import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, copperTooClose, type Copper } from "../lib/vector-scene"
import type { Connection, SimpleRouteJson } from "../lib/types"

function fixture() {
  const connection: Connection = {
    name: "cache",
    pointsToConnect: [
      { x: -2.5, y: -2.5, layer: "top" },
      { x: 2.5, y: 2.5, layer: "top" },
    ],
  }
  const input: SimpleRouteJson = {
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    minTraceWidth: 0.1,
    layerCount: 1,
    obstacles: [],
    connections: [connection],
  }
  const scene = new VectorScene(input, connection, input.minTraceWidth, [])
  const search = (copper: Copper[]) =>
    new GridVisibilitySearch(
      scene,
      connection.pointsToConnect[0],
      connection.pointsToConnect[1],
      copper,
      4,
      undefined,
      { step: 0.5 },
    ) as any
  return { search, scene }
}

function checkAndPopulate(search: any, copper: Copper[], margin: number) {
  let retained = 0
  for (let y = 0; y < search.ny; y++)
    for (let x = 0; x < search.nx; x++) {
      const id = x + y * search.nx
      const a = { x: search.xs[x], y: search.ys[y] }
      for (const neighbor of search.neighbors) {
        const xx = x + neighbor.dx,
          yy = y + neighbor.dy
        if (xx < 0 || xx >= search.nx || yy < 0 || yy >= search.ny) continue
        const b = { x: search.xs[xx], y: search.ys[yy] }
        const blocked = copper.some((c) =>
          copperTooClose(a, b, c, margin - 1e-8),
        )
        if (search.softEdgeKnown[id] & neighbor.bit) {
          retained++
          expect(Boolean(search.softEdgeBlocked[id] & neighbor.bit)).toBe(
            blocked,
          )
        }
        expect(search.edgeClear(a.x, a.y, b.x, b.y, search.softBuckets)).toBe(
          !blocked,
        )
        search.softEdgeKnown[id] |= neighbor.bit
        if (blocked) search.softEdgeBlocked[id] |= neighbor.bit
        else search.softEdgeBlocked[id] &= ~neighbor.bit
      }
    }
  return retained
}
function finish(search: GridVisibilitySearch) {
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
}

test("changed soft copper invalidates both directions while preserving unaffected edges", () => {
  const { search, scene } = fixture()
  let seed = 1221
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const create = (i: number): Copper => {
    const a = { x: random() * 4 - 2, y: random() * 4 - 2 },
      b = i % 3 ? { x: random() * 4 - 2, y: random() * 4 - 2 } : a
    return {
      a,
      b,
      radius: random() * 0.15,
      owners: [],
      layer: "top",
      ...(i % 7 === 0
        ? {
            rect: {
              minX: a.x - 0.2,
              maxX: a.x + 0.2,
              minY: a.y - 0.2,
              maxY: a.y + 0.2,
            },
          }
        : {}),
    }
  }
  let copper = Array.from({ length: 15 }, (_, i) => create(i))
  let current = search(copper)
  checkAndPopulate(current, copper, scene.margin)
  finish(current)
  let retained = 0
  for (let i = 0; i < 30; i++) {
    // Removal, insertion, changed radius, reordering and duplicate geometry.
    copper = copper.slice(1).toReversed()
    copper.push(create(i))
    if (i % 3 === 0) copper[0] = { ...copper[0], radius: random() * 0.2 }
    if (i % 5 === 0) copper[1] = structuredClone(copper[0])
    const next = search(copper)
    expect(next.softEdgeKnown).toBe(current.softEdgeKnown)
    retained += checkAndPopulate(next, copper, scene.margin)
    finish(next)
    current = next
  }
  expect(retained).toBeGreaterThan(1000)
})

test("overlapping searches own separate soft visibility arrays", () => {
  const { search, scene } = fixture()
  const copper: Copper = {
    a: { x: -1, y: 0 },
    b: { x: 1, y: 0 },
    radius: 0.1,
    owners: [],
    layer: "top",
  }
  const first = search([copper])
  checkAndPopulate(first, [copper], scene.margin)
  const before = first.softEdgeKnown.slice()
  const second = search([])
  expect(second.softEdgeKnown).not.toBe(first.softEdgeKnown)
  expect(first.softEdgeKnown).toEqual(before)
  checkAndPopulate(second, [], scene.margin)
  finish(first)
  finish(second)
  const third = search([copper])
  expect(third.softEdgeKnown).toBe(first.softEdgeKnown)
  checkAndPopulate(third, [copper], scene.margin)
  finish(third)
})

test("oversized soft copper leaves cached answers private from concurrent and later searches", () => {
  const { search, scene } = fixture()
  const original: Copper = {
    a: { x: -1, y: -1 },
    b: { x: -1, y: 1 },
    radius: 0.1,
    owners: [],
    layer: "top",
  }
  const replacement: Copper = {
    ...original,
    a: { x: 1, y: -1 },
    b: { x: 1, y: 1 },
  }
  const cached = search([original])
  checkAndPopulate(cached, [original], scene.margin)
  cached.cancel()
  // Off-board, distinct point entries exceed the 16 MiB metadata budget
  // without requiring a large grid or affecting any tested edge clearance.
  const noise: Copper[] = Array.from({ length: 100000 }, (_, i) => ({
    a: { x: 20 + i / 1000, y: 20 },
    b: { x: 20 + i / 1000, y: 20 },
    radius: 0,
    owners: [],
    layer: "top",
  }))
  const oversized = search([replacement, ...noise])
  expect(oversized.softMemoLease).toBeUndefined()
  expect(oversized.softEdgeKnown).not.toBe(cached.softEdgeKnown)
  expect(oversized.softEdgeBlocked).not.toBe(cached.softEdgeBlocked)
  checkAndPopulate(oversized, [replacement], scene.margin)
  const concurrent = search([original])
  expect(concurrent.softEdgeKnown).toBe(cached.softEdgeKnown)
  expect(concurrent.softEdgeKnown).not.toBe(oversized.softEdgeKnown)
  expect(
    checkAndPopulate(concurrent, [original], scene.margin),
  ).toBeGreaterThan(0)
  oversized.cancel()
  expect(concurrent.softMemoLease.active).toBe(true)
  concurrent.cancel()
  const later = search([original])
  expect(later.softEdgeKnown).toBe(cached.softEdgeKnown)
  expect(checkAndPopulate(later, [original], scene.margin)).toBeGreaterThan(0)
  finish(later)
})

test("canceled searches release their memo and cannot mutate its next owner", () => {
  const { search, scene } = fixture()
  const copper: Copper = {
    a: { x: -1, y: 0 },
    b: { x: 1, y: 0 },
    radius: 0.1,
    owners: [],
    layer: "top",
  }
  const first = search([copper])
  checkAndPopulate(first, [copper], scene.margin)
  first.cancel()
  expect(first.failed).toBe(true)
  const second = search([])
  expect(second.softEdgeKnown.length).toBe(0)
  checkAndPopulate(second, [], scene.margin)
  const before = second.softEdgeBlocked.slice()
  const expanded = first.expanded
  first.step()
  expect(first.expanded).toBe(expanded)
  expect(second.softEdgeBlocked).toEqual(before)
  finish(second)
  const result = structuredClone(second.result)
  second.cancel()
  expect(second.solved).toBe(true)
  expect(second.failed).toBe(false)
  expect(second.result).toEqual(result)
})
