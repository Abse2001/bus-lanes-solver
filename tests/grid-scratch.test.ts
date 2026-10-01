import { expect, test } from "bun:test"
import { acquireGridScratch } from "../lib/grid-scratch"
import { GridHeap } from "../lib/grid-heap"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, type Copper } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

function input(): SimpleRouteJson {
  return {
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

function search(source: SimpleRouteJson, maxLength = Infinity) {
  const connection = source.connections[0]
  const scene = new VectorScene(source, connection, 0.1, copper)
  return new GridVisibilitySearch(
    scene,
    connection.pointsToConnect[0],
    connection.pointsToConnect[1],
    [],
    4,
    undefined,
    { maxLength },
  )
}

function solve(search: GridVisibilitySearch) {
  while (!search.solved && !search.failed) search.step()
  return search.result
}

test("heap clear removes live positions and resets stable ordering after partial consumption", () => {
  const heap = new GridHeap(20)
  for (const id of [5, 3, 8, 1]) heap.push(id, 0, 2)
  heap.pop()
  expect(heap.id).toBe(5)
  const bytes = heap.storageBytes
  heap.clear()
  expect(heap.length).toBe(0)
  expect(heap.storageBytes).toBe(bytes)
  for (const id of [1, 8, 3, 5]) heap.push(id, 0, 2)
  for (const id of [1, 8, 3, 5]) {
    heap.pop()
    expect(heap.id).toBe(id)
  }
  heap.clear()
  heap.clear()
  heap.push(3, 1, 2)
  expect(heap.length).toBe(1)
  heap.pop()
  expect([heap.id, heap.g]).toEqual([3, 1])
})

test("scratch leases isolate active searches and obsolete releases cannot clear new owners", () => {
  const source = input()
  const first = acquireGridScratch(source, 50, true)
  const concurrent = acquireGridScratch(source, 50, true)
  expect(first.scratch).not.toBe(concurrent.scratch)
  first.scratch.best[2] = 3
  first.scratch.heap.push(2, 3, 4)
  first.release()
  const next = acquireGridScratch(source, 50, true)
  expect(next.scratch).toBe(first.scratch)
  expect(next.scratch.best[2]).toBe(Infinity)
  next.scratch.heap.push(7, 2, 2)
  first.release()
  expect(next.scratch.heap.length).toBe(1)
  next.scratch.heap.pop()
  expect([next.scratch.heap.id, next.scratch.heap.g]).toEqual([7, 2])
  const otherRequest = acquireGridScratch(input(), 50, true)
  expect(otherRequest.scratch).not.toBe(next.scratch)
  next.release()
  concurrent.release()
  otherRequest.release()
})

test("inactive scratch storage is bounded and evicts the oldest buffers", () => {
  const source = input()
  // Each set owns slightly over 12 MB; six exceed the 64 MiB request limit.
  const leases = Array.from({ length: 6 }, () =>
    acquireGridScratch(source, 500000, true),
  )
  for (const lease of leases) lease.release()
  const borrowed = Array.from({ length: 6 }, () =>
    acquireGridScratch(source, 500000, true),
  )
  expect(borrowed.some((lease) => lease.scratch === leases[0].scratch)).toBe(
    false,
  )
  for (const original of leases.slice(1))
    expect(borrowed.some((lease) => lease.scratch === original.scratch)).toBe(
      true,
    )
  for (const lease of borrowed) lease.release()
})

test("reused and concurrent search paths match fresh searches across roots and length limits", () => {
  const source = input()
  const first = search(source, 8)
  const concurrent = search(source)
  while (
    (!first.solved && !first.failed) ||
    (!concurrent.solved && !concurrent.failed)
  ) {
    if (!first.solved && !first.failed) first.step()
    if (!concurrent.solved && !concurrent.failed) concurrent.step()
  }
  expect(first.solved).toBe(true)
  expect(concurrent.solved).toBe(true)
  expect(first.result).toEqual(solve(search(structuredClone(source), 8)))
  expect(concurrent.result).toEqual(solve(search(structuredClone(source))))
  for (const limit of [4, 8, Infinity, 7, Infinity]) {
    source.connections[0].pointsToConnect.reverse()
    const reused = search(source, limit)
    const fresh = search(structuredClone(source), limit)
    expect(solve(reused)).toEqual(solve(fresh))
    expect(reused.solved).toBe(fresh.solved)
    expect(reused.failed).toBe(fresh.failed)
  }
})

test("canceling or stepping an old search leaves a newly borrowed search unchanged", () => {
  const source = input()
  const abandoned = search(source, 8)
  abandoned.cancel()
  const next = search(source, 8)
  abandoned.cancel()
  abandoned.step()
  expect(next.solved).toBe(false)
  expect(solve(next)).toEqual(solve(search(structuredClone(source), 8)))
  expect(next.solved).toBe(true)
  // Completed searches still expose their independent route geometry.
  const saved = structuredClone(next.result)
  const last = search(source, 8)
  next.cancel()
  next.step()
  expect(solve(last)).toEqual(saved)
  expect(next.result).toEqual(saved)
})
