import { am3352SamplePlacements } from "./am3352-samples"

type Report = {
  sample: string
  solved: boolean
  status: string
  solveMilliseconds: number
  requestedSignals: number
  routedSignals: number
  inputUnchanged: boolean
  fixedPowerPreserved: boolean
  validation: { valid: boolean } | null
}

function checkedReports(value: unknown): Report[] {
  const names = am3352SamplePlacements.map((p) => p.name as string)
  if (
    !Array.isArray(value) ||
    value.length !== names.length ||
    new Set(value.map((r) => r?.sample)).size !== names.length
  )
    throw Error(
      "Exactly one result for each of the four AM3352 samples is required",
    )
  for (const report of value) {
    if (
      !report ||
      !names.includes(report.sample) ||
      report.status !== "solved" ||
      report.solved !== true ||
      report.validation?.valid !== true ||
      report.requestedSignals !== 47 ||
      report.routedSignals !== 47 ||
      report.inputUnchanged !== true ||
      report.fixedPowerPreserved !== true ||
      !Number.isFinite(report.solveMilliseconds) ||
      report.solveMilliseconds <= 0
    )
      throw Error(`Invalid or incomplete benchmark result: ${report?.sample}`)
  }
  return value
}

export function compareAm3352Benchmarks(baseline: unknown, candidate: unknown) {
  const before = checkedReports(baseline),
    after = checkedReports(candidate)
  const median = (reports: Report[]) => {
    const times = reports.map((r) => r.solveMilliseconds).sort((a, b) => a - b)
    return (times[1] + times[2]) / 2
  }
  const baselineMedianMs = median(before),
    candidateMedianMs = median(after)
  return {
    baselineMedianMs,
    candidateMedianMs,
    medianSpeedup: baselineMedianMs / candidateMedianMs,
    samples: before.map((r) => {
      const next = after.find((n) => n.sample === r.sample)!
      return {
        sample: r.sample,
        baselineMs: r.solveMilliseconds,
        candidateMs: next.solveMilliseconds,
        speedup: r.solveMilliseconds / next.solveMilliseconds,
      }
    }),
  }
}

if (import.meta.main) {
  const [baselinePath, candidatePath, minimum = "2", ...extra] =
    process.argv.slice(2)
  if (
    !baselinePath ||
    !candidatePath ||
    extra.length ||
    !Number.isFinite(Number(minimum)) ||
    Number(minimum) <= 0
  )
    throw Error(
      "Usage: bun scripts/compare-am3352-benchmarks.ts BASELINE.json CANDIDATE.json [MINIMUM_SPEEDUP=2]",
    )
  const comparison = compareAm3352Benchmarks(
    await Bun.file(baselinePath).json(),
    await Bun.file(candidatePath).json(),
  )
  console.log(JSON.stringify(comparison, null, 2))
  if (comparison.medianSpeedup < Number(minimum)) process.exitCode = 1
}
