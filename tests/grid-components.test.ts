import { expect, test } from "bun:test"
import { GridComponents } from "../lib/grid-components"
test("occupancy components retain diagonal reachability and isolate full walls", () => {
  const blocked = new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1, 0])
  const labels = new GridComponents(blocked, 3)
  expect(labels.at(0)).toBe(labels.at(8))
  expect(labels.at(4)).toBe(labels.at(0))
  expect(labels.at(1)).toBe(0)
  const wall = new GridComponents(
    new Uint8Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    3,
  )
  expect(wall.at(0)).not.toBe(wall.at(2))
  expect(wall.at(0)).toBe(wall.at(6))
  expect(wall.at(2)).toBe(wall.at(8))
})
test("components do not wrap across row boundaries", () => {
  const labels = new GridComponents(new Uint8Array([1, 1, 0, 0, 1, 1]), 3)
  expect(labels.at(2)).not.toBe(labels.at(3))
})

test("free-run components agree with exhaustive eight-neighbor reachability", () => {
  let random = 131
  const next = () =>
    (random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 2 ** 32
  for (let trial = 0; trial < 100; trial++) {
    const width = 1 + Math.floor(next() * 13),
      height = 1 + Math.floor(next() * 11)
    const blocked = Uint8Array.from({ length: width * height }, () =>
        next() < 0.4 ? 1 : 0,
      ),
      components = new GridComponents(blocked, width)
    for (let start = 0; start < blocked.length; start++) {
      if (blocked[start]) {
        expect(components.at(start)).toBe(0)
        continue
      }
      const seen = new Set([start]),
        queue = [start]
      for (let k = 0; k < queue.length; k++) {
        const id = queue[k],
          x = id % width,
          y = Math.floor(id / width)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height)
              continue
            const other = id + dx + dy * width
            if (!blocked[other] && !seen.has(other)) {
              seen.add(other)
              queue.push(other)
            }
          }
      }
      for (let end = 0; end < blocked.length; end++)
        expect(components.at(start) === components.at(end)).toBe(seen.has(end))
    }
  }
})
