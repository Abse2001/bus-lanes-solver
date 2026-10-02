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

test("direct rounded-lobe height matches emitted copper across rotations and offsets", () => {
  for (const angle of [
    0,
    Math.PI / 4,
    Math.PI / 2,
    (Math.PI * 3) / 4,
    Math.PI,
    (Math.PI * 5) / 4,
  ])
    for (const spacing of [0, 0.22])
      for (const lobes of [1, 3, 9])
        for (const side of [-1, 1]) {
          const a = { x: 17.25, y: -31.5 }
          const b = {
            x: a.x + 24 * Math.cos(angle),
            y: a.y + 24 * Math.sin(angle),
          }
          const rails = roundedPairedLobes(a, b, spacing, 7, lobes, side, 0.12)!
          expect(rails).not.toBeNull()
          for (const rail of rails)
            expect(Math.abs(length(rail) - 31)).toBeLessThan(1e-7)
        }
})
