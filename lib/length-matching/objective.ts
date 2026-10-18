import {
  LENGTH_COMPARISON_TOLERANCE_MM,
  normalizeLengthMatchingProblem,
  type LengthMatchingProblem,
  type LengthTargetPortfolio,
} from "./targets"

export interface MatchingMeasurement {
  fullLengthsMm: Readonly<Record<string, number>>
  totalWireLengthMm: number
  viaCount: number
}
export interface LengthMatchingEvaluation {
  timingSolved: boolean
  targetPlanId: string | null
  outOfBandNames: string[]
  sumBandErrorMm: number
  actualConstraintFailures: number
  actualExcessMm: number
  maximumActualExcessMm: number
  reports: Array<{
    id: string
    kind: "bus" | "pair"
    minimumMm: number
    maximumMm: number
    spreadMm: number
    skewExcessMm: number
    absoluteErrorMm: number
    matched: boolean
  }>
  /** Solved first, then signal count/error, actual failures/error, copper/vias. */
  score: readonly [number, number, number, number, number, number, number]
}

export function compareLengthMatchingScores(
  a: readonly number[],
  b: readonly number[],
) {
  if (
    a.length !== b.length ||
    a.some((n) => !Number.isFinite(n)) ||
    b.some((n) => !Number.isFinite(n))
  )
    throw Error("Matching scores must have equal length and finite entries")
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

export function evaluateLengthMatchingState(
  problem: LengthMatchingProblem,
  portfolio: LengthTargetPortfolio,
  measurement: MatchingMeasurement,
  options: { nativeTimingValid?: boolean } = {},
): LengthMatchingEvaluation {
  const { constraints } = normalizeLengthMatchingProblem(problem)
  if (JSON.stringify(constraints) !== JSON.stringify(portfolio.constraints))
    throw Error("Portfolio constraints differ from problem")
  const names = problem.nets.map((n) => n.name)
  if (
    Object.keys(measurement.fullLengthsMm).length !== names.length ||
    names.some(
      (n) =>
        !Number.isFinite(measurement.fullLengthsMm[n]) ||
        measurement.fullLengthsMm[n] < 0,
    )
  )
    throw Error("Measurements must cover every exact native owner once")
  for (const net of problem.nets) {
    const value = measurement.fullLengthsMm[net.name]
    if (
      value < net.lowerBoundMm - LENGTH_COMPARISON_TOLERANCE_MM ||
      (net.fixedLength &&
        Math.abs(value - net.currentLengthMm) > LENGTH_COMPARISON_TOLERANCE_MM)
    )
      throw Error(`${net.name} measurement violates its immutable length facts`)
  }
  if (
    !Number.isFinite(measurement.totalWireLengthMm) ||
    measurement.totalWireLengthMm < 0 ||
    !Number.isInteger(measurement.viaCount) ||
    measurement.viaCount < 0
  )
    throw Error("Wire length and via measurements must be nonnegative")
  const excess = (value: number) =>
    value > LENGTH_COMPARISON_TOLERANCE_MM ? value : 0
  let failures = 0,
    actualExcessMm = 0,
    maximumActualExcessMm = 0
  const reports = constraints.map((c) => {
    const values = c.names.map((n) => measurement.fullLengthsMm[n]),
      minimumMm = Math.min(...values),
      maximumMm = Math.max(...values)
    const skewExcessMm =
      c.tolerance === undefined
        ? 0
        : excess(maximumMm - minimumMm - c.tolerance)
    const absoluteErrors = values.flatMap((value) => [
      excess((c.minimum ?? 0) - value),
      excess(value - (c.maximum ?? Infinity)),
    ])
    failures +=
      Number(skewExcessMm > 0) + absoluteErrors.filter((e) => e > 0).length
    const absoluteErrorMm = absoluteErrors.reduce((a, b) => a + b, 0)
    actualExcessMm += skewExcessMm + absoluteErrorMm
    maximumActualExcessMm = Math.max(
      maximumActualExcessMm,
      skewExcessMm,
      ...absoluteErrors,
    )
    return {
      id: c.id,
      kind: c.kind,
      minimumMm,
      maximumMm,
      spreadMm: maximumMm - minimumMm,
      skewExcessMm,
      absoluteErrorMm,
      matched: skewExcessMm === 0 && absoluteErrorMm === 0,
    }
  })
  let best: { id: string; names: string[]; error: number } | undefined
  for (const plan of portfolio.plans) {
    const outside: string[] = [],
      errors: number[] = []
    for (const name of portfolio.timedNames) {
      const band = plan.bands[name],
        value = measurement.fullLengthsMm[name]
      const error = excess(
        Math.max(band.minimum - value, value - (band.maximum ?? Infinity), 0),
      )
      if (error > 0) outside.push(name)
      errors.push(error)
    }
    const candidate = {
      id: plan.id,
      names: outside,
      error: errors.reduce((a, b) => a + b, 0),
    }
    if (
      !best ||
      candidate.names.length < best.names.length ||
      (candidate.names.length === best.names.length &&
        candidate.error < best.error)
    )
      best = candidate
  }
  // No feasible length plan is an explicit planning failure, not a free window.
  const outOfBandNames = best?.names ?? [...portfolio.timedNames]
  const sumBandErrorMm = best?.error ?? actualExcessMm
  const timingSolved = failures === 0 && options.nativeTimingValid !== false
  return {
    timingSolved,
    targetPlanId: best?.id ?? null,
    outOfBandNames,
    sumBandErrorMm,
    actualConstraintFailures: failures,
    actualExcessMm,
    maximumActualExcessMm,
    reports,
    score: [
      Number(!timingSolved),
      outOfBandNames.length,
      sumBandErrorMm,
      failures,
      actualExcessMm,
      measurement.totalWireLengthMm,
      measurement.viaCount,
    ],
  }
}
