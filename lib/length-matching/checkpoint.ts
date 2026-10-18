import {
  compareLengthMatchingScores,
  evaluateLengthMatchingState,
  type LengthMatchingEvaluation,
  type MatchingMeasurement,
} from "./objective"
import type { LengthMatchingProblem, LengthTargetPortfolio } from "./targets"

export interface MatchingPhysicalValidation {
  physicalValid: boolean
  complete: boolean
  fixedEscapesExact: boolean
  /** If provided, the unchanged native timing oracle must also pass to stop. */
  timingValid?: boolean
}
export interface MatchingCheckpointOptions<State> {
  problem: LengthMatchingProblem
  portfolio: LengthTargetPortfolio
  measure: (state: State) => MatchingMeasurement
  validate: (state: State) => MatchingPhysicalValidation
  /** Exact state bytes/hash: must include all copper and fixed path metadata. */
  fingerprint: (state: State) => string
  netFingerprint: (state: State, name: string) => string
  clock?: () => number
}
export interface MatchingTransactionResult<State> {
  accepted: boolean
  reason:
    | "improved"
    | "not-improved"
    | "invalid"
    | "timeout"
    | "exception"
    | "mutation"
    | "no-candidate"
    | "untimed-changed"
    | "fixed-net-changed"
  best: State
  evaluation: LengthMatchingEvaluation
  error?: string
}

/** Caller callbacks see isolated clones. A rejected transaction never edits best. */
export class LengthMatchingCheckpoint<State> {
  private readonly baseline: State
  private best: State
  private evaluation: LengthMatchingEvaluation
  private readonly problem: LengthMatchingProblem
  private readonly portfolio: LengthTargetPortfolio
  private readonly clock: () => number
  private readonly history: Array<{
    accepted: boolean
    reason: string
    score: number[]
  }> = []
  private readonly untimed = new Map<string, string>()
  private readonly held = new Map<string, string>()
  private readonly options: MatchingCheckpointOptions<State>
  constructor(baseline: State, options: MatchingCheckpointOptions<State>) {
    this.options = { ...options }
    this.baseline = structuredClone(baseline)
    this.best = structuredClone(baseline)
    this.problem = structuredClone(options.problem)
    this.portfolio = structuredClone(options.portfolio)
    this.clock = options.clock ?? (() => performance.now())
    for (const name of this.portfolio.untimedNames)
      this.untimed.set(
        name,
        options.netFingerprint(structuredClone(this.best), name),
      )
    for (const net of this.problem.nets)
      if (net.fixedLength)
        this.held.set(
          net.name,
          options.netFingerprint(structuredClone(this.best), net.name),
        )
    const checked = this.check(this.best)
    if (!checked.valid)
      throw Error(
        `Baseline is not a complete physical checkpoint: ${checked.reason}`,
      )
    this.evaluation = checked.evaluation!
  }
  private check(state: State) {
    const candidate = structuredClone(state),
      key = this.options.fingerprint(candidate)
    const validation = this.options.validate(candidate)
    if (key !== this.options.fingerprint(candidate))
      return { valid: false, reason: "mutation" as const }
    if (
      !validation.physicalValid ||
      !validation.complete ||
      !validation.fixedEscapesExact
    )
      return { valid: false, reason: "invalid" as const }
    const measurement = this.options.measure(candidate)
    if (key !== this.options.fingerprint(candidate))
      return { valid: false, reason: "mutation" as const }
    return {
      valid: true,
      reason: "improved" as const,
      evaluation: evaluateLengthMatchingState(
        this.problem,
        this.portfolio,
        measurement,
        { nativeTimingValid: validation.timingValid },
      ),
    }
  }
  private result(
    accepted: boolean,
    reason: MatchingTransactionResult<State>["reason"],
    error?: string,
  ): MatchingTransactionResult<State> {
    this.history.push({ accepted, reason, score: [...this.evaluation.score] })
    return {
      accepted,
      reason,
      best: structuredClone(this.best),
      evaluation: structuredClone(this.evaluation),
      ...(error ? { error } : {}),
    }
  }
  consider(
    candidate: State,
    options: {
      deadlineMs?: number
      allowUntimedPhysicalReroute?: boolean
    } = {},
  ) {
    const expired = () =>
      options.deadlineMs !== undefined && this.clock() >= options.deadlineMs
    try {
      if (expired()) return this.result(false, "timeout")
      const isolated = structuredClone(candidate)
      for (const [name, key] of this.held)
        if (
          this.options.netFingerprint(structuredClone(isolated), name) !== key
        )
          return this.result(false, "fixed-net-changed")
      if (!options.allowUntimedPhysicalReroute)
        for (const [name, key] of this.untimed)
          if (
            this.options.netFingerprint(structuredClone(isolated), name) !== key
          )
            return this.result(false, "untimed-changed")
      const checked = this.check(isolated)
      if (expired()) return this.result(false, "timeout")
      if (!checked.valid) return this.result(false, checked.reason)
      if (
        compareLengthMatchingScores(
          checked.evaluation!.score,
          this.evaluation.score,
        ) >= 0
      )
        return this.result(false, "not-improved")
      const nextBest = structuredClone(isolated)
      const nextEvaluation = structuredClone(checked.evaluation!)
      const nextUntimed = [...this.untimed.keys()].map(
        (name) =>
          [
            name,
            this.options.netFingerprint(structuredClone(nextBest), name),
          ] as const,
      )
      if (expired()) return this.result(false, "timeout")
      this.best = nextBest
      this.evaluation = nextEvaluation
      for (const [name, key] of nextUntimed) this.untimed.set(name, key)
      return this.result(true, "improved")
    } catch (error) {
      return this.result(
        false,
        "exception",
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  transaction(
    propose: (best: State) => State | null,
    options: {
      deadlineMs?: number
      allowUntimedPhysicalReroute?: boolean
    } = {},
  ) {
    try {
      if (
        options.deadlineMs !== undefined &&
        this.clock() >= options.deadlineMs
      )
        return this.result(false, "timeout")
      const candidate = propose(structuredClone(this.best))
      if (!candidate) return this.result(false, "no-candidate")
      return this.consider(candidate, options)
    } catch (error) {
      return this.result(
        false,
        "exception",
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  snapshot() {
    return {
      baseline: structuredClone(this.baseline),
      best: structuredClone(this.best),
      evaluation: structuredClone(this.evaluation),
      portfolio: structuredClone(this.portfolio),
      history: structuredClone(this.history),
    }
  }
}
