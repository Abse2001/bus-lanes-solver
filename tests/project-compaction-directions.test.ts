import { expect, test } from "bun:test"
import { projectCompactionDirections } from "../lib/project-compaction-directions"
import type { CompactionVertex } from "../lib/compaction-motion-groups"

test("stationary translations cannot drift across a fixed clearance boundary", () => {
  const paths: CompactionVertex[][] = [
    [
      { x: 0, y: 0 },
      { x: 1, y: 1, group: 0 },
      { x: 4, y: 1, group: 1 },
      { x: 5, y: 0 },
    ],
  ]
  const values = new Map([
    ["0_x_1", 2e-9],
    ["0_y_1", 1e-9],
    ["1_x_1", 1e-9],
    ["1_y_-1", 2e-9],
  ])
  const shifts = projectCompactionDirections(paths, values)
  expect([...shifts.values()]).toEqual([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ])
})

test("rounding correction preserves rigid arcs and fixed endpoint directions", () => {
  const paths: CompactionVertex[][] = [
    [
      { x: 0, y: 0 },
      { x: 1, y: 1, group: 0 },
      { x: 1, y: 5, group: 1 },
      { x: 1.1, y: 5.1, group: 1 },
      { x: 2, y: 6, group: 1 },
      { x: 8, y: 6, group: 2 },
      { x: 9, y: 5, group: 2 },
      { x: 9, y: 1, group: 3 },
      { x: 10, y: 0 },
    ],
  ]
  const values = new Map([
    ["0_x_1", 0.1],
    ["0_y_1", 0.100000004],
    ["1_x_1", 0.100000002],
    ["1_y_-1", 0.3],
    ["2_x_-1", 0.100000002],
    ["2_y_-1", 0.299999997],
    ["3_x_-1", 0.1],
    ["3_y_1", 0.100000004],
  ])
  const snapshot = structuredClone(paths)
  const shifts = projectCompactionDirections(paths, values)
  for (let i = 1; i < paths[0].length; i++) {
    const a = paths[0][i - 1],
      b = paths[0][i]
    const da = shifts.get(a.group!) ?? { x: 0, y: 0 }
    const db = shifts.get(b.group!) ?? { x: 0, y: 0 }
    const cross = (db.x - da.x) * (b.y - a.y) - (db.y - da.y) * (b.x - a.x)
    expect(Math.abs(cross)).toBeLessThan(1e-11)
  }
  expect(shifts.get(1)!.y).toBeLessThan(-0.29)
  expect(paths).toEqual(snapshot)
})
