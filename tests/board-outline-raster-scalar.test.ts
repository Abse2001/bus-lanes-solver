import { expect, test } from "bun:test"
import { BoardOutline } from "../lib/board-outline"
import { pointSegmentDistanceToPoints } from "../lib/geometry"
import type { Point } from "../lib/types"
import { loadG350Am3352Sample } from "../scripts/g350-am3352-sample"

function compare(outline: BoardOutline, p: Point) {
  const distance = Math.min(...outline.points.map((a, index) =>
    pointSegmentDistanceToPoints(p, a, outline.points[(index + 1) % outline.points.length])))
  const contact = distance + 1e-9
  const delta = Math.max(Number.MIN_VALUE, Math.abs(contact) * Number.EPSILON)
  for (const clearance of [0, -0, -0.1, 0.0508, 0.1016, contact - delta,
    contact, contact + delta, NaN, Infinity, -Infinity])
    expect(outline.pointIsClearXY(p.x, p.y, clearance)).toBe(outline.pointIsClear(p, clearance))
}

test("one-pass scalar outline clearance preserves winding, boundary and exact clearance decisions", () => {
  const polygons: Point[][] = [
    [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }],
    [{ x: -3, y: -3 }, { x: 3, y: -3 }, { x: 3, y: 3 }, { x: 1, y: 3 },
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 3 }, { x: -3, y: 3 }],
    [{ x: -3, y: -2 }, { x: 1, y: -3 }, { x: 3, y: 1 }, { x: 0, y: 3 }],
  ]
  for (const polygon of polygons) for (const points of [polygon, [...polygon].reverse()]) {
    const outline = new BoardOutline(points)
    for (let row = -9; row <= 9; row++) for (let column = -9; column <= 9; column++)
      compare(outline, { x: column * 0.4 + 0.013, y: row * 0.4 - 0.029 })
    for (const a of points) for (const dx of [-1.0001e-9, -1e-9, 0, 1e-9, 1.0001e-9])
      for (const dy of [-1e-9, 0, 1e-9]) compare(outline, { x: a.x + dx, y: a.y + dy })
  }
})

test("native G350 scalar outline checks retain the board-grid phase and cutout contacts", () => {
  const input = loadG350Am3352Sample()
  const outline = new BoardOutline(input.outline!)
  expect(outline.points).toHaveLength(14)
  for (let row = 0; row < 2364; row += 127)
    for (let column = 0; column < 1537; column += 97)
      compare(outline, { x: input.bounds.minX + column * 0.0508,
        y: input.bounds.minY + row * 0.0508 })
  for (let index = 0; index < outline.points.length; index++) {
    const a = outline.points[index], b = outline.points[(index + 1) % outline.points.length]
    for (const p of [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }])
      for (const dx of [-0.1516, -1e-9, 0, 1e-9, 0.1516])
        for (const dy of [-0.1516, 0, 0.1516]) compare(outline, { x: p.x + dx, y: p.y + dy })
  }
})

test("scalar outline queries retain nonfinite, live-point and custom predicate behavior", () => {
  const outline = new BoardOutline([{ x: -2, y: -2 }, { x: 2, y: -2 },
    { x: 2, y: 2 }, { x: -2, y: 2 }])
  for (const p of [{ x: -0, y: 0 }, { x: NaN, y: 0 }, { x: Infinity, y: 0 },
    { x: 0, y: -Infinity }, { x: Number.MAX_VALUE, y: Number.MAX_VALUE }]) compare(outline, p)
  outline.points[1].x = 1
  for (const p of [{ x: 1.5, y: -1 }, { x: 1, y: -2 }, { x: 0, y: 0 }]) compare(outline, p)
  outline.points[1].x = outline.points[0].x
  outline.points[1].y = outline.points[0].y
  for (const p of [{ x: -2, y: -2 }, { x: 0, y: 0 }, { x: 3, y: 3 }]) compare(outline, p)
  class RestrictedOutline extends BoardOutline {
    override containsPoint(p: Point) { return p.x < 0 && super.containsPoint(p) }
  }
  class CustomOutline extends BoardOutline {
    override pointIsClear(p: Point, clearance: number) { return p.x === clearance }
  }
  for (const Type of [RestrictedOutline, CustomOutline]) {
    const custom = new Type([{ x: -2, y: -2 }, { x: 2, y: -2 },
      { x: 2, y: 2 }, { x: -2, y: 2 }])
    for (const p of [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }]) compare(custom, p)
  }
})
