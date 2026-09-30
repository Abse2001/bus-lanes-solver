import { expect, test } from "bun:test"
import { roundedPairedLobes } from "../lib/smooth-tuning"
import { length, segmentDistance } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"

test("rounded paired meanders fit added length into a narrow bank without self contacts", () => {
  const rails = roundedPairedLobes(
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    0.22,
    12,
    16,
    1,
    0.12,
  )!
  expect(rails).not.toBeNull()
  for (const rail of rails) {
    expect(length(rail)).toBeCloseTo(32, 6)
    expect(Math.max(...rail.map((p) => p.y))).toBeLessThan(0.7)
    expect(tuningPathIsSelfClear(rail, 0.2)).toBe(true)
  }
  let minGap = Infinity
  for (let i = 1; i < rails[0].length; i++)
    for (let j = 1; j < rails[1].length; j++) {
      minGap = Math.min(
        minGap,
        segmentDistance(
          [rails[0][i - 1], rails[0][i]],
          [rails[1][j - 1], rails[1][j]],
        ),
      )
    }
  expect(minGap - 0.1).toBeGreaterThan(0.119)
})
