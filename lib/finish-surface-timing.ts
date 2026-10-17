import { BusLanesSolver } from "./bus-lanes-solver"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { extendPackageCoupling } from "./extend-package-coupling"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import type { FlexibleSignalState } from "./flexible-signal-state"
import { joinSignalEscapes } from "./join-signal-escapes"
import { tuningPathIsSelfClear } from "./length-tuning"
import { normalizeSurfaceCarriers } from "./normalize-surface-carriers"
import { rebalancePairEscapes } from "./rebalance-pair-escapes"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { busLengthReports, pairLengthReports } from "./route-lengths"
import { runBoundedRouting } from "./run-bounded-routing"
import { shortenPairApproaches } from "./shorten-pair-approaches"
import { tuneGeneratedOrdinaryEscapes } from "./tune-generated-ordinary-escapes"
import { tuneGeneratedOrdinaryEscapeRuns } from "./tune-generated-ordinary-escape-runs"
import { tuneGeneratedPairEscapes } from "./tune-generated-pair-escapes"
import type { SimpleRouteJson, SolverOptions, Trace, Wire } from "./types"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"

/** Reserve matched bus and paired copper before unrelated surface controls use
 * its tuning corridors. Later cleanup preserves valid timing paths and curves
 * while finishing newly inserted controls against that hard copper. */
