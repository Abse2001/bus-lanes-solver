import { finishSurfaceTiming } from "./finish-surface-timing"
import type { FlexibleSignalState } from "./flexible-signal-state"
import {
  negotiateSurfaceRoutes,
  type SurfaceNegotiationOptions,
} from "./negotiate-surface-routes"
import { planSharedPairCorridors } from "./plan-shared-pair-corridors"
import { refineGeneratedPairSeed } from "./refine-generated-pair-seed"
import { retargetGeneratedEscape } from "./retarget-generated-escape"
import { surfaceBusShortcutCandidates } from "./surface-bus-shortcuts"
import { routeSurfaceTimingBankRetry } from "./route-surface-timing-bank-retry"
import { spreadGeneratedPairViaColumns } from "./spread-generated-pair-via-columns"
import type { RepairedBusDogbones } from "./repair-bus-dogbones"
import type { SimpleRouteJson, SolverOptions, Trace, Wire } from "./types"

export interface JointSurfaceBusOptions {
  negotiation?: SurfaceNegotiationOptions
  maxPairPlans?: number
  /** A computed connectivity checkpoint still needs timing refinement and
   * the caller's independent acceptance checks before it is a routed output. */
  onConnectivityCheckpoint?: (state: FlexibleSignalState) => void
  onProgress?: (progress: {
    stage: "pairs" | "surface" | "matching"
    pairPlan: number
    pairVariant?: number
    pairedSignals: number
    iterations: number
  }) => void
}

/** Reserve physically coupled pairs, then choose whole native-pad approaches
 * for all other signals together. Solver-owned ordinary dogbones are not hard
 * constraints, so an available surface route can select a different handoff.
 * The final timing stage remains responsible for full copper length matching.
 */
