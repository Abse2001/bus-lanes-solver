import { expect, test } from "bun:test"
import { smoothPairedLobes } from "../lib/smooth-tuning"
import { distance, length, segmentDistance } from "../lib/geometry"

test("smooth paired tuning adds equal length while retaining rail spacing", () => {
  const spacing = 0.22
  const rails = smoothPairedLobes(
    { x: 0, y: 0 },
    { x: 12, y: 0 },
    spacing,
    2,
    2,
    1,
    0.3,
  )!
  expect(rails).not.toBeNull()
  expect(Math.abs(length(rails[0]) - 14)).toBeLessThan(0.00001)
  expect(Math.abs(length(rails[1]) - 14)).toBeLessThan(0.00001)
  for (let i = 0; i < rails[0].length; i++) {
    expect(Math.abs(distance(rails[0][i], rails[1][i]) - spacing)).toBeLessThan(
      1e-8,
    )
  }
  let minimum = Infinity
  for (let i = 1; i < rails[0].length; i++)
    for (let j = 1; j < rails[1].length; j++) {
      minimum = Math.min(
        minimum,
        segmentDistance(
          [rails[0][i - 1], rails[0][i]],
          [rails[1][j - 1], rails[1][j]],
        ),
      )
    }
  expect(minimum).toBeGreaterThan(spacing - 0.0001)
})
