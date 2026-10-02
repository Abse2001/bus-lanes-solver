import { expect, test } from "bun:test"
import { gridPossiblyConnected } from "../lib/grid-connectivity"

test("scanline connectivity agrees with exhaustive eight-neighbor flood fill", () => {
  let seed = 411
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  for (let run = 0; run < 400; run++) {
    const width = 1 + Math.floor(random() * 30),
      height = 1 + Math.floor(random() * 30)
    const grid = Uint8Array.from({ length: width * height }, () =>
      Number(random() < 0.5),
    )
    const start = Math.floor(random() * grid.length),
      goal = Math.floor(random() * grid.length)
    grid[start] = grid[goal] = 0
    const seen = new Set([goal]),
      queue = [goal]
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head],
        x = id % width,
        y = Math.floor(id / width)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height)
            continue
          const next = id + dx + dy * width
          if (!grid[next] && !seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
    }
    expect(gridPossiblyConnected(grid, width, start, goal, grid.length)).toBe(
      seen.has(start),
    )
    if (seen.has(start))
      expect(gridPossiblyConnected(grid, width, start, goal, 1)).toBe(true)
  }
})

test("connectivity preflight allows diagonal-only adjacency and inconclusive work limits", () => {
  expect(gridPossiblyConnected(new Uint8Array([0, 1, 1, 0]), 2, 0, 3)).toBe(
    true,
  )
  const divided = new Uint8Array(100)
  for (let y = 0; y < 10; y++) divided[y * 10 + 5] = 1
  expect(gridPossiblyConnected(divided, 10, 0, 99, 100)).toBe(false)
  expect(gridPossiblyConnected(divided, 10, 0, 99, 1)).toBe(true)
})
