import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { generatedEscapeHolesConflict } from "../lib/expanded-signal-sites"
import {
  pruneCandidateDomains,
  type CandidateDomainFailure,
} from "../lib/prune-candidate-domains"
import {
  guidanceWidth,
  propagatingCpuSiteConflictFixture,
} from "./selective-guidance-fixtures"

test("completed physical site propagation records the full contradiction across initially compatible domains", () => {
  const { native, domains } = propagatingCpuSiteConflictFixture()
  const before = structuredClone({ native, domains })
  const index = new CopperConflictIndex()
  const compatible = (
    a: (typeof domains)[number]["options"][number],
    b: (typeof domains)[number]["options"][number],
  ) =>
    !generatedEscapeHolesConflict(native, a.escapes, b.escapes) &&
    !index.firstConflict(a.escapeCopper, b.escapeCopper, guidanceWidth - 1e-8)
  for (const domain of domains)
    for (const option of domain.options) {
      const checked = validateRoutedCopperDrc({
        inputSrj: native,
        routedSrj: { ...native, traces: option.escapes },
        clearance: guidanceWidth,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0])
      expect(checked).toMatchObject({ valid: true, issues: [] })
    }
  for (let a = 0; a < domains.length; a++)
    for (let b = a + 1; b < domains.length; b++)
      expect(
        domains[a].options.some((first) =>
          domains[b].options.some((second) => compatible(first, second)),
        ),
      ).toBe(true)
  const failures: CandidateDomainFailure[] = []
  expect(
    pruneCandidateDomains(
      domains.map((domain) => domain.options),
      compatible,
      1000000,
      (failure) => failures.push(failure),
    ),
  ).toBeNull()
  expect(failures).toHaveLength(1)
  const names = new Set(
    failures[0].implicatedRemovals.flatMap((removal) => [
      domains[removal.first].name,
      domains[removal.second].name,
    ]),
  )
  expect([...names].sort()).toEqual(["A", "B", "C"])
  expect(failures[0].implicatedRemovals).toHaveLength(2)
  for (const removal of failures[0].removals)
    for (const removed of removal.removed)
      for (const support of removal.support)
        expect(
          compatible(
            domains[removal.first].options[removed],
            domains[removal.second].options[support],
          ),
        ).toBe(false)
  expect({ native, domains }).toEqual(before)
})

test("a support work bound retains the unproved physical domains and emits no failure callback", () => {
  const { native, domains } = propagatingCpuSiteConflictFixture()
  const index = new CopperConflictIndex()
  const failures: CandidateDomainFailure[] = []
  let checks = 0
  const source = domains.map((domain) => domain.options)
  const retained = pruneCandidateDomains(
    source,
    (a, b) => {
      checks++
      return (
        !generatedEscapeHolesConflict(native, a.escapes, b.escapes) &&
        !index.firstConflict(
          a.escapeCopper,
          b.escapeCopper,
          guidanceWidth - 1e-8,
        )
      )
    },
    1,
    (failure) => failures.push(failure),
  )
  expect(retained).toEqual(source)
  expect(retained![0][0]).toBe(source[0][0])
  expect(checks).toBe(1)
  expect(failures).toEqual([])
})
