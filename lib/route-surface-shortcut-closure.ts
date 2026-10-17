import { CopperConflictIndex } from "./copper-conflict-index"
import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import type { FlexibleSignalState } from "./flexible-signal-state"
import { length } from "./geometry"
import { joinSignalEscapes } from "./join-signal-escapes"
import { busLengthReports, fixedRouteLength } from "./route-lengths"
import {
  routeSurfaceBridge,
  type SurfaceBridgeRoute,
} from "./route-surface-bridge"
import { routeSurfaceViaAttachments } from "./route-surface-via-attachments"
import type { Connection, SimpleRouteJson, Trace } from "./types"
import { fixedCopper } from "./vector-scene"

/** A short proposal may require moving a currently clear ordinary neighbor.
 * Release only the bounded set it actually hits, then rebuild those neighbors
 * against the proposal and all untouched copper. No partial tuple is returned.
 * Paired rails and supplied copper remain hard in every search. */
export function* routeSurfaceShortcutClosure(
  state: FlexibleSignalState,
  connection: Connection,
  maxLength: number,
  options: {
    maxNeighbors: number
    maxExpansions: number
    maxVias: 2 | 4
  },
): Generator<void, Map<string, SurfaceBridgeRoute> | null> {
  if (options.maxNeighbors < 1 || options.maxExpansions <= 0) return null
  const native = state.native,
    paired = new Set(
      native.differentialPairs?.flatMap((pair) => pair.connectionNames),
    ),
    joined = [...state.retained, ...state.traces].map((trace) =>
      joinSignalEscapes(
        trace,
        state.escapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      ),
    ),
    others = joined.filter(
      (trace) => trace.connection_name !== connection.name,
    ),
    hard = {
      ...native,
      traces: [
        ...(native.traces ?? []),
        ...others.filter((trace) => paired.has(trace.connection_name!)),
      ],
    },
    ordinary = others.filter((trace) => !paired.has(trace.connection_name!)),
    clearance =
      native.minTraceToPadEdgeClearance ??
      native.defaultObstacleMargin ??
      0.075,
    conflicts = new CopperConflictIndex(),
    copper = (trace: Trace) =>
      fixedCopper({ ...native, obstacles: [], traces: [trace] }),
    otherCopper = new Map(ordinary.map((trace) => [trace, copper(trace)])),
    reports = busLengthReports(native, joined),
    beforeMaxima = reports.map((report) =>
      Math.max(...report.lengths.map((item) => item.totalLengthMm ?? 0)),
    ),
    oldTarget = joined.find(
      (trace) => trace.connection_name === connection.name,
    )!
  if (paired.has(connection.name) || !oldTarget) return null
  const budget = Math.min(options.maxExpansions, 50000)
  function* route(
    input: SimpleRouteJson,
    member: Connection,
    ceiling: number,
    reverse: boolean,
    soft: Trace[] = [],
  ): Generator<void, SurfaceBridgeRoute | null> {
    const oriented = reverse
        ? { ...member, pointsToConnect: [...member.pointsToConnect].reverse() }
        : member,
      settings = {
        maxLength: ceiling,
        maxVias: options.maxVias,
        maxExpansions: budget,
        maxGridCells: 4000000,
        gridStep: 0.1,
        heuristicWeight: 1,
        nonPreferredLayerCost: 1,
        softTraces: soft,
        softPenalty: soft.length ? 20 : 0,
      }
    let result = yield* routeSurfaceBridge(input, oriented, settings)
    if (!result && options.maxVias === 4)
      result = yield* routeSurfaceViaAttachments(input, oriented, {
        ...settings,
        // This is an optional shortening portfolio, after connectivity already
        // succeeded. Bound the whole endpoint alternative to the same order of
        // work as one ordinary search instead of multiplying it by 16 sites.
        maxAttachmentPairs: 4,
        maxEndpointCandidates: 4,
        maxExpansions: Math.min(budget, 12500),
        candidateEscapes: state.escapes.filter(
          (escape) => escape.connection_name === member.name,
        ),
      })
    // A reversed search changes only exploration order. Keep the carrier and
    // its approach endpoints in their native orientation for downstream joins.
    if (result && reverse)
      return {
        carrier: {
          ...result.carrier,
          route: result.carrier.route.toReversed(),
        },
        escapes: result.escapes,
      }
    return result
  }
  for (const reverse of [false, true]) {
    const target = yield* route(hard, connection, maxLength, reverse, ordinary)
    if (!target) continue
    const proposed = joinSignalEscapes(target.carrier, target.escapes)
    if (length(proposed.route) >= length(oldTarget.route) - 0.25 + 1e-8)
      continue
    const proposedCopper = copper(proposed),
      blockers = ordinary.filter(
        (trace) =>
          conflicts.firstConflict(
            proposedCopper,
            otherCopper.get(trace)!,
            clearance - 1e-8,
          ) || generatedEscapeHolesConflict(native, [proposed], [trace]),
      )
    if (blockers.length > options.maxNeighbors) continue
    const orders =
      blockers.length > 1 ? [blockers, blockers.toReversed()] : [blockers]
    for (const order of orders)
      for (const reverseNeighbors of [false, true]) {
        const released = new Set([
            connection.name,
            ...blockers.map((trace) => trace.connection_name!),
          ]),
          built = new Map<string, SurfaceBridgeRoute>([
            [connection.name, target],
          ]),
          traces = [
            ...(native.traces ?? []),
            ...joined.filter((trace) => !released.has(trace.connection_name!)),
            proposed,
          ]
        let failed = false
        for (const blocker of order) {
          const name = blocker.connection_name!,
            member = native.connections.find((item) => item.name === name)
          if (!member) {
            failed = true
            break
          }
          const busCeilings = reports.flatMap((report, index) =>
              report.lengths.some((item) => item.name === name)
                ? [beforeMaxima[index] - fixedRouteLength(native, name)]
                : [],
            ),
            ceiling = busCeilings.length
              ? Math.min(...busCeilings)
              : length(blocker.route) +
                length(oldTarget.route) -
                length(proposed.route),
            replacement = yield* route(
              { ...native, traces },
              member,
              ceiling,
              reverseNeighbors,
            )
          if (!replacement) {
            failed = true
            break
          }
          built.set(name, replacement)
          traces.push(
            joinSignalEscapes(replacement.carrier, replacement.escapes),
          )
        }
        if (failed) continue
        // Search length ceilings apply per member. Also check overlapping bus
        // maxima together, so a shortcut never raises another matching target.
        const complete = joined.map((trace) => {
            const replacement = built.get(trace.connection_name!)
            return replacement
              ? joinSignalEscapes(replacement.carrier, replacement.escapes)
              : trace
          }),
          after = busLengthReports(native, complete),
          afterMaxima = after.map((report) =>
            Math.max(...report.lengths.map((item) => item.totalLengthMm ?? 0)),
          )
        if (
          afterMaxima.every(
            (value, index) => value <= beforeMaxima[index] + 1e-7,
          ) &&
          (afterMaxima.some(
            (value, index) => value < beforeMaxima[index] - 0.25,
          ) ||
            complete.reduce((sum, trace) => sum + length(trace.route), 0) <
              joined.reduce((sum, trace) => sum + length(trace.route), 0) -
                0.25)
        )
          return built
        yield
      }
  }
  return null
}
