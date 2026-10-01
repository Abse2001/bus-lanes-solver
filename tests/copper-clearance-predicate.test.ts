import { expect, test } from "bun:test"
import {
  clearanceToCopper,
  copperTooClose,
  type Copper,
} from "../lib/vector-scene"

test("short-circuit copper clearance preserves exact contact decisions", () => {
  let seed = 12345
  const rand = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const point = () => ({ x: rand() * 10 - 5, y: rand() * 10 - 5 })
  for (let i = 0; i < 10000; i++) {
    const a = point(),
      b = i % 7 ? point() : a
    const u = point(),
      v = i % 3 ? point() : u
    const c: Copper = {
      a: u,
      b: v,
      radius: rand() * 0.4,
      owners: [],
      layer: "top",
    }
    const clearance = clearanceToCopper(a, b, c)
    for (const margin of [0.1, clearance, clearance - 1e-12, clearance + 1e-12])
      expect(copperTooClose(a, b, c, margin)).toBe(clearance < margin)
  }
})
