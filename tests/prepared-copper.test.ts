import { expect, test } from "bun:test"
import {
  clearanceToCopper,
  copperTooClosePrepared,
  prepareCopper,
  type Copper,
} from "../lib/vector-scene"

test("prepared copper preserves threshold decisions for capsules, points and rectangles", () => {
  let seed = 98765
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const point = () => ({ x: random() * 20 - 10, y: random() * 20 - 10 })
  for (let i = 0; i < 10000; i++) {
    const a = point(),
      b = i % 7 ? point() : a,
      u = point(),
      v = i % 3 ? point() : u
    const c: Copper = {
      a: u,
      b: v,
      radius: random() * 0.5,
      layer: "top",
      owners: [],
      ...(i % 11 === 0
        ? {
            rect: {
              minX: Math.min(u.x, v.x),
              maxX: Math.max(u.x, v.x),
              minY: Math.min(u.y, v.y),
              maxY: Math.max(u.y, v.y),
            },
          }
        : {}),
    }
    const prepared = prepareCopper(c),
      dx = b.x - a.x,
      dy = b.y - a.y,
      denominator = dx * dx + dy * dy,
      clearance = clearanceToCopper(a, b, c)
    for (const margin of [0.1, clearance, clearance - 1e-12, clearance + 1e-12])
      expect(
        copperTooClosePrepared(
          a.x,
          a.y,
          b.x,
          b.y,
          dx,
          dy,
          denominator,
          prepared,
          margin,
        ),
      ).toBe(clearance < margin)
  }
})
