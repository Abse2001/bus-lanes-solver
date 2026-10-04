import { expect, test } from "bun:test"
import { CompactionCutSet, type CompactionCut } from "../lib/compaction-cut-set"

const cut = (
  x: number,
  y: number,
  min: number,
  reversed = false,
): CompactionCut => ({
  a: { x: 0, y: 0, group: reversed ? 1 : 0 },
  b: { x: 0, y: 0, group: reversed ? 0 : 1 },
  n: { x: reversed ? -x : x, y: reversed ? -y : y },
  min,
})
const permits = (cuts: CompactionCut[], x: number, y: number) =>
  cuts.every((c) => {
    const sign = c.a.group! < c.b.group! ? 1 : -1
    return sign * (c.n.x * x + c.n.y * y) >= c.min - 1e-9
  })

test("collision pruning retains the intersection while removing redundant rows", () => {
  const cuts = [
    cut(1, 0, -1),
    cut(0, 1, -1, true),
    cut(-1, 0, -2),
    cut(0, -1, -2),
    cut(1, 1, -1),
    cut(1, 0, -2),
    cut(2, 2, -3, true),
  ]
  const set = new CompactionCutSet(2)
  for (const c of cuts) set.add(c)
  const active = [...set.active()]
  expect(active.length).toBeLessThan(cuts.length)
  for (let x = -4; x <= 4; x += 0.125)
    for (let y = -4; y <= 4; y += 0.125)
      expect(permits(active, x, y)).toBe(permits(cuts, x, y))
})

for (const extent of [0, 1])
  test(`degenerate feasible ${extent === 0 ? "point" : "line"} retains its cuts`, () => {
    const cuts = [
      cut(1, 0, 0),
      cut(-1, 0, 0),
      cut(0, 1, -extent),
      cut(0, -1, -extent),
    ]
    const set = new CompactionCutSet(2)
    for (const c of cuts) set.add(c)
    expect(new Set(set.active())).toEqual(new Set(cuts))
  })

test("infeasible intersections retain constraints instead of becoming unconstrained", () => {
  const cuts = [cut(1, 0, 1), cut(-1, 0, 1)],
    set = new CompactionCutSet(2)
  for (const c of cuts) set.add(c)
  expect(new Set(set.active())).toEqual(new Set(cuts))
})
