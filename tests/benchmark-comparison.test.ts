import { expect, test } from "bun:test"
import { compareAm3352Benchmarks } from "../scripts/compare-am3352-benchmarks"

const reports = (times: number[]) =>
  ["control", "right", "left", "above"].map((sample, i) => ({
    sample,
    solveMilliseconds: times[i],
    solved: true,
    status: "solved",
    requestedSignals: 47,
    routedSignals: 47,
    inputUnchanged: true,
    fixedPowerPreserved: true,
    validation: { valid: true },
  }))

test("benchmark comparison uses the median of all four completed solve times", () => {
  const comparison = compareAm3352Benchmarks(
    reports([5, 371, 74, 470]),
    reports([4, 130, 40, 250]).reverse(),
  )
  expect(comparison.baselineMedianMs).toBe(222.5)
  expect(comparison.candidateMedianMs).toBe(85)
  expect(comparison.medianSpeedup).toBe(222.5 / 85)
  expect(
    comparison.samples.find((s) => s.sample === "right")?.candidateMs,
  ).toBe(130)
})

test("missing, duplicate, failed, unaudited or zero-time samples cannot claim a speedup", () => {
  const valid = reports([5, 371, 74, 470])
  for (const invalid of [
    valid.slice(1),
    [valid[0], valid[0], valid[2], valid[3]],
    ...[
      { sample: "unknown" },
      { status: "timed_out" },
      { solved: false },
      { validation: { valid: false } },
      { validation: null },
      { routedSignals: 46 },
      { inputUnchanged: false },
      { fixedPowerPreserved: false },
      { solveMilliseconds: 0 },
      { solveMilliseconds: Infinity },
    ].map((change) => [{ ...valid[0], ...change }, ...valid.slice(1)]),
  ]) {
    expect(() => compareAm3352Benchmarks(valid, invalid)).toThrow()
    expect(() => compareAm3352Benchmarks(invalid, valid)).toThrow()
  }
})
