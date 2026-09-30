import { expect, test } from "bun:test"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { smoothTuningLobes } from "../lib/smooth-tuning"

test("local smooth bends do not exempt tight returning arms or crossings", () => {
  expect(
    tuningPathIsSelfClear(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.05 },
        { x: 0, y: 0.05 },
      ],
      0.2,
    ),
  ).toBe(false)
  expect(
    tuningPathIsSelfClear(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
        { x: 1, y: 0 },
      ],
      0.2,
    ),
  ).toBe(false)
  expect(
    tuningPathIsSelfClear(
      smoothTuningLobes({ x: 0, y: 0 }, { x: 10, y: 0 }, 1, 2, 1, 0.3)!,
      0.2,
    ),
  ).toBe(true)
})
