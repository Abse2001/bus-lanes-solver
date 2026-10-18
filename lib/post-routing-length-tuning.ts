import { findFixedPathRanges } from "./fixed-route-paths"
import { distance, length } from "./geometry"
import { LengthMatchingCheckpoint } from "./length-matching/checkpoint"
import {
  compareLengthMatchingScores,
  type LengthMatchingEvaluation,
  type MatchingMeasurement,
} from "./length-matching/objective"
import {
  deriveLengthMatchingTargets,
  type LengthMatchingProblem,
  type LengthTargetPlan,
  type LengthTargetPortfolio,
} from "./length-matching/targets"
import {
  physicalRoutingAcceptance,
  type PhysicalRoutingAcceptanceReport,
} from "./physical-routing-acceptance"
import { fixedRouteLength } from "./route-lengths"
import { defaultPostRoutingLengthProposalFactories } from "./post-routing-length-proposals"
import type { SimpleRouteJson, Trace } from "./types"

export interface PostRoutingLengthProposal {
  /** Whole joined replacements. All omitted connections retain their copper. */
  replacements: readonly Trace[]
  operator?: string
}

export interface PostRoutingLengthContext {
  input: SimpleRouteJson
  traces: Trace[]
  fixedEscapes: Trace[]
  plan: LengthTargetPlan
  deadlineMs: number
  maximumCandidates: number
}

/** Yield undefined while searching so the parent can enforce its work budget. */
export type PostRoutingLengthProposalFactory = (
  context: PostRoutingLengthContext,
) => Generator<PostRoutingLengthProposal | undefined, void, unknown>

export interface PostRoutingLengthTuningOptions {
  fixedEscapes?: readonly Trace[]
  timeBudgetMs?: number
  maximumSteps?: number
  maximumPasses?: number
  maximumPlans?: number
  maximumCandidatesPerOperator?: number
  /** Bound one operator so blocked owners cannot consume the whole search. */
  maximumOperatorTimeMs?: number
  /** Additional proposal operators share the same physical and checkpoint gates. */
  proposalFactories?: readonly PostRoutingLengthProposalFactory[]
}

export interface PostRoutingLengthProgress {
  stage: "search" | "checkpoint"
  pass: number
  planId: string
  steps: number
  acceptedCandidates: number
  checkedCandidates: number
  timingSolved: boolean
  outOfBandSignals: number
  totalLengthErrorMm: number
  operator?: string
  decision?: "best" | "trial" | "rejected"
  rejectionReason?: string
}

export interface PostRoutingLengthTuningResult {
  output: SimpleRouteJson
  physicalRoutingAccepted: true
  timingSolved: boolean
  reason: "matched" | "stalled" | "budget" | "interrupted" | "exception"
  baselineEvaluation: LengthMatchingEvaluation
  evaluation: LengthMatchingEvaluation
  portfolio: LengthTargetPortfolio
  acceptance: PhysicalRoutingAcceptanceReport
  statistics: {
    steps: number
    passes: number
    checkedCandidates: number
    acceptedCandidates: number
    rejectedCandidates: number
    trialAcceptedCandidates: number
    elapsedMilliseconds: number
  }
  errors: string[]
}