export function* finishSurfaceTiming(
  previous: FlexibleSignalState,
  options: SolverOptions,
  policy: { preserveTiming?: boolean; maxSteps?: number } = {},
): Generator<void, FlexibleSignalState | null> {
  const { native } = previous
  const paired = new Set(
    native.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  const timing = new Set([
    ...(native.buses?.flatMap((bus) => bus.connectionNames) ?? []),
    ...paired,
  ])
  const carriers = structuredClone([...previous.retained, ...previous.traces])
  const byName = new Map(
    carriers.map((trace) => [trace.connection_name, trace]),
  )
  let prepared: { input: SimpleRouteJson; traces: Trace[]; escapes: Trace[] } =
    normalizeSurfaceCarriers(
      {
        ...native,
        connections: native.connections.map((connection) => {
          const trace = byName.get(connection.name)!
          return {
            ...connection,
            pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
          }
        }),
        traces: [...(native.traces ?? []), ...previous.escapes],
      },
      carriers,
      previous.escapes,
    )
  const maxSteps = policy.maxSteps ?? 200000
  const geometryIsValid = (trace: Trace) => {
    const joined = joinSignalEscapes(
      trace,
      prepared.escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    )
    if (!routeAnglesAreConventional([joined])) return false
    const clearance =
      native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
    const runs: Wire[][] = []
    for (const point of joined.route) {
      if (point.route_type !== "wire") {
        runs.push([])
        continue
      }
      let run = runs.at(-1)
      if (!run || (run.length && run[0].layer !== point.layer))
        runs.push((run = []))
      run.push(point)
    }
    return runs.every(
      (run) =>
        run.length < 2 || tuningPathIsSelfClear(run, run[0].width + clearance),
    )
  }
  try {
    const fixed = fixedCopper(prepared.input)
    for (let pass = 0; pass < 3; pass++) {
      const before = prepared.traces
      const protectedNames = new Set(
        before
          .filter(
            (trace) =>
              policy.preserveTiming &&
              timing.has(trace.connection_name!) &&
              geometryIsValid(trace),
          )
          .map((trace) => trace.connection_name!),
      )
      prepared.traces = [...before]
      for (let index = 0; index < prepared.traces.length; index++) {
        const trace = prepared.traces[index]
        if (
          paired.has(trace.connection_name!) ||
          protectedNames.has(trace.connection_name!)
        )
          continue
        const first = trace.route[0] as Wire
        const connection = prepared.input.connections.find(
          (candidate) => candidate.name === trace.connection_name,
        )!
        prepared.traces[index] = {
          ...trace,
          curvedSegments: undefined,
          route: reduceOrdinaryTurns(
            trace.route,
            new VectorScene(prepared.input, connection, first.width, [
              ...fixed,
              ...prepared.traces.flatMap(routeCopper),
            ]),
          ).map((point) => ({
            ...point,
            route_type: "wire",
            layer: first.layer,
            width: first.width,
          })),
        }
      }
      // Excluding protected connections makes chamfering keep their complete
      // carrier objects and metadata while their copper remains hard.
      const cleanupInput = {
        ...prepared.input,
        connections: prepared.input.connections.filter(
          (connection) => !protectedNames.has(connection.name),
        ),
      }
      prepared.traces = chamferOrdinaryCorners(
        cleanupInput,
        prepared.traces,
        fixed,
      ).map((trace, index) =>
        protectedNames.has(trace.connection_name!) ||
        (!geometryIsValid(trace) && geometryIsValid(before[index]))
          ? before[index]
          : trace,
      )
      yield
    }
    const accepted = () =>
      [
        ...busLengthReports(prepared.input, prepared.traces),
        ...pairLengthReports(prepared.input, prepared.traces),
      ].every(
        (report) =>
          (report.toleranceMm === null || report.matched) &&
          report.withinLengthLimit &&
          report.aboveMinimumLength,
      ) &&
      exteriorPairSpacingReports(prepared.input, prepared.traces).every(
        (report) => report.applicable && report.matched,
      )
    if (policy.preserveTiming && !accepted()) {
      const tuned = yield* runBoundedRouting(
        tuneGeneratedOrdinaryEscapes(
          prepared.input,
          prepared.traces,
          prepared.escapes,
          { maxCandidatesPerEscape: 4096 },
        ),
        maxSteps,
      )
      if (tuned) prepared = tuned
    }
    if (!accepted()) {
      const tuned = yield* runBoundedRouting(
        tuneGeneratedOrdinaryEscapeRuns(
          prepared.input,
          prepared.traces,
          prepared.escapes,
          { maxCandidatesPerRun: 4096 },
        ),
        maxSteps,
      )
      if (tuned) prepared = tuned
    }
    if (!accepted()) {
      const matched = yield* solveRefinement(
        prepared.input,
        prepared.traces,
        options,
        maxSteps,
      )
      if (!matched) return null
      prepared.traces = matched
      const extended = yield* runBoundedRouting(
        extendPackageCoupling(prepared.input, prepared.traces),
        maxSteps,
      )
      if (!extended) return null
      prepared.traces = extended
      if (
        exteriorPairSpacingReports(prepared.input, prepared.traces).some(
          (report) => !report.matched,
        )
      ) {
        const repaired = yield* runBoundedRouting(
          extendPackageCoupling(
            prepared.input,
            shortenPairApproaches(prepared.input, prepared.traces),
            { preserveMatching: false },
          ),
          maxSteps,
        )
        if (!repaired) return null
        prepared.traces = repaired
      }
      if (!accepted()) {
        const tuned = yield* runBoundedRouting(
          tuneGeneratedPairEscapes(
            prepared.input,
            prepared.traces,
            prepared.escapes,
            options,
          ),
          maxSteps,
        )
        if (tuned) prepared = tuned
        if (!accepted()) {
          const balanced = yield* runBoundedRouting(
            rebalancePairEscapes(
              prepared.input,
              prepared.traces,
              prepared.escapes,
              options,
            ),
            maxSteps,
          )
          if (balanced) prepared = balanced
        }
        if (!accepted()) {
          const rematched = yield* solveRefinement(
            prepared.input,
            prepared.traces,
            options,
            maxSteps,
          )
          if (!rematched) return null
          prepared.traces = rematched
        }
      }
    }
    if (!accepted()) return null
    const validator = BusLanesSolver.forValidation(
      prepared.input,
      prepared.traces,
      options,
    )
    try {
      let steps = 0
      while (!validator.solved && !validator.failed && steps++ < maxSteps) {
        validator.step()
        yield
      }
      if (!validator.solved) return null
    } finally {
      if (!validator.solved && !validator.failed) validator.tryFinalAcceptance()
    }
    return {
      native,
      pending: prepared.input,
      escapes: prepared.escapes,
      retained: prepared.traces.filter((trace) =>
        paired.has(trace.connection_name!),
      ),
      traces: prepared.traces.filter(
        (trace) => !paired.has(trace.connection_name!),
      ),
    }
  } catch {
    return null
  }
}

function* solveRefinement(
  input: SimpleRouteJson,
  traces: Trace[],
  options: SolverOptions,
  maxSteps: number,
): Generator<void, Trace[] | null> {
  const solver = BusLanesSolver.forRefinement(input, traces, options)
  try {
    let steps = 0
    while (!solver.solved && !solver.failed && steps++ < maxSteps) {
      solver.step()
      yield
    }
    return solver.solved ? solver.traces : null
  } finally {
    if (!solver.solved && !solver.failed) solver.tryFinalAcceptance()
  }
}
