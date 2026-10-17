import { expect, test } from "bun:test"
import { minimizeSignalCandidateConflicts } from "../lib/minimize-signal-candidate-conflicts"
import { solveSignalCandidatePool } from "../lib/solve-signal-candidate-pool"

const pairKey = (first: string, second: string) =>
  [first, second].sort().join(":")

const compatibility = (pairs: string[][]) => {
  const blocked = new Set(
    pairs.map(([first, second]) => pairKey(first, second)),
  )
  return (first: string, second: string) => !blocked.has(pairKey(first, second))
}

const conflictCount = (
  selected: string[],
  compatible: (first: string, second: string) => boolean,
) => {
  let count = 0
  for (let first = 0; first < selected.length; first++)
    for (let second = first + 1; second < selected.length; second++)
      if (!compatible(selected[first], selected[second])) count++
  return count
}

test("older domain choices improve a partial assignment while full selection remains impossible", () => {
  const domains = [["A_old", "A_new"], ["B_old", "B_new"], ["C"], ["D"], ["E"]],
    current = ["A_new", "B_new", "C", "D", "E"],
    compatible = compatibility([
      ["A_new", "B_new"],
      ["A_new", "C"],
      ["A_old", "B_new"],
      ["B_new", "C"],
      ["D", "E"],
    ])
  expect(solveSignalCandidatePool(domains, compatible)).toBeNull()
  const selected = minimizeSignalCandidateConflicts(
    domains,
    current,
    compatible,
  )
  expect(selected).toEqual(["A_old", "B_old", "C", "D", "E"])
  expect(conflictCount(current, compatible)).toBe(4)
  expect(conflictCount(selected, compatible)).toBe(1)
  expect(current).toEqual(["A_new", "B_new", "C", "D", "E"])
  expect(domains[0]).toEqual(["A_old", "A_new"])
})

test("bounded passes revisit a coordinate after another net frees its older candidate", () => {
  const domains = [["A_old", "A_new"], ["B_old", "B_new"], ["C"]],
    current = ["A_new", "B_new", "C"],
    compatible = compatibility([
      ["A_new", "B_new"],
      ["A_old", "B_new"],
      ["B_new", "C"],
      ["A_new", "B_old"],
    ])
  expect(
    minimizeSignalCandidateConflicts(domains, current, compatible, 0),
  ).toEqual(current)
  const once = minimizeSignalCandidateConflicts(
      domains,
      current,
      compatible,
      1,
    ),
    twice = minimizeSignalCandidateConflicts(domains, current, compatible, 2)
  expect(once).toEqual(["A_new", "B_old", "C"])
  expect(conflictCount(once, compatible)).toBe(1)
  expect(twice).toEqual(["A_old", "B_old", "C"])
  expect(conflictCount(twice, compatible)).toBe(0)
})

test("equal-conflict alternatives retain the current candidate without cycling", () => {
  const current = ["A_current", "B"],
    compatible = compatibility([
      ["A_current", "B"],
      ["A_other", "B"],
    ])
  expect(
    minimizeSignalCandidateConflicts(
      [["A_other"], ["B"]],
      current,
      compatible,
      100,
    ),
  ).toEqual(current)
})

test("retains candidate references and supports a current candidate outside its pruned domain", () => {
  const old = { name: "old" },
    currentCandidate = { name: "current" },
    blocker = { name: "blocker" },
    current = [currentCandidate, blocker],
    selected = minimizeSignalCandidateConflicts(
      [[old], [blocker]],
      current,
      (first, second) =>
        ![first, second].includes(currentCandidate) ||
        ![first, second].includes(blocker),
    )
  expect(selected[0]).toBe(old)
  expect(selected[1]).toBe(blocker)
  expect(current[0]).toBe(currentCandidate)
})
