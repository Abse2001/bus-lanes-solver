import { expect, test } from "bun:test"
import { rankSignalConflictPairs } from "../lib/select-signal-conflict-pair"

const key = (first: string, second: string) => [first, second].sort().join(":")

test("unsupported domains outrank a smaller current conflict with older compatible support", () => {
  const domains = [
      ["A_old", "A_current"],
      ["B_current"],
      ["C_old", "C_current"],
      ["D_old", "D_current"],
    ],
    current = ["A_current", "B_current", "C_current", "D_current"],
    blocked = new Set([
      key("A_current", "B_current"),
      ...domains[2].flatMap((a) => domains[3].map((b) => key(a, b))),
    ]),
    pairs = rankSignalConflictPairs(
      domains,
      current,
      (a, b) => !blocked.has(key(a, b)),
    )
  expect(pairs).toEqual([
    { indices: [2, 3], unsupported: true, supports: 0 },
    { indices: [0, 1], unsupported: false, supports: 1 },
  ])
  expect(domains[0]).toEqual(["A_old", "A_current"])
  expect(current).toEqual(["A_current", "B_current", "C_current", "D_current"])
})

test("singleton and smaller unsupported domains rank first with deterministic index ties", () => {
  const domains = [
      ["A0", "A1"],
      ["B0", "B1"],
      ["C0"],
      ["D0", "D1", "D2"],
      ["E0"],
      ["F0"],
      ["G0", "G1"],
      ["H0", "H1"],
    ],
    current = domains.map((domain) => domain[0]),
    blocked = new Set(
      [
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
      ].flatMap(([first, second]) =>
        domains[first].flatMap((a) => domains[second].map((b) => key(a, b))),
      ),
    ),
    compatible = (a: string, b: string) => !blocked.has(key(a, b)),
    pairs = rankSignalConflictPairs(domains, current, compatible)
  expect(pairs.map((pair) => pair.indices)).toEqual([
    [4, 5],
    [2, 3],
    [0, 1],
    [6, 7],
  ])
  expect(pairs.every((pair) => pair.unsupported)).toBe(true)
  expect(rankSignalConflictPairs(domains, current, compatible)).toEqual(pairs)
})

test("a finite support budget checks small domains first and leaves incomplete scans uncertified", () => {
  const domains = [["A0", "A1"], ["B0", "B1"], ["C"], ["D"]],
    current = ["A0", "B0", "C", "D"],
    blocked = new Set([key("A0", "B0"), key("C", "D")])
  let calls = 0
  const pairs = rankSignalConflictPairs(
    domains,
    current,
    (a, b) => {
      calls++
      return !blocked.has(key(a, b))
    },
    1,
  )
  expect(pairs).toEqual([
    { indices: [2, 3], unsupported: true, supports: 0 },
    { indices: [0, 1], unsupported: false, supports: 0 },
  ])
  expect(calls).toBe(7)
})

test("support scans stop after the first compatible candidate pair", () => {
  const domains = [
      ["A_old", "A_current"],
      ["B_old", "B_current"],
    ],
    current = ["A_current", "B_current"]
  let calls = 0
  const pairs = rankSignalConflictPairs(domains, current, (a, b) => {
    calls++
    return key(a, b) !== key("A_current", "B_current")
  })
  expect(pairs).toEqual([{ indices: [0, 1], unsupported: false, supports: 1 }])
  expect(calls).toBe(2)
})

test("already compatible current assignments need no support checks", () => {
  const current = Object.freeze([{ name: "A" }, { name: "B" }]),
    domains = Object.freeze(
      current.map((candidate) => Object.freeze([candidate])),
    )
  let calls = 0
  expect(
    rankSignalConflictPairs(domains, current, () => {
      calls++
      return true
    }),
  ).toEqual([])
  expect(calls).toBe(1)
  expect(domains[0][0]).toBe(current[0])
})
