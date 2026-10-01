import { expect, test } from "bun:test"
import { segmentsTooClose } from "../lib/geometry"
import { RouteConflictIndex } from "../lib/route-conflict-index"
import type { Point } from "../lib/types"

const firstConflict = (
  a: Point[],
  b: Point[],
  required: number,
): [number, number] | null => {
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++)
      if (segmentsTooClose([a[i - 1], a[i]], [b[j - 1], b[j]], required))
        return [i, j]
  return null
}

test("indexed immutable routes preserve first-intersection order and strict clearance", () => {
  const index = new RouteConflictIndex()
  const a = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
  ]
  const b = [
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: 3, y: 1 },
  ]
  expect(index.firstConflict(a, b, 0.1)).toEqual([1, 1])
  expect(index.firstConflict(b, a, 0.1)).toEqual([1, 1])
  const tangent = [
    { x: 0, y: 0.25 },
    { x: 2, y: 0.25 },
  ]
  const horizontal = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
  ]
  expect(index.firstConflict(horizontal, tangent, 0.25)).toBeNull()
  expect(index.firstConflict(horizontal, tangent, 0.25 + 1e-10)).toEqual([1, 1])
  expect(index.firstConflict(horizontal, tangent, 0.25)).toBeNull()
  expect(index.firstConflict([{ x: 0, y: 0 }], tangent, 1)).toBeNull()
})

test("indexed routes match nested segment tests across randomized and degenerate geometry", () => {
  const index = new RouteConflictIndex()
  let seed = 231451
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const route = () => {
    const result: Point[] = []
    for (let i = 0, count = 1 + Math.floor(random() * 8); i < count; i++)
      result.push(
        i && random() < 0.15
          ? { ...result[i - 1] }
          : {
              x: random() * 10 - 5,
              y: random() * 10 - 5,
            },
      )
    return result
  }
  for (let trial = 0; trial < 5000; trial++) {
    const a = route(),
      b = route(),
      required = random() * 0.5
    const expected = firstConflict(a, b, required)
    expect(index.firstConflict(a, b, required)).toEqual(expected)
    expect(index.firstConflict(a, b, required)).toEqual(expected)
    expect(index.firstConflict(b, a, required)).toEqual(
      firstConflict(b, a, required),
    )
  }
})
