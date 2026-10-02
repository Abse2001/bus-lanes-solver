import { expect, test } from "bun:test"
import { CopperIndex } from "../lib/copper-index"
import { clearanceToCopper, type Copper } from "../lib/vector-scene"

test("spatial clearance queries agree with exhaustive copper checks", () => {
  let seed = 19
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const copper: Copper[] = Array.from({ length: 200 }, (_, i) => {
    const x = random() * 30 - 15,
      y = random() * 30 - 15
    return {
      a: { x, y },
      b: { x: x + random() * 4, y: y + random() * 4 },
      radius: 0.1,
      layer: "top",
      owners: [String(i)],
      ...(i % 3 === 0
        ? { rect: { minX: x, maxX: x + 0.5, minY: y, maxY: y + 1 } }
        : {}),
    }
  })
  const index = new CopperIndex(copper)
  for (let i = 0; i < 3000; i++) {
    const a = { x: random() * 40 - 20, y: random() * 40 - 20 }
    const b = i % 2 ? a : { x: random() * 40 - 20, y: random() * 40 - 20 }
    const margin = 0.075
    const predicate = (c: Copper) => clearanceToCopper(a, b, c) < margin - 1e-8
    expect(
      index.some(
        {
          minX: Math.min(a.x, b.x) - margin,
          maxX: Math.max(a.x, b.x) + margin,
          minY: Math.min(a.y, b.y) - margin,
          maxY: Math.max(a.y, b.y) + margin,
        },
        predicate,
      ),
    ).toBe(copper.some(predicate))
  }
})

test("nearest copper distances equal exhaustive checks, including overlaps and unequal widths", () => {
  let seed = 37
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const copper: Copper[] = Array.from({ length: 300 }, (_, i) => {
    const a = { x: random() * 20 - 10, y: random() * 20 - 10 }
    return {
      a,
      b: i % 4 ? { x: a.x + random() * 3, y: a.y + random() * 3 } : a,
      radius: 0.05 + random() * 0.3,
      layer: "bottom",
      owners: [String(i)],
    }
  })
  const index = new CopperIndex(copper)
  for (const point of [
    ...copper.map((c) => c.a),
    ...Array.from({ length: 500 }, () => ({
      x: random() * 30 - 15,
      y: random() * 30 - 15,
    })),
  ]) {
    const distance = (c: Copper) => clearanceToCopper(point, point, c)
    for (const radius of [0.01, 0.2, 2]) {
      const expandedDistance = (c: Copper) => distance(c) - radius
      expect(index.distanceToPoint(point, expandedDistance, radius)).toBe(
        Math.min(...copper.map(expandedDistance)),
      )
    }
    expect(index.distanceToPoint(point, distance)).toBeCloseTo(
      Math.min(...copper.map(distance)),
      12,
    )
  }
  expect(new CopperIndex([]).distanceToPoint({ x: 0, y: 0 }, () => 0)).toBe(
    Infinity,
  )
})

test("median partitions retain every item when dense copper has coincident centers", () => {
  const copper: Copper[] = Array.from({ length: 2048 }, (_, i) => ({
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
    radius: 0.1,
    layer: "inner1",
    owners: [String(i)],
  }))
  const before = [...copper]
  const index = new CopperIndex(copper)
  const visited = new Set<Copper>()
  expect(
    index.some({ minX: -1, maxX: 1, minY: -1, maxY: 1 }, (item) => {
      expect(visited.has(item)).toBe(false)
      visited.add(item)
      return false
    }),
  ).toBe(false)
  expect(visited).toEqual(new Set(copper))
  expect(copper).toEqual(before)
  expect(
    index.distanceToPoint({ x: 0, y: 0 }, (item) =>
      clearanceToCopper({ x: 0, y: 0 }, { x: 0, y: 0 }, item),
    ),
  ).toBe(-0.1)
  expect(index.some({ minX: 1, maxX: 2, minY: 1, maxY: 2 }, () => true)).toBe(
    false,
  )
})