/** Canonical comparison changes object-key order only, never geometry. */
function exactJson(value: unknown): string {
  if (typeof value === "number")
    return Object.is(value, -0) ? "-0" : String(value)
  if (Array.isArray(value)) return `[${value.map(exactJson).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${exactJson(field)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}

function measure(input: SimpleRouteJson, traces: Trace[]): MatchingMeasurement {
  return {
    fullLengthsMm: Object.fromEntries(
      traces.map((trace) => [
        trace.connection_name!,
        length(trace.route) + fixedRouteLength(input, trace.connection_name!),
      ]),
    ),
    totalWireLengthMm: [...(input.traces ?? []), ...traces].reduce(
      (sum, trace) => sum + length(trace.route),
      0,
    ),
    viaCount: [...(input.traces ?? []), ...traces].reduce(
      (sum, trace) =>
        sum + trace.route.filter((point) => point.route_type === "via").length,
      0,
    ),
  }
}

/** Count immutable edges once and use a straight-line bound for each free gap. */
export function routedLengthMatchingProblem(
  input: SimpleRouteJson,
  traces: readonly Trace[],
  fixedEscapes: readonly Trace[] = [],
): LengthMatchingProblem {
  return {
    nets: traces.map((trace) => {
      const ranges = findFixedPathRanges(trace, fixedEscapes)
      if (!ranges)
        throw Error(`Missing fixed path for ${trace.connection_name}`)
      const protectedEdges = new Set<number>()
      for (const range of ranges)
        for (let index = range.start + 1; index <= range.end; index++)
          protectedEdges.add(index)
      const points = [
        { start: 0, end: 0 },
        ...ranges,
        { start: trace.route.length - 1, end: trace.route.length - 1 },
      ].sort((a, b) => a.start - b.start || a.end - b.end)
      const merged: Array<{ start: number; end: number }> = []
      for (const range of points) {
        const previous = merged.at(-1)
        if (previous && range.start <= previous.end)
          previous.end = Math.max(previous.end, range.end)
        else merged.push({ ...range })
      }
      const nativeFixed = fixedRouteLength(input, trace.connection_name!)
      let lowerBound = nativeFixed
      for (const end of protectedEdges)
        lowerBound += distance(trace.route[end - 1], trace.route[end])
      for (let index = 1; index < merged.length; index++)
        lowerBound += distance(
          trace.route[merged[index - 1].end],
          trace.route[merged[index].start],
        )
      const current = nativeFixed + length(trace.route)
      if (lowerBound > current + 1e-7)
        throw Error(`Fixed-path length bound exceeds ${trace.connection_name}`)
      return {
        name: trace.connection_name!,
        currentLengthMm: current,
        lowerBoundMm: Math.min(current, lowerBound),
        fixedLength: protectedEdges.size === trace.route.length - 1,
      }
    }),
    buses: structuredClone(input.buses),
    differentialPairs: structuredClone(input.differentialPairs),
  }
}

function planError(
  input: SimpleRouteJson,
  traces: Trace[],
  plan: LengthTargetPlan,
): readonly [number, number] {
  const lengths = measure(input, traces).fullLengthsMm
  let count = 0
  let error = 0
  for (const [name, band] of Object.entries(plan.bands)) {
    const delta = Math.max(
      band.minimum - lengths[name],
      lengths[name] - (band.maximum ?? Infinity),
      0,
    )
    if (delta > 1e-7) {
      count++
      error += delta
    }
  }
  return [count, error]
}

/** Tune an already complete physical layout. Every exit returns the best
 * complete, verified checkpoint; timing success is a separate explicit field.
 * Even generator.return() closes the child and returns that safe checkpoint. */
export function* postProcessRoutedLengths(
  originalInput: SimpleRouteJson,
  originalOutput: SimpleRouteJson,
  options: PostRoutingLengthTuningOptions = {},
): Generator<
  PostRoutingLengthProgress,
  PostRoutingLengthTuningResult,
  unknown
> {
  const input = structuredClone(originalInput)
  const output = structuredClone(originalOutput)
  const fixedEscapes = structuredClone([...(options.fixedEscapes ?? [])])
  const started = performance.now()
  const timeBudget = options.timeBudgetMs ?? 60000
  const maximumSteps = options.maximumSteps ?? 200000
  const maximumPasses = options.maximumPasses ?? 4
  const maximumCandidates = options.maximumCandidatesPerOperator ?? 8
  const maximumOperatorTime = options.maximumOperatorTimeMs ?? 5000
  if (
    !Number.isFinite(timeBudget) ||
    timeBudget < 0 ||
    !Number.isFinite(maximumOperatorTime) ||
    maximumOperatorTime < 0 ||
    [maximumSteps, maximumPasses, maximumCandidates].some(
      (value) => !Number.isInteger(value) || value < 0,
    )
  )
    throw Error("Length tuning budgets must be finite nonnegative values")
  if (
    exactJson({ ...input, traces: undefined }) !==
    exactJson({ ...output, traces: undefined })
  )
    throw Error(
      "Post-routing tuning requires unchanged original board geometry",
    )
  const nativeCount = input.traces?.length ?? 0
  if (
    exactJson((output.traces ?? []).slice(0, nativeCount)) !==
    exactJson(input.traces ?? [])
  )
    throw Error("Post-routing tuning requires exact original fixed copper")
  const baseline = (output.traces ?? []).slice(nativeCount)
  const baselineAcceptance = physicalRoutingAcceptance(input, baseline, {
    escapes: fixedEscapes,
  })
  if (!baselineAcceptance.physicalRoutingAccepted)
    throw Error(
      "Post-routing tuning requires complete DRC-clean native routing",
    )
  const problem = routedLengthMatchingProblem(input, baseline, fixedEscapes)
  const portfolio = deriveLengthMatchingTargets(problem, {
    maximumPlans: options.maximumPlans,
  })
  const reports = new Map<string, PhysicalRoutingAcceptanceReport>()
  reports.set(exactJson(baseline), baselineAcceptance)
  const audit = (traces: Trace[]) => {
    const key = exactJson(traces)
    const cached = reports.get(key)
    if (cached) return cached
    const report = physicalRoutingAcceptance(input, traces, {
      escapes: fixedEscapes,
    })
    // Keep bounded validation history; the current best can always be rechecked.
    if (reports.size >= 16) reports.delete(reports.keys().next().value!)
    reports.set(key, report)
    return report
  }
  const checkpoint = new LengthMatchingCheckpoint(baseline, {
    problem,
    portfolio,
    measure: (traces) => measure(input, traces),
    fingerprint: exactJson,
    netFingerprint: (traces, name) =>
      exactJson(traces.filter((trace) => trace.connection_name === name)),
    validate: (traces) => {
      const report = audit(traces)
      return {
        physicalValid: report.physicalRoutingAccepted,
        complete: report.gates.complete,
        fixedEscapesExact: report.escapesPreserved,
        timingValid: report.ddrTimingAccepted,
      }
    },
  })
  const baselineEvaluation = checkpoint.snapshot().evaluation
  const untimed = new Map(
    portfolio.untimedNames.map((name) => [
      name,
      exactJson(baseline.filter((trace) => trace.connection_name === name)),
    ]),
  )
  const deadline = performance.now() + timeBudget
  const errors: string[] = []
  let reason: PostRoutingLengthTuningResult["reason"] = "interrupted"
  let steps = 0
  let passes = 0
  let checkedCandidates = 0
  let acceptedCandidates = 0
  let rejectedCandidates = 0
  let trialAcceptedCandidates = 0
  let lastDecision: Pick<
    PostRoutingLengthProgress,
    "operator" | "decision" | "rejectionReason"
  > = {}
  let active: ReturnType<PostRoutingLengthProposalFactory> | undefined
  let finished = false
  const expired = () =>
    steps >= maximumSteps ||
    maximumCandidates === 0 ||
    performance.now() >= deadline
  const progress = (
    stage: PostRoutingLengthProgress["stage"],
    planId: string,
  ): PostRoutingLengthProgress => {
    const evaluation = checkpoint.snapshot().evaluation
    return {
      stage,
      pass: passes,
      planId,
      steps,
      checkedCandidates,
      acceptedCandidates,
      timingSolved: evaluation.timingSolved,
      outOfBandSignals: evaluation.outOfBandNames.length,
      totalLengthErrorMm: evaluation.sumBandErrorMm,
      ...lastDecision,
    }
  }
  try {
    search: for (; passes < maximumPasses; passes++) {
      if (checkpoint.snapshot().evaluation.timingSolved) {
        reason = "matched"
        break
      }
      if (expired()) {
        reason = "budget"
        break
      }
      const before = checkpoint.snapshot().evaluation.score
      const bestPlanId = checkpoint.snapshot().evaluation.targetPlanId
      const plans = [...portfolio.plans].sort(
        (a, b) => Number(b.id === bestPlanId) - Number(a.id === bestPlanId),
      )
      for (const plan of plans) {
        // Trial branches may cross worse timing states, but only verified
        // improvements ever replace the externally returned best checkpoint.
        let trial = checkpoint.snapshot().best
        for (const factory of options.proposalFactories ??
          defaultPostRoutingLengthProposalFactories(input)) {
          let candidates = 0
          const operatorDeadline = Math.min(
            deadline,
            performance.now() + maximumOperatorTime,
          )
          lastDecision = {}
          try {
            active = factory({
              input: structuredClone(input),
              traces: structuredClone(trial),
              fixedEscapes: structuredClone(fixedEscapes),
              plan: structuredClone(plan),
              deadlineMs: operatorDeadline,
              maximumCandidates,
            })
            while (true) {
              if (expired()) {
                reason = "budget"
                break search
              }
              if (performance.now() >= operatorDeadline) break
              const next = active.next()
              steps++
              if (next.done) break
              if (!next.value) {
                yield progress("search", plan.id)
                continue
              }
              checkedCandidates++
              const proposal = next.value
              lastDecision = { operator: proposal.operator }
              const replacements = new Map<string, Trace>()
              let validOwners = true
              for (const trace of proposal.replacements) {
                const name = trace.connection_name
                const previous = trial.find(
                  (current) => current.connection_name === name,
                )
                const sameEnds =
                  previous &&
                  ((exactJson(previous.route[0]) ===
                    exactJson(trace.route[0]) &&
                    exactJson(previous.route.at(-1)) ===
                      exactJson(trace.route.at(-1))) ||
                    (exactJson(previous.route[0]) ===
                      exactJson(trace.route.at(-1)) &&
                      exactJson(previous.route.at(-1)) ===
                        exactJson(trace.route[0])))
                if (
                  !name ||
                  replacements.has(name) ||
                  !previous ||
                  !sameEnds ||
                  trace.pcb_trace_id !== previous.pcb_trace_id ||
                  trace.source_trace_id !== previous.source_trace_id
                ) {
                  validOwners = false
                  break
                }
                replacements.set(name, structuredClone(trace))
              }
              const candidate = trial.map(
                (trace) => replacements.get(trace.connection_name!) ?? trace,
              )
              const untimedChanged = [...untimed].some(
                ([name, key]) =>
                  exactJson(
                    candidate.filter((trace) => trace.connection_name === name),
                  ) !== key,
              )
              const report =
                validOwners && !untimedChanged ? audit(candidate) : null
              const improvesPlan =
                report?.physicalRoutingAccepted &&
                compareLengthMatchingScores(
                  planError(input, candidate, plan),
                  planError(input, trial, plan),
                ) < 0
              if (
                !report?.physicalRoutingAccepted ||
                expired() ||
                (!improvesPlan && !report.ddrTimingAccepted)
              ) {
                rejectedCandidates++
                lastDecision = {
                  ...lastDecision,
                  decision: "rejected",
                  rejectionReason: !validOwners
                    ? "owner-or-endpoint-changed"
                    : untimedChanged
                      ? "untimed-copper-changed"
                      : !report?.physicalRoutingAccepted
                        ? "physical-rejection"
                        : expired()
                          ? "budget"
                          : "no-plan-improvement",
                }
              } else {
                trial = structuredClone(candidate)
                trialAcceptedCandidates++
                const transaction = checkpoint.consider(candidate, {
                  deadlineMs: deadline,
                })
                if (transaction.accepted) acceptedCandidates++
                else rejectedCandidates++
                lastDecision = {
                  ...lastDecision,
                  decision: transaction.accepted ? "best" : "trial",
                }
                if (transaction.evaluation.timingSolved) {
                  reason = "matched"
                  yield progress("checkpoint", plan.id)
                  break search
                }
              }
              yield progress("checkpoint", plan.id)
              if (++candidates >= maximumCandidates) break
            }
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          } finally {
            try {
              active?.return()
            } catch (error) {
              errors.push(String(error))
            }
            active = undefined
          }
        }
      }
      if (
        compareLengthMatchingScores(
          checkpoint.snapshot().evaluation.score,
          before,
        ) >= 0
      ) {
        reason = errors.length ? "exception" : "stalled"
        break
      }
      reason = "budget"
    }
    if (maximumPasses === 0) reason = "budget"
    finished = true
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    reason = "exception"
    finished = true
  } finally {
    try {
      active?.return()
    } catch (error) {
      errors.push(String(error))
    }
    const best = checkpoint.snapshot()
    if (!finished && !best.evaluation.timingSolved) reason = "interrupted"
    const acceptance = audit(best.best)
    return {
      output: structuredClone(acceptance.output),
      physicalRoutingAccepted: true,
      timingSolved: best.evaluation.timingSolved,
      reason: best.evaluation.timingSolved ? "matched" : reason,
      baselineEvaluation: structuredClone(baselineEvaluation),
      evaluation: best.evaluation,
      portfolio: best.portfolio,
      acceptance: structuredClone(acceptance),
      statistics: {
        steps,
        passes,
        checkedCandidates,
        acceptedCandidates,
        rejectedCandidates,
        trialAcceptedCandidates,
        elapsedMilliseconds: performance.now() - started,
      },
      errors,
    }
  }
}
