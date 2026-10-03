import { expect, test } from "bun:test"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { clearanceToCopper, type Copper } from "../lib/vector-scene"

const brute = (first: Copper[], second: Copper[], clearance: number) => {
  for (const a of first)
    for (const b of second)
      if (
        a.layer === b.layer &&
        clearanceToCopper(a.a, a.b, b) < a.radius + clearance
      )
        return [a, b]
}
test("copper broad phase preserves exact first-hit order across layers, vias and rectangles", () => {
  let state = 173
  const random = () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const copper = (): Copper => {
    const x = random() * 20 - 10,
      y = random() * 20 - 10,
      kind = Math.floor(random() * 3)
    return {
      a: { x, y },
      b: kind ? { x, y } : { x: random() * 20 - 10, y: random() * 20 - 10 },
      radius: kind === 2 ? 0 : random() * 0.4,
      owners: [],
      layer: random() < 0.5 ? "first" : "second",
      ...(kind === 2
        ? {
            rect: {
              minX: x - 0.4,
              maxX: x + 0.7,
              minY: y - 0.2,
              maxY: y + 0.3,
            },
          }
        : {}),
    }
  }
  const index = new CopperConflictIndex()
  for (let trial = 0; trial < 500; trial++) {
    const a = Array.from({ length: 12 }, copper),
      b = Array.from({ length: 15 }, copper)
    for (const clearance of [0.1 - 1e-8, 0.3]) {
      const expected = brute(a, b, clearance),
        actual = index.firstConflict(a, b, clearance)
      expect(actual?.[0]).toBe(expected?.[0])
      expect(actual?.[1]).toBe(expected?.[1])
    }
  }
})
test("copper broad phase keeps exact near-tangent clearance decisions", () => {
  const index = new CopperConflictIndex()
  const first: Copper[] = [
    {
      a: { x: 0, y: 0 },
      b: { x: 2, y: 0 },
      radius: 0.05,
      layer: "a",
      owners: [],
    },
  ]
  for (const offset of [-1e-9, 0, 1e-9]) {
    const second: Copper[] = [
      {
        a: { x: 0, y: 0.2 + offset },
        b: { x: 2, y: 0.2 + offset },
        radius: 0.05,
        layer: "a",
        owners: [],
      },
    ]
    expect(index.firstConflict(first, second, 0.1)?.[0]).toBe(
      brute(first, second, 0.1)?.[0],
    )
  }
  expect(index.firstConflict([], first, 0.1)).toBeUndefined()
})
