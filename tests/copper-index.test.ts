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
