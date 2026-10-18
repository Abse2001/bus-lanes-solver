/** Pure length-domain planning. Feasible targets do not prove geometric room. */
export interface MatchingNet {
  name: string
  /** Complete owned/generated XY copper plus immutable native copper, once. */
  currentLengthMm: number
  /** Immutable native copper + fixed endpoint paths + Euclidean free-end span. */
  lowerBoundMm: number
  /** A complete held rail has no mutable length, unlike a held endpoint prefix. */
  fixedLength?: boolean
}
export interface MatchingBus {
  busId: string
  connectionNames: readonly string[]
  minLength?: number
  maxLength?: number
  maxLengthSkew?: number
}
export interface MatchingPair {
  connectionNames: readonly [string, string]
  lengthTolerance: number
}
export interface LengthMatchingProblem {
  nets: readonly MatchingNet[]
  buses?: readonly MatchingBus[]
  differentialPairs?: readonly MatchingPair[]
}
export interface MatchingConstraint {
  id: string
  kind: "bus" | "pair"
  names: string[]
  minimum?: number
  maximum?: number
  tolerance?: number
}
export interface LengthBand {
  minimum: number
  /** Null is an explicit JSON-safe unbounded maximum. */
  maximum: number | null
}
export interface LengthTargetPlan {
  id: string
  targets: Record<string, number>
  bands: Record<string, LengthBand>
  constraintWindows: Record<string, LengthBand>
  shorteningNames: string[]
  lengthDomainFeasible: true
  geometricFeasibilityEstablished: false
}
export interface LengthTargetPortfolio {
  plans: LengthTargetPlan[]
  timedNames: string[]
  untimedNames: string[]
  failures: Array<{ id: string; reason: string }>
  constraints: MatchingConstraint[]
  shorteningPotential: Array<{
    constraintId: string
    currentMaximumMm: number
    leastFeasibleMaximumMm: number | null
    potentialReductionMm: number | null
  }>
  /** Target bands remain frozen across all comparisons in a matching attempt. */
  fixedPortfolio: true
  geometricFeasibilityEstablished: false
}
export const LENGTH_COMPARISON_TOLERANCE_MM = 1e-7
const nonnegative = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 0)
    throw Error(`${label} must be finite and nonnegative`)
  return value
}

export function fixedPrefixLengthLowerBound(options: {
  nativeFixedLengthMm: number
  fixedPrefixLengthMm: number
  freeEndpoints: readonly [{ x: number; y: number }, { x: number; y: number }]
}) {
  const [a, b] = options.freeEndpoints
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite))
    throw Error("Free endpoints must have finite coordinates")
  const dx = a.x - b.x,
    dy = a.y - b.y
  return (
    nonnegative(options.nativeFixedLengthMm, "Native fixed length") +
    nonnegative(options.fixedPrefixLengthMm, "Fixed prefix length") +
    Math.sqrt(dx * dx + dy * dy)
  )
}

export function normalizeLengthMatchingProblem(problem: LengthMatchingProblem) {
  const names = new Set<string>()
  for (const net of problem.nets) {
    if (!net.name || names.has(net.name))
      throw Error("Net names must be unique")
    names.add(net.name)
    nonnegative(net.currentLengthMm, `${net.name} current length`)
    nonnegative(net.lowerBoundMm, `${net.name} lower bound`)
    if (net.lowerBoundMm > net.currentLengthMm + LENGTH_COMPARISON_TOLERANCE_MM)
      throw Error(`${net.name} lower bound exceeds its current physical length`)
  }
  const constraints: MatchingConstraint[] = []
  for (const [index, bus] of (problem.buses ?? []).entries()) {
    if (
      bus.maxLengthSkew === undefined &&
      bus.minLength === undefined &&
      bus.maxLength === undefined
    )
      continue
    constraints.push({
      id: `bus:${index}:${bus.busId}`,
      kind: "bus",
      names: [...bus.connectionNames],
      minimum: bus.minLength,
      maximum: bus.maxLength,
      tolerance: bus.maxLengthSkew,
    })
  }
  for (const [index, pair] of (problem.differentialPairs ?? []).entries())
    constraints.push({
      id: `pair:${index}`,
      kind: "pair",
      names: [...pair.connectionNames],
      tolerance: pair.lengthTolerance,
    })
  for (const c of constraints) {
    if (
      !c.names.length ||
      new Set(c.names).size !== c.names.length ||
      c.names.some((n) => !names.has(n))
    )
      throw Error(`${c.id} has empty, duplicate, or unknown members`)
    for (const key of ["minimum", "maximum", "tolerance"] as const)
      if (c[key] !== undefined) nonnegative(c[key]!, `${c.id} ${key}`)
    if (
      c.minimum !== undefined &&
      c.maximum !== undefined &&
      c.minimum > c.maximum
    )
      throw Error(`${c.id} minimum exceeds maximum`)
  }
  const bounds: Record<string, { minimum: number; maximum: number }> =
    Object.fromEntries(
      problem.nets.map((net) => [
        net.name,
        {
          minimum: net.fixedLength ? net.currentLengthMm : net.lowerBoundMm,
          maximum: net.fixedLength ? net.currentLengthMm : Infinity,
        },
      ]),
    )
  for (const c of constraints)
    for (const name of c.names) {
      if (problem.nets.find((net) => net.name === name)!.fixedLength) continue
      bounds[name].minimum = Math.max(bounds[name].minimum, c.minimum ?? 0)
      bounds[name].maximum = Math.min(
        bounds[name].maximum,
        c.maximum ?? Infinity,
      )
    }
  return { constraints, bounds }
}