export function* routeJointSurfaceBuses(
  native: SimpleRouteJson,
  allocation: SimpleRouteJson,
  originalEscapes: Trace[],
  terminalLayers: ReadonlyMap<string, string[]>,
  solverOptions: SolverOptions,
  options: JointSurfaceBusOptions = {},
): Generator<void, RepairedBusDogbones | null> {
  const negotiation: SurfaceNegotiationOptions = {
    congestionHistory: true,
    heuristicWeight: 4,
    nonPreferredLayerCost: 1,
    hardNeighborRouting: true,
    maxHardNeighbors: 8,
    maxTimedVias: 4,
    maxInitialSoftExpansions: 150000,
    maxInitialExpansions: 400000,
    maxExpansions: 900000,
    maxClosureExpansions: 1500000,
    maxClosureSize: 4,
    maxClosureNeighbors: 6,
    maxClosureFragments: 20,
    endpointViaAttachments: true,
    maxRounds: 300,
    ...options.negotiation,
  }
  const pairedNames = new Set(
    native.differentialPairs?.flatMap((pair) => pair.connectionNames) ?? [],
  )
  const pairEscapes = originalEscapes.filter((escape) =>
    pairedNames.has(escape.connection_name!),
  )
  const pairInput: SimpleRouteJson = {
    ...native,
    connections: allocation.connections,
    traces: [...(native.traces ?? []), ...pairEscapes],
  }
  const preferred = new Map(
    allocation.connections.map((connection) => [
      connection.name,
      [
        ...new Set([
          connection.pointsToConnect[0].layer,
          ...(terminalLayers.get(connection.name) ?? []),
        ]),
      ],
    ]),
  )
  const plans = planSharedPairCorridors(pairInput, preferred, true, {
    preferPackageOnlyTuning: true,
    onProgress: (progress) =>
      options.onProgress?.({
        stage: "pairs",
        pairPlan: 0,
        pairedSignals: progress.pairedSignals,
        iterations: 0,
      }),
  })
  // Identical computed copper can occur in both approach variants or in
  // consecutive corridor proposals. Its outcome is deterministic within this
  // request, so reserve the search budget for different physical domains.
  const attemptedSeeds = new Set<string>()
  const seedKey = (retained: Trace[], escapes: Trace[]) =>
    JSON.stringify(
      [retained, escapes].map((values) =>
        values.map((trace) => [
          trace.connection_name,
          trace.route,
          trace.coupledSection,
          trace.curvedSegments,
        ]),
      ),
    )
  let plan = plans.next(),
    pairPlan = 0
  try {
    while (!plan.done && pairPlan < (options.maxPairPlans ?? 8)) {
      if (!plan.value) {
        yield
        plan = plans.next()
        continue
      }
      pairPlan++
      const rawRetained = plan.value,
        spread = spreadGeneratedPairViaColumns(native, rawRetained),
        variants = spread.some((trace, index) => trace !== rawRetained[index])
          ? [spread, rawRetained]
          : [rawRetained]
      for (const [variantIndex, proposed] of variants.entries()) {
        const generatedEscapes = pairEscapes.map((escape) => {
            const carrier = proposed.find(
              (trace) => trace.connection_name === escape.connection_name,
            )!
            return retargetGeneratedEscape(
              escape,
              (carrier.route[0] as Wire).layer,
            )
          }),
          refined = pairedNames.size
            ? yield* refineGeneratedPairSeed(
                native,
                proposed,
                generatedEscapes,
                solverOptions,
              )
            : { retained: proposed, escapes: generatedEscapes }
        if (!refined) continue
        // Refinement can shape the other package approach into a new narrow
        // channel. Offer its widened, fully revalidated tuple first, retaining
        // the already qualified tuple if ordinary routing needs another exit.
        const finalSpread = pairedNames.size
            ? spreadGeneratedPairViaColumns(native, refined.retained)
            : refined.retained,
          finalRefined = finalSpread.some(
            (trace, index) => trace !== refined.retained[index],
          )
            ? yield* refineGeneratedPairSeed(
                native,
                finalSpread,
                refined.escapes,
                solverOptions,
              )
            : null,
          seeds = finalRefined ? [finalRefined, refined] : [refined]
        for (const [seedIndex, generatedSeed] of seeds.entries()) {
          const pairVariant = variantIndex * 2 + seedIndex + 1,
            { retained, escapes } = generatedSeed,
            key = seedKey(retained, escapes)
          if (attemptedSeeds.has(key)) continue
          attemptedSeeds.add(key)
          const seed: FlexibleSignalState = {
            native,
            escapes,
            retained,
            traces: [],
            pending: {
              ...native,
              traces: [...(native.traces ?? []), ...escapes, ...retained],
            },
          }
          options.onProgress?.({
            stage: "surface",
            pairPlan,
            pairVariant,
            pairedSignals: retained.length,
            iterations: 0,
          })
          const work = negotiateSurfaceRoutes(native, seed, negotiation)
          let result = work.next(),
            iterations = 0
          try {
            while (!result.done) {
              if (++iterations % 1000 === 0)
                options.onProgress?.({
                  stage: "surface",
                  pairPlan,
                  pairVariant,
                  pairedSignals: retained.length,
                  iterations,
                })
              yield
              result = work.next()
            }
            if (result.value) {
              options.onConnectivityCheckpoint?.(result.value)
              const checkpoints = yield* surfaceBusShortcutCandidates(
                result.value,
                {
                  maxVias: 4,
                  maxAttempts: 24,
                  maxExpansions: 150000,
                  maxClosureNeighbors: 2,
                },
              )
              // Try the smaller bus targets first while retaining the original
              // corridor allocation as the final matching candidate.
              for (const checkpoint of checkpoints.toReversed()) {
                options.onProgress?.({
                  stage: "matching",
                  pairPlan,
                  pairVariant,
                  pairedSignals: retained.length,
                  iterations,
                })
                const finished = yield* finishSurfaceTiming(
                  checkpoint,
                  solverOptions,
                )
                if (finished)
                  return {
                    input: finished.pending,
                    traces: [...finished.retained, ...finished.traces],
                    escapes: finished.escapes,
                  }
              }
              const banked = yield* routeSurfaceTimingBankRetry(
                checkpoints.at(-1)!,
                solverOptions,
                negotiation,
                options.onConnectivityCheckpoint,
              )
              if (banked)
                return {
                  input: banked.pending,
                  traces: [...banked.retained, ...banked.traces],
                  escapes: banked.escapes,
                }
            }
          } finally {
            if (!result.done) work.return(null)
          }
          yield
        }
      }
      plan = plans.next()
      yield
    }
  } finally {
    if (!plan.done) plans.return(undefined)
  }
  return null
}
