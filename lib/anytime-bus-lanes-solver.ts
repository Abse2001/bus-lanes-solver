import {
  BusLanesPipelineSolver,
  type BusLanesPipelineOptions,
} from "./bus-lanes-pipeline-solver"
import { BusLanesSolver } from "./bus-lanes-solver"
import { anytimeTransactionCandidates } from "./anytime-transaction-search"
import { separateAnytimeCarriers } from "./anytime-carriers"
import {
  scoreAnytimeRoutes,
  defaultAnytimeScoreWeights,
  type AnytimeScore,
  type AnytimeScoreWeights,
} from "./anytime-score"
import { distance } from "./geometry"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { CopperConflictIndex } from "./copper-conflict-index"
import { tuningPathIsSelfClear } from "./length-tuning"
import { routeCopper } from "./vector-scene"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import {
  getCopperLayerNames,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import type { SimpleRouteJson, Trace, Wire } from "./types"

export type AnytimeEffort = 1 | 2 | 5 | "1x" | "2x" | "5x"
export interface AnytimeBusLanesOptions extends BusLanesPipelineOptions {
  effort?: AnytimeEffort
  /** Candidate attempts per unit of optimization effort, after finding a route. */
  iterationsPerX?: number
  weights?: Partial<AnytimeScoreWeights>
}
export interface AnytimeViolation {
  code: string
  message: string
}
export interface AnytimeResult {
  status: "valid" | "best_effort"
  output: SimpleRouteJson
  score: AnytimeScore
  violations: AnytimeViolation[]
  iterations: number
  optimizationIterations: number
  acceptedImprovements: number
  exhausted: boolean
}

const effortValue = (effort: AnytimeEffort) => {
  if (![1, 2, 5, "1x", "2x", "5x"].includes(effort))
    throw Error("Effort must be 1x, 2x or 5x")
  return typeof effort === "number" ? effort : Number.parseInt(effort, 10)
}

/** Deterministic anytime search. Connectivity/clearance/matching outrank the
 * weighted objective; a validated incumbent can never be replaced by a fallback.
 * `solved` means a valid incumbent exists, `exhausted` means the current work
 * budget is finished. Calling improve(2/5) continues the very same search. */
export class AnytimeBusLanesSolver {
  readonly input: SimpleRouteJson
  readonly options: AnytimeBusLanesOptions
  readonly weights: AnytimeScoreWeights
  iterations = 0
  optimizationIterations = 0
  acceptedImprovements = 0
  solved = false
  readonly failed = false
  error: string | null = null
  phase = "route"
  exhausted = false
  private incumbent: Trace[]
  private incumbentScore: AnytimeScore
  private violations: AnytimeViolation[] = [
    {
      code: "unvalidated_fallback",
      message:
        "Provisional endpoint connections; clearance, layers and length matching have not been established.",
    },
  ]
  private baseline: BusLanesPipelineSolver | BusLanesSolver
  private baselineFinished = false
  private routingEffort = 1
  private requestedEffort: number
  private budget: number
  private candidates?: Generator<Trace[] | undefined>
  private validation?: BusLanesSolver
  private pending?: { traces: Trace[]; score: AnytimeScore }
  private proposalStats = {
    proposals: 0,
    objectiveRejected: 0,
    matchingRejected: 0,
    validationRejected: 0,
  }
  private lastValidationFailure: string | null = null
  private pairGapFloors?: Map<string, number>
  private carrierAuditContext?: {
    incumbent: Trace[]
    context: ReturnType<typeof separateAnytimeCarriers>
  }
  private revisions: Array<{
    optimizationIterations: number
    score: AnytimeScore
  }> = []

  constructor(input: SimpleRouteJson, options: AnytimeBusLanesOptions = {}) {
    this.input = structuredClone(input)
    this.options = {
      fanout: "auto",
      ...options,
      effort: options.effort ?? 1,
      iterationsPerX: options.iterationsPerX ?? 512,
    }
    if (
      !Number.isInteger(this.options.iterationsPerX) ||
      this.options.iterationsPerX! < 1
    )
      throw Error("iterationsPerX must be a positive integer")
    this.weights = { ...defaultAnytimeScoreWeights, ...options.weights }
    if (
      Object.values(this.weights).some((w) => !Number.isFinite(w) || w < 0) ||
      !Object.values(this.weights).some((w) => w > 0)
    )
      throw Error("Score weights must be finite, nonnegative and not all zero")
    this.budget = this.effortBudget(this.options.effort!)
    this.requestedEffort = effortValue(this.options.effort!)
    this.incumbent = this.input.connections.map((c, i) => {
      const bus = this.input.buses?.find((b) =>
        b.connectionNames.includes(c.name),
      )
      const width =
        bus?.traceWidth ??
        c.nominalTraceWidth ??
        c.width ??
        this.input.minTraceWidth
      return {
        type: "pcb_trace",
        pcb_trace_id: `anytime_provisional_${i}`,
        connection_name: c.name,
        source_trace_id: c.source_trace_id ?? c.name,
        route: c.pointsToConnect.map((p) => ({
          route_type: "wire",
          x: p.x,
          y: p.y,
          layer: p.layer,
          width,
        })),
      }
    })
    this.incumbentScore = scoreAnytimeRoutes(
      this.input,
      this.incumbent,
      this.weights,
    )
    this.baseline = this.makeBaseline()
  }

  private makeBaseline() {
    const options = { ...this.options }
    if (options.maxSearchIterations !== undefined)
      options.maxSearchIterations *= this.routingEffort
    const solver =
      this.options.fanout === "auto"
        ? new BusLanesPipelineSolver(this.input, options)
        : new BusLanesSolver(this.input, {
            smoothTuning: true,
            denseSearch: true,
            ...options,
          })
    // Preserve the pipeline's shared, adaptive child budget when the caller
    // uses defaults. Passing an explicit default would cap every child early.
    if (options.maxSearchIterations === undefined)
      solver.MAX_ITERATIONS *= this.routingEffort
    return solver
  }

  private retryRouting() {
    const next = [1, 2, 5].find(
      (e) => e > this.routingEffort && e <= this.requestedEffort,
    )
    if (!next) return false
    this.routingEffort = next
    this.baseline = this.makeBaseline()
    this.baselineFinished = false
    this.exhausted = false
    this.error = null
    this.phase = "route"
    return true
  }

  /** Start a new optimization experiment from completed, independently checked
   * copper. Seed validation includes the original pads and local escapes. */
  static fromCompleted(
    input: SimpleRouteJson,
    traces: Trace[],
    options: AnytimeBusLanesOptions = {},
  ) {
    const solver = new AnytimeBusLanesSolver(input, options)
    const layers = getCopperLayerNames(input.layerCount)
    for (const trace of [...(input.traces ?? []), ...traces]) {
      for (const p of trace.route) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
          throw Error("Completed seed has nonfinite geometry")
        if (p.route_type === "wire") {
          if (
            !Number.isFinite(p.width) ||
            p.width <= 0 ||
            !layers.includes(p.layer)
          )
            throw Error("Completed seed has invalid wire width or layer")
        } else if (p.route_type === "via") {
          if (
            !layers.includes(p.from_layer) ||
            !layers.includes(p.to_layer) ||
            p.layers?.some((layer) => !layers.includes(layer)) ||
            [p.via_diameter, p.via_hole_diameter].some(
              (d) => d !== undefined && (!Number.isFinite(d) || d <= 0),
            ) ||
            (p.via_diameter !== undefined &&
              p.via_hole_diameter !== undefined &&
              p.via_hole_diameter >= p.via_diameter)
          )
            throw Error("Completed seed has invalid via dimensions or layers")
        } else throw Error("Completed seed has unsupported copper primitives")
      }
    }
    if (
      traces.length !== input.connections.length ||
      input.connections.some((c) => {
        const found = traces.filter((t) => t.connection_name === c.name)
        if (found.length !== 1) return true
        const route = found[0].route
        const first = route[0],
          last = route.at(-1)!
        return (
          route.length < 2 ||
          first.route_type !== "wire" ||
          last.route_type !== "wire" ||
          !(
            c.pointsToConnect[0].layers ?? [c.pointsToConnect[0].layer]
          ).includes(first.layer) ||
          !(
            c.pointsToConnect[1].layers ?? [c.pointsToConnect[1].layer]
          ).includes(last.layer) ||
          distance(first, c.pointsToConnect[0]) > 1e-8 ||
          distance(last, c.pointsToConnect[1]) > 1e-8
        )
      })
    )
      throw Error(
        "Completed seed must connect every original terminal exactly once",
      )
    for (const trace of traces) {
      for (const [index, p] of trace.route.entries()) {
        const radius =
          p.route_type === "wire"
            ? p.width / 2
            : (p.via_diameter ?? input.minViaPadDiameter ?? 0.3) / 2
        const margin = radius + (input.minBoardEdgeClearance ?? 0)
        const bounds = input.bounds
        if (
          !Number.isFinite(margin) ||
          p.x < bounds.minX + margin - 1e-9 ||
          p.x > bounds.maxX - margin + 1e-9 ||
          p.y < bounds.minY + margin - 1e-9 ||
          p.y > bounds.maxY - margin + 1e-9
        )
          throw Error("Completed seed violates board-edge clearance")
        if (index === 0) continue
        const previous = trace.route[index - 1]
        if (
          (previous.route_type === "wire" && p.route_type === "wire"
            ? previous.layer !== p.layer
            : previous.route_type === "wire" && p.route_type === "via"
              ? previous.layer !== p.from_layer || distance(previous, p) > 1e-8
              : previous.route_type === "via" && p.route_type === "wire"
                ? previous.to_layer !== p.layer || distance(previous, p) > 1e-8
                : true) ||
          (p.route_type === "via" &&
            p.layers !== undefined &&
            (!p.layers.includes(p.from_layer) ||
              !p.layers.includes(p.to_layer)))
        )
          throw Error("Completed seed has a disconnected layer transition")
      }
    }
    if (!routeAnglesAreConventional(traces))
      throw Error("Completed seed has a nonconventional corner")
    const context = separateAnytimeCarriers(input, traces)
    const clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
    const conflicts = new CopperConflictIndex()
    for (const [index, trace] of traces.entries()) {
      const carrier = context.traces[index]
      const runs: Array<{
        layer: string
        copper: ReturnType<typeof routeCopper>
      }> = []
      for (let i = 0; i < trace.route.length; i++) {
        const first = trace.route[i]
        if (first.route_type !== "wire") continue
        const run: Wire[] = [first]
        while (i + 1 < trace.route.length) {
          const next = trace.route[i + 1]
          if (next.route_type !== "wire" || next.layer !== first.layer) break
          run.push(next)
          i++
        }
        // The strict lane validator checks the carrier itself. Check only
        // additional local runs here, then interactions between layer runs.
        const isCarrier =
          run[0] === carrier.route[0] && run.at(-1) === carrier.route.at(-1)
        if (
          !isCarrier &&
          !tuningPathIsSelfClear(
            run,
            Math.max(...run.map((p) => p.width)) + clearance,
          )
        )
          throw Error("Completed seed has an escape self-clearance violation")
        runs.push({
          layer: first.layer,
          copper: routeCopper({ ...trace, route: run }),
        })
      }
      for (let i = 0; i < runs.length; i++)
        for (let j = i + 1; j < runs.length; j++)
          if (
            runs[i].layer === runs[j].layer &&
            conflicts.firstConflict(
              runs[i].copper,
              runs[j].copper,
              clearance - 1e-8,
            )
          )
            throw Error(
              "Completed seed has a same-layer run self-clearance violation",
            )
    }
    for (const trace of context.traces) {
      const connection = input.connections.find(
        (c) => c.name === trace.connection_name,
      )!
      const width =
        input.buses?.find((b) => b.connectionNames.includes(connection.name))
          ?.traceWidth ??
        connection.nominalTraceWidth ??
        connection.width ??
        input.minTraceWidth
      if (
        trace.route.some(
          (p) => p.route_type !== "wire" || Math.abs(p.width - width) > 1e-8,
        )
      )
        throw Error("Completed seed has invalid carrier width")
    }
    const validator = BusLanesSolver.forValidation(
      context.input,
      context.traces,
      { smoothTuning: true },
    )
    validator.solve()
    const known = new Set(input.connections.map((c) => c.name))
    // Normalize electrical aliases only in the audit; returned provenance is
    // preserved exactly, including fixed traces identified by source_trace_id.
    const fixedAudit = (input.traces ?? []).map((t) => {
      const connection = input.connections.find(
        (c) =>
          c.name === t.connection_name ||
          c.name === t.source_trace_id ||
          (c.source_trace_id !== undefined &&
            (c.source_trace_id === t.source_trace_id ||
              c.source_trace_id === t.connection_name)),
      )
      return {
        ...t,
        connection_name:
          connection?.name ?? t.connection_name ?? t.source_trace_id,
      }
    })
    const fixedConnections = fixedAudit.flatMap((t) => {
      const name = t.connection_name ?? t.source_trace_id
      if (!name || known.has(name)) return []
      known.add(name)
      const points = [t.route[0], t.route.at(-1)!].filter(
        (p) =>
          p.route_type === "wire" &&
          !t.route.some((v) => v.route_type === "via" && distance(v, p) < 1e-8),
      )
      return [
        {
          name,
          source_trace_id: t.source_trace_id,
          pointsToConnect:
            points as SimpleRouteJson["connections"][number]["pointsToConnect"],
        },
      ]
    })
    const drcInput = {
      ...input,
      connections: [...input.connections, ...fixedConnections],
    }
    const drc = validateRoutedCopperDrc({
      inputSrj: drcInput,
      routedSrj: { ...drcInput, traces: [...fixedAudit, ...traces] },
      clearance:
        input.minTraceToPadEdgeClearance ??
        input.defaultObstacleMargin ??
        0.075,
      allowBlindAndBuriedVias: input.allowBlindAndBuriedVias ?? false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
    if (
      !validator.solved ||
      !drc.valid ||
      exteriorPairSpacingReports(input, traces).some((r) => !r.matched)
    )
      throw Error(
        `Completed seed failed validation: ${validator.error ?? drc.issues[0]?.message ?? "pair spacing"}`,
      )
    solver.incumbent = structuredClone(traces)
    solver.incumbentScore = scoreAnytimeRoutes(
      solver.input,
      solver.incumbent,
      solver.weights,
    )
    solver.solved = true
    solver.baselineFinished = true
    solver.violations = []
    solver.phase = "optimize"
    solver.revisions.push({
      optimizationIterations: 0,
      score: solver.incumbentScore,
    })
    solver.candidates = solver.proposals()
    return solver
  }

  private effortBudget(effort: AnytimeEffort) {
    const value = effortValue(effort)
    if (![1, 2, 5].includes(value)) throw Error("Effort must be 1x, 2x or 5x")
    return value * this.options.iterationsPerX!
  }
  /** Snapshots are detached so callers cannot mutate the retained best route. */
  get traces(): Trace[] {
    return structuredClone(this.incumbent)
  }
  get history() {
    return structuredClone(this.revisions)
  }
  getOutput(): SimpleRouteJson {
    return structuredClone({
      ...this.input,
      traces: [...(this.input.traces ?? []), ...this.incumbent],
    })
  }
  getResult(): AnytimeResult {
    return {
      status: this.solved ? "valid" : "best_effort",
      output: this.getOutput(),
      score: structuredClone(this.incumbentScore),
      violations: structuredClone(this.violations),
      iterations: this.iterations,
      optimizationIterations: this.optimizationIterations,
      acceptedImprovements: this.acceptedImprovements,
      exhausted: this.exhausted,
    }
  }
  getConstructorParams() {
    return [this.input, this.options]
  }
  get stats() {
    return {
      phase: this.phase,
      status: this.solved ? "valid" : "best_effort",
      score: this.incumbentScore.objective,
      optimizationIterations: this.optimizationIterations,
      acceptedImprovements: this.acceptedImprovements,
      budget: this.budget,
      ...this.proposalStats,
      lastValidationFailure: this.lastValidationFailure,
    }
  }

  private *proposals(): Generator<Trace[] | undefined> {
    // Rebase trials onto accepted improvements and refresh the neighborhood
    // each round. Effort levels retain one deterministic discovery counter.
    for (let round = 0; ; round++) {
      const revision = this.acceptedImprovements
      const roundScore = this.incumbentScore
      const context = separateAnytimeCarriers(this.input, this.incumbent)
      const rebase = (candidate: Trace[]) => {
        const composed = context.compose(candidate)
        const changed = new Map(
          candidate.flatMap((t, i) =>
            t !== context.traces[i]
              ? [[t.connection_name, composed[i]] as const]
              : [],
          ),
        )
        return this.incumbent.map((t) => changed.get(t.connection_name) ?? t)
      }
      const generator = anytimeTransactionCandidates(
        context.input,
        context.traces,
      )
      try {
        for (const candidate of generator) {
          yield candidate ? rebase(candidate) : undefined
          // A substantial accepted transaction changes the corridor geometry
          // seen by other cohorts. Replan from that incumbent rather than
          // retaining thousands of stale branches behind their old obstacles.
          if (
            this.incumbentScore.totalLengthMm <
              roundScore.totalLengthMm * 0.99 ||
            this.incumbentScore.envelopeAreaMm2 <
              roundScore.envelopeAreaMm2 * 0.99 ||
            this.acceptedImprovements - revision >= 32
          )
            break
        }
      } finally {
        generator.return(undefined as never)
      }
      if (revision === this.acceptedImprovements) return
    }
  }

  step(): void {
    if (this.exhausted) return
    try {
      this.advance()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      if (!this.solved)
        this.violations.push({ code: "search_error", message: this.error })
      this.exhausted = true
      this.phase = this.solved ? "paused" : "best_effort"
      this.validation = this.pending = undefined
    }
  }

  /** Check against accepted ports and escapes before deriving a new carrier
   * input. Deriving ports from the proposal itself would make connectivity and
   * width checks circular if a search operator ever produced corrupt copper. */
  private auditCandidate(candidate: Trace[]) {
    if (
      candidate.length !== this.incumbent.length ||
      candidate.some((trace, i) => {
        const old = this.incumbent[i]
        return (
          trace.connection_name !== old.connection_name ||
          trace.pcb_trace_id !== old.pcb_trace_id ||
          trace.source_trace_id !== old.source_trace_id ||
          trace.route.length < 2 ||
          trace.route.some(
            (p) =>
              !Number.isFinite(p.x) ||
              !Number.isFinite(p.y) ||
              (p.route_type !== "wire" && p.route_type !== "via") ||
              (p.route_type === "wire" &&
                (!Number.isFinite(p.width) || p.width <= 0)),
          )
        )
      })
    )
      throw Error("Candidate changed connection ownership or copper primitives")
    if (!routeAnglesAreConventional(candidate))
      throw Error("Candidate has a nonconventional corner")
    if (this.carrierAuditContext?.incumbent !== this.incumbent)
      this.carrierAuditContext = {
        incumbent: this.incumbent,
        context: separateAnytimeCarriers(this.input, this.incumbent),
      }
    const accepted = this.carrierAuditContext.context
    const proposed = separateAnytimeCarriers(this.input, candidate)
    if (
      JSON.stringify(
        accepted.input.traces?.slice(this.input.traces?.length ?? 0),
      ) !==
      JSON.stringify(
        proposed.input.traces?.slice(this.input.traces?.length ?? 0),
      )
    )
      throw Error("Candidate changed an immutable local escape")
    for (const [i, trace] of proposed.traces.entries()) {
      const old = accepted.traces[i],
        first = old.route[0] as Wire,
        last = old.route.at(-1)! as Wire
      if (
        distance(trace.route[0], first) > 1e-8 ||
        distance(trace.route.at(-1)!, last) > 1e-8 ||
        trace.route.some(
          (p) =>
            p.route_type !== "wire" ||
            p.layer !== first.layer ||
            Math.abs(p.width - first.width) > 1e-8,
        )
      )
        throw Error("Candidate changed a carrier handoff, layer, or width")
    }
    return proposed
  }

  private preservesAcceptedPairGaps(candidate: Trace[]) {
    // Existing curved offsets allow a small chord/miter departure from the
    // requested gap. Preserve their independently measured physical minimum,
    // rather than silently allowing contraction down to generic clearance.
    if (!this.pairGapFloors)
      this.pairGapFloors = new Map(
        sharedPairSpacingReports(this.input, this.incumbent).flatMap(
          (report) =>
            report.minEdgeGapMm === null
              ? []
              : [
                  [
                    report.connectionNames.join("\0"),
                    report.minEdgeGapMm -
                      (report.maxSamplingErrorMm ?? 0) -
                      1e-8,
                  ] as const,
                ],
        ),
      )
    const conflicts = new CopperConflictIndex()
    for (const pair of this.input.differentialPairs ?? []) {
      const floor = this.pairGapFloors.get(pair.connectionNames.join("\0"))
      if (floor === undefined) continue
      const rails = pair.connectionNames.map(
        (name) => candidate.find((t) => t.connection_name === name)!,
      )
      if (
        rails.every(
          (rail, i) =>
            rail ===
            this.incumbent.find(
              (t) => t.connection_name === pair.connectionNames[i],
            ),
        )
      )
        continue
      const completeCopper = rails.map(routeCopper)
      for (let side = 0; side < 2; side++) {
        const rail = rails[side],
          section = rail.coupledSection
        if (!section) return false
        if (
          conflicts.firstConflict(
            routeCopper({
              ...rail,
              route: rail.route.slice(section[0], section[1] + 1),
            }),
            completeCopper[1 - side],
            floor,
          )
        )
          return false
      }
    }
    return true
  }

  private advance(): void {
    this.iterations++
    if (!this.baselineFinished) {
      this.baseline.step()
      if (!this.baseline.solved && !this.baseline.failed) return
      this.baselineFinished = true
      if (!this.baseline.solved) {
        this.error = this.baseline.error ?? "Routing search exhausted"
        this.violations.push({
          code: this.baseline.failureCode ?? "routing_failed",
          message: this.error,
        })
        if (this.retryRouting()) return
        this.phase = "best_effort"
        this.exhausted = true
        return
      }
      this.incumbent = structuredClone(this.baseline.traces)
      this.incumbentScore = scoreAnytimeRoutes(
        this.input,
        this.incumbent,
        this.weights,
      )
      this.solved = true
      this.violations = []
      this.revisions.push({
        optimizationIterations: 0,
        score: this.incumbentScore,
      })
      this.candidates = this.proposals()
      this.phase = "optimize"
      return
    }
    if (this.validation && this.pending) {
      this.validation.step()
      if (!this.validation.solved && !this.validation.failed) return
      const acceptedGaps =
        this.validation.solved &&
        this.preservesAcceptedPairGaps(this.pending.traces)
      if (
        this.validation.solved &&
        acceptedGaps &&
        exteriorPairSpacingReports(this.input, this.pending.traces).every(
          (r) => r.matched,
        )
      ) {
        this.incumbent = structuredClone(this.pending.traces)
        this.incumbentScore = this.pending.score
        this.acceptedImprovements++
        this.revisions.push({
          optimizationIterations: this.optimizationIterations,
          score: this.incumbentScore,
        })
      } else {
        this.proposalStats.validationRejected++
        this.lastValidationFailure =
          this.validation.error ??
          (acceptedGaps
            ? "Exterior pair spacing"
            : "Accepted shared-pair minimum gap")
      }
      this.validation = this.pending = undefined
    }
    if (this.optimizationIterations >= this.budget) {
      this.exhausted = true
      this.phase = "paused"
      return
    }
    const next = this.candidates!.next()
    if (next.done) {
      this.exhausted = true
      this.phase = "converged"
      return
    }
    this.optimizationIterations++
    if (!next.value) return
    this.proposalStats.proposals++
    let context: ReturnType<typeof separateAnytimeCarriers>
    try {
      context = this.auditCandidate(next.value)
    } catch (error) {
      this.proposalStats.validationRejected++
      this.lastValidationFailure =
        error instanceof Error ? error.message : String(error)
      return
    }
    const score = scoreAnytimeRoutes(this.input, next.value, this.weights)
    if (score.objective >= this.incumbentScore.objective - 1e-10) {
      this.proposalStats.objectiveRejected++
      return
    }
    if (
      [...score.busLengths, ...score.pairLengths].some(
        (r) => r.toleranceMm !== null && !r.matched,
      )
    ) {
      this.proposalStats.matchingRejected++
      return
    }
    const changed = new Set(
      next.value
        .filter((t, i) => t !== this.incumbent[i])
        .map((t) => t.connection_name!),
    )
    // An unchanged partner still participates in a changed rail's coupling
    // checks. Every other accepted carrier becomes immutable copper in this
    // strict validation, avoiding quadratic self checks on unrelated meanders.
    for (const pair of context.input.differentialPairs ?? [])
      if (pair.connectionNames.some((n) => changed.has(n)))
        for (const name of pair.connectionNames) changed.add(name)
    const validationInput: SimpleRouteJson = {
      ...context.input,
      traces: [
        ...(context.input.traces ?? []),
        // routeCopper owns generated carriers by connection_name only. Keep
        // that policy when temporarily treating accepted lanes as fixed.
        ...context.traces
          .filter((t) => !changed.has(t.connection_name!))
          .map((t) => ({ ...t, source_trace_id: undefined })),
      ],
      connections: context.input.connections
        .filter((c) => changed.has(c.name))
        .map((c) => ({
          ...c,
          nominalTraceWidth:
            context.input.buses?.find((b) => b.connectionNames.includes(c.name))
              ?.traceWidth ??
            c.nominalTraceWidth ??
            c.width ??
            context.input.minTraceWidth,
        })),
      buses: (context.input.buses ?? []).filter((b) =>
        b.connectionNames.every((n) => changed.has(n)),
      ),
      differentialPairs: (context.input.differentialPairs ?? []).filter((p) =>
        p.connectionNames.every((n) => changed.has(n)),
      ),
    }
    this.pending = { traces: next.value, score }
    this.validation = BusLanesSolver.forValidation(
      validationInput,
      context.traces.filter((t) => changed.has(t.connection_name!)),
      { smoothTuning: true },
    )
  }

  solve(): AnytimeResult {
    while (!this.exhausted) this.step()
    return this.getResult()
  }
  /** Set a total effort budget, not an additional multiplier. */
  improve(effort: AnytimeEffort): AnytimeResult {
    this.budget = Math.max(this.budget, this.effortBudget(effort))
    this.requestedEffort = Math.max(this.requestedEffort, effortValue(effort))
    if (this.phase === "best_effort") this.retryRouting()
    if (this.phase === "paused" && this.optimizationIterations < this.budget)
      this.exhausted = false
    return this.solve()
  }
  /** Continue local optimization beyond the named presets in bounded chunks. */
  runIterations(additionalIterations: number): AnytimeResult {
    if (!Number.isInteger(additionalIterations) || additionalIterations < 1)
      throw Error("additionalIterations must be a positive integer")
    this.budget = this.optimizationIterations + additionalIterations
    if (this.phase === "paused" && this.optimizationIterations < this.budget)
      this.exhausted = false
    return this.solve()
  }
  /** Stop bounded routing without destroying the current result. */
  tryFinalAcceptance(): void {
    if (!this.baselineFinished) {
      this.baseline.tryFinalAcceptance()
      this.baselineFinished = true
      this.violations.push({
        code: "search_budget_exhausted",
        message:
          "Routing interrupted; retaining provisional endpoint connections.",
      })
    }
    this.validation?.tryFinalAcceptance()
    this.validation = this.pending = undefined
    this.exhausted = true
    this.phase = this.solved ? "paused" : "best_effort"
  }
  visualize() {
    if (!this.baselineFinished) return this.baseline.visualize()
    return {
      coordinateSystem: "cartesian" as const,
      title: `Anytime bus lanes · ${this.phase}`,
      lines: this.incumbent.map((t) => ({
        points: t.route.map(({ x, y }) => ({ x, y })),
        strokeWidth: (t.route[0] as Wire)?.width,
        label: t.connection_name,
      })),
    }
  }
}
