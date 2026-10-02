import { expect, test } from "bun:test"
import { staggeredBankEntries } from "../lib/staggered-bank-entries"

test("unrelated moves share depth while overlapping moves retain lane order", () => {
  const independent = [
    { from: 0, to: 1, width: 0.1 },
    { from: 3, to: 4, width: 0.1 },
    { from: 6, to: 7, width: 0.1 },
  ]
  expect(staggeredBankEntries(independent, 0.1)).toEqual([0, 0, 0])
  const crossing = [
    { from: 0, to: 2, width: 0.1 },
    { from: 1, to: 3, width: 0.1 },
  ]
  expect(staggeredBankEntries(crossing, 0.1)).toEqual([0.2, 0])
  expect(
    staggeredBankEntries(
      crossing.map((p) => ({ ...p, from: -p.from, to: -p.to })),
      0.1,
    ),
  ).toEqual([0.2, 0])
})

test("staggering reserves full pair width and refuses intersecting bank orders", () => {
  expect(
    staggeredBankEntries(
      [
        { from: 0, to: 2, width: 0.32 },
        { from: 1, to: 3, width: 0.1 },
      ],
      0.1,
    )![0],
  ).toBeCloseTo(0.31)
  expect(
    staggeredBankEntries(
      [
        { from: 0, to: 2, width: 0.1 },
        { from: 2, to: 0, width: 0.1 },
      ],
      0.1,
    ),
  ).toBeNull()
  expect(
    staggeredBankEntries(
      [
        { from: 0, to: 0, width: 0.1 },
        { from: 1, to: 1, width: 0.1 },
      ],
      0.1,
    ),
  ).toEqual([0, 0])
})
