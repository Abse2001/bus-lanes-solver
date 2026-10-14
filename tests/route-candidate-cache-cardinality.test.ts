import { expect, test } from "bun:test"
import { RouteCandidatePool } from "../lib/select-route-candidates"

type CompatibilityProbe = {
  compatible(domains: never[][], searchBudget?: number): unknown[] | null
}
const probe = (pool: RouteCandidatePool) =>
  pool as unknown as CompatibilityProbe
const budgets = [undefined, 500000] as const

test("an empty assignment cache cannot satisfy a missing candidate domain", () => {
  for (const budget of budgets) {
    const pool = probe(new RouteCandidatePool(0.1524))
    expect(pool.compatible([], budget)).toEqual([])
    expect(pool.compatible([[]], budget)).toBeNull()
    expect(pool.compatible([], budget)).toEqual([])
    expect(pool.compatible([[]], budget)).toBeNull()
  }
})

test("a missing candidate domain cache cannot reject an empty assignment", () => {
  for (const budget of budgets) {
    const pool = probe(new RouteCandidatePool(0.1524))
    expect(pool.compatible([[]], budget)).toBeNull()
    expect(pool.compatible([], budget)).toEqual([])
    expect(pool.compatible([[]], budget)).toBeNull()
    expect(pool.compatible([], budget)).toEqual([])
  }
})

test("unresolved and conditional routes retain a missing unit in either query order", () => {
  for (const emptyFirst of [true, false]) {
    const pool = new RouteCandidatePool(0.1524)
    if (emptyFirst) expect(pool.unresolvedUnits([])).toBeNull()
    expect(pool.unresolvedUnits(["missing-domain"])).toEqual(["missing-domain"])
    expect(pool.unresolvedUnits([])).toBeNull()
    expect(pool.conditionalRoutes(["missing-domain"], 0)).toBeNull()
    expect(pool.conditionalRoutes([], 0)).toEqual([])
  }
})

test("mixed empty domains and search budgets keep their assignment results separate", () => {
  const domains: never[][][] = [[[], []], [], [[]], [[], [], []], [], [[], []]]
  for (const budget of budgets) {
    const pool = probe(new RouteCandidatePool(0.1524))
    for (const next of domains) {
      const result = pool.compatible(next, budget)
      if (next.length) expect(result).toBeNull()
      else expect(result).toEqual([])
    }
  }
  const mixed = new RouteCandidatePool(0.1524)
  expect(mixed.unresolvedUnits(["missing-A", "missing-B"])).toEqual(["missing-B"])
  expect(mixed.conditionalRoutes(["missing-A", "missing-B"], 0)).toBeNull()
  expect(mixed.unresolvedUnits([])).toBeNull()
  const separateBudgets = probe(new RouteCandidatePool(0.1524))
  expect(separateBudgets.compatible([])).toEqual([])
  expect(separateBudgets.compatible([[]], 500000)).toBeNull()
  expect(separateBudgets.compatible([[]])).toBeNull()
  expect(separateBudgets.compatible([], 500000)).toEqual([])
})
