import { expect, test } from "bun:test"
import {
  clearanceToCopper,
  copperTooClosePrepared,
  fixedCopper,
  prepareCopper,
  type Copper,
} from "../lib/vector-scene"
import type { Point } from "../lib/types"
import { loadG350Am3352Sample } from "../scripts/g350-am3352-sample"

type Rectangle = NonNullable<Copper["rect"]>

function compare(copper: Copper, a: Point, b: Point = a) {
  const expectedDistance = clearanceToCopper(a, b, copper)
  const delta = Math.max(Number.MIN_VALUE, Math.abs(expectedDistance) * Number.EPSILON)
  const dx = b.x - a.x, dy = b.y - a.y
  const prepared = prepareCopper(copper)
  for (const margin of [0, -0, 0.1516 - 1e-8, expectedDistance - delta,
    expectedDistance, expectedDistance + delta, NaN, Infinity, -Infinity]) {
    expect(copperTooClosePrepared(a.x, a.y, b.x, b.y, dx, dy,
      dx * dx + dy * dy, prepared, margin)).toBe(expectedDistance < margin)
  }
}

function rectangle(rect: Rectangle): Copper {
  return { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, radius: 0.37,
    layer: "top", owners: [], rect }
}

function sample(rect: Rectangle) {
  const xs = [rect.minX - 0.1516, rect.minX, (rect.minX + rect.maxX) / 2,
    rect.maxX, rect.maxX + 0.1516]
  const ys = [rect.minY - 0.1516, rect.minY, (rect.minY + rect.maxY) / 2,
    rect.maxY, rect.maxY + 0.1516]
  for (const x of xs) for (const y of ys) compare(rectangle(rect), { x, y })
}

test("point rectangle raster clearance retains exact contact and strict threshold decisions", () => {
  let seed = 0x3352
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  for (let trial = 0; trial < 48; trial++) {
    const minX = random() * 40 - 20, minY = random() * 40 - 20
    sample({ minX, minY, maxX: minX + random() * 5,
      maxY: minY + random() * 5 })
  }
  for (const rect of [
    { minX: -0, maxX: 0, minY: -0, maxY: 0 },
    { minX: 1, maxX: 1, minY: -2, maxY: 3 },
    { minX: -2, maxX: 3, minY: 1, maxY: 1 },
    { minX: -1e-308, maxX: 1e-308, minY: -1e-308, maxY: 1e-308 },
    { minX: -Number.MAX_VALUE, maxX: Number.MAX_VALUE, minY: 0, maxY: 1 },
  ]) sample(rect)
  const overflow = rectangle({ minX: -Number.MAX_VALUE,
    maxX: Number.MAX_VALUE, minY: 0, maxY: 1 })
  expect(clearanceToCopper({ x: 0, y: 2 }, { x: 0, y: 2 }, overflow)).toBeNaN()
  compare(overflow, { x: 0, y: 2 })
})

test("all native G350 top rectangle fields retain raster decisions at pad sides and corners", () => {
  const input = loadG350Am3352Sample()
  const rectangles = fixedCopper(input).filter((c) => c.layer === "top" && c.rect)
  expect(rectangles).toHaveLength(168)
  for (const copper of rectangles) {
    const r = copper.rect!
    for (const x of [r.minX - 0.1516, r.minX, (r.minX + r.maxX) / 2,
      r.maxX, r.maxX + 0.1516])
      for (const y of [r.minY - 0.1516, r.minY, (r.minY + r.maxY) / 2,
        r.maxY, r.maxY + 0.1516]) compare(copper, { x, y })
  }
})

test("malformed and nonfinite rectangles and nonpoint queries retain the original fallback", () => {
  for (const r of [
    { minX: 2, maxX: -2, minY: -1, maxY: 1 },
    { minX: -2, maxX: 2, minY: 1, maxY: -1 },
    { minX: NaN, maxX: 2, minY: -1, maxY: 1 },
    { minX: -Infinity, maxX: Infinity, minY: -1, maxY: 1 },
    { minX: -2, maxX: 2, minY: -Infinity, maxY: Infinity },
    { minX: -2, maxX: 2, minY: -1, maxY: 1 },
  ]) {
    const c = rectangle(r)
    for (const p of [{ x: 0, y: 0 }, { x: -0, y: 0 }, { x: 3, y: 2 },
      { x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: -Infinity }]) compare(c, p)
    for (const [a, b] of [
      [{ x: -3, y: 0 }, { x: 3, y: 0 }],
      [{ x: -3, y: -2 }, { x: 3, y: 2 }],
      [{ x: 0, y: 2 }, { x: 0, y: 3 }],
    ]) compare(c, a, b)
  }
})