/** Least vector satisfying lower bounds and all overlapping difference bounds. */
export function leastFeasibleLengthTargets(
  problem: LengthMatchingProblem,
  requested: Readonly<Record<string, number>> = {},
):
  | { feasible: true; targets: Record<string, number> }
  | { feasible: false; reason: string } {
  const { constraints, bounds } = normalizeLengthMatchingProblem(problem)
  for (const net of problem.nets)
    if (net.fixedLength)
      for (const c of constraints)
        if (
          c.names.includes(net.name) &&
          (net.currentLengthMm <
            (c.minimum ?? 0) - LENGTH_COMPARISON_TOLERANCE_MM ||
            net.currentLengthMm >
              (c.maximum ?? Infinity) + LENGTH_COMPARISON_TOLERANCE_MM)
        )
          return {
            feasible: false,
            reason: `${net.name} held length violates ${c.id}`,
          }
  const targets: Record<string, number> = Object.fromEntries(
    problem.nets.map((net) => [net.name, 0]),
  )
  for (const name of Object.keys(requested)) {
    if (!Object.hasOwn(bounds, name))
      throw Error(`Unknown requested target ${name}`)
    nonnegative(requested[name], `${name} requested target`)
  }
  for (const net of problem.nets)
    targets[net.name] = Math.max(
      bounds[net.name].minimum,
      Object.hasOwn(requested, net.name) ? requested[net.name] : 0,
    )
  for (let pass = 0; pass <= problem.nets.length; pass++) {
    for (const net of problem.nets)
      if (
        targets[net.name] >
        bounds[net.name].maximum + LENGTH_COMPARISON_TOLERANCE_MM
      )
        return {
          feasible: false,
          reason: `${net.name} requires ${targets[net.name]} mm above cap ${bounds[net.name].maximum} mm`,
        }
    let changed = false
    for (const c of constraints) {
      if (c.tolerance === undefined) continue
      const floor = Math.max(...c.names.map((n) => targets[n])) - c.tolerance
      for (const name of c.names) {
        // Preserve a complete held rail at native floating-point boundaries.
        const next =
          floor <= bounds[name].maximum + LENGTH_COMPARISON_TOLERANCE_MM
            ? Math.min(
                floor,
                Math.max(bounds[name].minimum, bounds[name].maximum),
              )
            : floor
        if (targets[name] < next - 1e-12) {
          targets[name] = next
          changed = true
        }
      }
    }
    if (!changed) return { feasible: true, targets }
  }
  throw Error("Length constraint propagation did not converge")
}

