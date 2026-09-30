import { expect, test } from "bun:test"
import { simplify } from "../lib/geometry"

test("simplification preserves tiny octilinear connector corners and returning segments", () => {
  const corner = [
    { x: 2, y: -30.2 },
    { x: 2, y: -30.200142 },
    { x: 1.999996, y: -30.200146 },
  ]
  expect(simplify(corner)).toEqual(corner)
  const returning = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0.5, y: 0 },
  ]
  expect(simplify(returning)).toEqual(returning)
  expect(
    simplify([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]),
  ).toEqual([
    { x: 0, y: 0 },
    { x: 2, y: 2 },
  ])
})
