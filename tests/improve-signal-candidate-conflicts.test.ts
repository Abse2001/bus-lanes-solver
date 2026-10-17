import { expect, test } from "bun:test"
import { improveSignalCandidateConflicts } from "../lib/improve-signal-candidate-conflicts"
import { minimizeSignalCandidateConflicts } from "../lib/minimize-signal-candidate-conflicts"

const pairKey = (a: string, b: string) => [a, b].sort().join(":")
const checker = (pairs: string[][]) => {
  const blocked = new Set(pairs.map(([a, b]) => pairKey(a, b)))
  return (a: string, b: string) => !blocked.has(pairKey(a, b))
}
const conflicts = <T>(values: readonly T[], clear: (a: T, b: T) => boolean) => {
  let total = 0
  for (let i = 0; i < values.length; i++)
    for (let j = i + 1; j < values.length; j++)
      if (!clear(values[i], values[j])) total++
  return total
}

test("an atomic pair update escapes a strict single-coordinate conflict plateau", () => {
  const domains = [
      ["A0", "A1"],
      ["B0", "B1"],
    ],
    current = ["A0", "B0"],
    clear = checker([
      ["A0", "B0"],
      ["A1", "B0"],
      ["A0", "B1"],
    ])
  expect(minimizeSignalCandidateConflicts(domains, current, clear)).toEqual(
    current,
  )
  expect(
    improveSignalCandidateConflicts(domains, current, clear, {
      maxPlateauMoves: 0,
    }),
  ).toEqual(["A1", "B1"])
  expect(current).toEqual(["A0", "B0"])
})

test("a currently clear connection can move together with its contested neighbor", () => {
  const domains = [["A0", "A1"], ["B"], ["C0", "C1"]],
    current = ["A0", "B", "C0"],
    clear = checker([
      ["A0", "B"],
      ["A1", "C0"],
    ])
  expect(minimizeSignalCandidateConflicts(domains, current, clear)).toEqual(
    current,
  )
  const answer = improveSignalCandidateConflicts(domains, current, clear, {
    maxPlateauMoves: 0,
  })
  expect(answer).toEqual(["A1", "B", "C1"])
  expect(conflicts(answer, clear)).toBe(0)
})

test("plateau changes are opt-in returns and never increase the conflict count", () => {
  const domains = [["A0", "A1"], ["B"]],
    current = ["A0", "B"],
    clear = checker([
      ["A0", "B"],
      ["A1", "B"],
    ])
  expect(improveSignalCandidateConflicts(domains, current, clear)).toEqual(
    current,
  )
  const changed = improveSignalCandidateConflicts(domains, current, clear, {
    returnPlateauChanges: true,
  })
  expect(changed).toEqual(["A1", "B"])
  expect(conflicts(changed, clear)).toBe(1)
})

test("a bounded plateau move can unlock a later strict two-connection improvement", () => {
  const domains = [
      ["A0", "A1"],
      ["B0", "B1"],
      ["C0", "C1"],
    ],
    current = ["A0", "B0", "C0"],
    clear = checker([
      ["A0", "B0"],
      ["A1", "B0"],
      ["A0", "B1"],
      ["A1", "C0"],
      ["B1", "C0"],
    ])
  expect(
    improveSignalCandidateConflicts(domains, current, clear, {
      maxPlateauMoves: 0,
    }),
  ).toEqual(current)
  const answer = improveSignalCandidateConflicts(domains, current, clear)
  expect(answer).toEqual(["A1", "B1", "C1"])
  expect(conflicts(answer, clear)).toBe(0)
})

test("compatibility work is bounded and callback failures propagate", () => {
  const domains = Array.from({ length: 8 }, (_, i) => [`${i}a`, `${i}b`]),
    current = domains.map((domain) => domain[0])
  let checks = 0
  const clear = () => {
    checks++
    return false
  }
  expect(
    improveSignalCandidateConflicts(domains, current, clear, {
      maxCompatibilityChecks: 37,
    }),
  ).toEqual(current)
  expect(checks).toBe(37)
  expect(() =>
    improveSignalCandidateConflicts(domains, current, () => {
      throw Error("physical check failed")
    }),
  ).toThrow("physical check failed")
})

test("random compatibility graphs retain references and cannot worsen the complete assignment", () => {
  let seed = 120917
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  for (let sample = 0; sample < 75; sample++) {
    const domains = Array.from({ length: 5 }, (_, net) =>
        Array.from({ length: 3 }, (_, at) => ({ net, at })),
      ),
      current = domains.map((domain) => domain[0]),
      blocked = new Set<string>(),
      edge = (
        a: { net: number; at: number },
        b: { net: number; at: number },
      ) =>
        a.net < b.net
          ? `${a.net},${a.at}:${b.net},${b.at}`
          : `${b.net},${b.at}:${a.net},${a.at}`
    for (let i = 0; i < domains.length; i++)
      for (let j = i + 1; j < domains.length; j++)
        for (const a of domains[i])
          for (const b of domains[j])
            if (random() < 0.4) blocked.add(edge(a, b))
    const clear = (a: (typeof current)[number], b: (typeof current)[number]) =>
        !blocked.has(edge(a, b)),
      before = structuredClone(domains),
      answer = improveSignalCandidateConflicts(domains, current, clear, {
        maxCompatibilityChecks: 1000,
        returnPlateauChanges: true,
      })
    expect(conflicts(answer, clear)).toBeLessThanOrEqual(
      conflicts(current, clear),
    )
    for (let at = 0; at < answer.length; at++)
      expect(domains[at].includes(answer[at])).toBe(true)
    expect(domains).toEqual(before)
  }
})