/** Bounded anchor families; never a Cartesian product of bus target windows. */
export function deriveLengthMatchingTargets(
  problem: LengthMatchingProblem,
  options: { maximumPlans?: number } = {},
): LengthTargetPortfolio {
  const maximumPlans = options.maximumPlans ?? 16
  if (!Number.isInteger(maximumPlans) || maximumPlans < 1 || maximumPlans > 128)
    throw Error("maximumPlans must be an integer from 1 through 128")
  const { constraints, bounds } = normalizeLengthMatchingProblem(problem)
  const timed = new Set(constraints.flatMap((c) => c.names))
  const current = Object.fromEntries(
    problem.nets.map((n) => [n.name, n.currentLengthMm]),
  )
  const seeds: Array<{ id: string; requested: Record<string, number> }> = [
    { id: "least-length-bound", requested: {} },
    { id: "non-shortening", requested: current },
  ]
  for (const c of constraints)
    seeds.push({
      id: `shorten:${c.id}`,
      requested: Object.fromEntries(
        problem.nets.map((net) => [
          net.name,
          c.names.includes(net.name)
            ? bounds[net.name].minimum
            : net.currentLengthMm,
        ]),
      ),
    })
  for (const net of [...problem.nets]
    .filter((n) => timed.has(n.name) && !n.fixedLength)
    .sort(
      (a, b) =>
        b.currentLengthMm -
        b.lowerBoundMm -
        (a.currentLengthMm - a.lowerBoundMm),
    ))
    seeds.push({
      id: `shorten:${net.name}`,
      requested: { ...current, [net.name]: bounds[net.name].minimum },
    })
  const plans: LengthTargetPlan[] = [],
    failures: LengthTargetPortfolio["failures"] = [],
    signatures = new Set<string>()
  for (const seed of seeds) {
    if (plans.length >= maximumPlans) break
    const solved = leastFeasibleLengthTargets(problem, seed.requested)
    if (!solved.feasible) {
      failures.push({ id: seed.id, reason: solved.reason })
      continue
    }
    const numericBands = Object.fromEntries(
      [...timed].map((name) => [name, { ...bounds[name] }]),
    )
    const constraintWindows: Record<string, LengthBand> = {}
    for (const c of constraints) {
      const maximum =
        c.tolerance === undefined
          ? (c.maximum ?? Infinity)
          : Math.max(...c.names.map((n) => solved.targets[n]))
      const minimum =
        c.tolerance === undefined
          ? (c.minimum ?? 0)
          : Math.max(
              c.minimum ?? 0,
              Math.min(
                maximum - c.tolerance,
                Math.min(...c.names.map((n) => solved.targets[n])),
              ),
            )
      const upper = Math.min(maximum, c.maximum ?? Infinity)
      constraintWindows[c.id] = {
        minimum,
        maximum: Number.isFinite(upper) ? upper : null,
      }
      for (const name of c.names) {
        numericBands[name].minimum = Math.max(
          numericBands[name].minimum,
          constraintWindows[c.id].minimum,
        )
        numericBands[name].maximum = Math.min(
          numericBands[name].maximum,
          constraintWindows[c.id].maximum ?? Infinity,
        )
      }
    }
    const bands: Record<string, LengthBand> = Object.fromEntries(
      Object.entries(numericBands).map(([name, band]) => {
        if (band.minimum > band.maximum + LENGTH_COMPARISON_TOLERANCE_MM)
          throw Error(`${name} has an inconsistent propagated target band`)
        const net = problem.nets.find((net) => net.name === name)!
        if (net.fixedLength)
          return [
            name,
            { minimum: net.currentLengthMm, maximum: net.currentLengthMm },
          ]
        return [
          name,
          {
            minimum: band.minimum,
            maximum: Number.isFinite(band.maximum)
              ? Math.max(band.minimum, band.maximum)
              : null,
          },
        ]
      }),
    )
    const signature = JSON.stringify(Object.entries(bands))
    if (signatures.has(signature)) continue
    signatures.add(signature)
    plans.push({
      id: seed.id,
      targets: solved.targets,
      bands,
      constraintWindows,
      shorteningNames: problem.nets
        .filter(
          (n) =>
            timed.has(n.name) &&
            n.currentLengthMm >
              (bands[n.name].maximum ?? Infinity) +
                LENGTH_COMPARISON_TOLERANCE_MM,
        )
        .map((n) => n.name),
      lengthDomainFeasible: true,
      geometricFeasibilityEstablished: false,
    })
  }
  const least = leastFeasibleLengthTargets(problem)
  return {
    plans,
    timedNames: problem.nets
      .filter((n) => timed.has(n.name))
      .map((n) => n.name),
    untimedNames: problem.nets
      .filter((n) => !timed.has(n.name))
      .map((n) => n.name),
    failures,
    constraints,
    shorteningPotential: constraints.map((c) => {
      const currentMaximumMm = Math.max(...c.names.map((n) => current[n]))
      const leastFeasibleMaximumMm = least.feasible
        ? Math.max(...c.names.map((n) => least.targets[n]))
        : null
      return {
        constraintId: c.id,
        currentMaximumMm,
        leastFeasibleMaximumMm,
        potentialReductionMm:
          leastFeasibleMaximumMm === null
            ? null
            : Math.max(0, currentMaximumMm - leastFeasibleMaximumMm),
      }
    }),
    fixedPortfolio: true,
    geometricFeasibilityEstablished: false,
  }
}
