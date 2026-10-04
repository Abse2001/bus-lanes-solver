import { BusLanesSolver } from "./bus-lanes-solver"
import {
  compactEnvelopeCandidate,
  type CompactionMode,
} from "./compact-envelope"
import { signalEnvelope } from "./carrier-compaction-view"
import { createTerminalViaClearanceChecker } from "./terminal-via-clearance"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { tuningPathIsSelfClear } from "./length-tuning"
import type { SimpleRouteJson, SolverOptions, Trace, Wire } from "./types"

/** Spend the cohort-search budget where a constrained lane supports the outer
 * envelope. Unmatched outer lanes retain the existing compaction result. */
export function matchingGroupsSupportEnvelope(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  const names = new Set([
    ...(input.buses?.flatMap((b) => b.connectionNames) ?? []),
    ...(input.differentialPairs?.flatMap((p) => p.connectionNames) ?? []),
  ])
  const bounds = signalEnvelope(traces)
  return traces.some((t) => {
    if (!names.has(t.connection_name!)) return false
    const local = signalEnvelope([t])
    return (["minX", "minY", "maxX", "maxY"] as const).some(
      (key) => Math.abs(local[key] - bounds[key]) < 1e-8,
    )
  })
}

/** Compact complete matching cohorts, holding the other carriers fixed. An
 * interior cohort may shrink before the board envelope changes, opening room
 * for the next cohort. Yield validated branches; the caller retains its best
 * complete envelope, including when a search is interrupted. */
export function* compactMatchingGroups(
  input: SimpleRouteJson,
  original: Trace[],
  options: SolverOptions,
): Generator<Trace[] | void, void> {
  const groups = input.connections.map((c) => new Set([c.name]))
  for (const constraint of [
    ...(input.buses ?? []),
    ...(input.differentialPairs ?? []),
  ]) {
    const related = groups.filter((g) =>
      constraint.connectionNames.some((n) => g.has(n)),
    )
    const merged = new Set(related.flatMap((g) => [...g]))
    for (const group of related) groups.splice(groups.indexOf(group), 1)
    if (merged.size) groups.push(merged)
  }
  groups.sort((a, b) => a.size - b.size)
  let traces = original
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  for (let round = 0; round < 4; round++) {
    const before = signalEnvelope(traces).areaMm2
    let changed = false
    for (const group of groups) {
      const members = traces.filter((t) => group.has(t.connection_name!))
      const local: SimpleRouteJson = {
        ...input,
        connections: input.connections.filter((c) => group.has(c.name)),
        buses: input.buses?.filter((b) => group.has(b.connectionNames[0])),
        differentialPairs: input.differentialPairs?.filter((p) =>
          group.has(p.connectionNames[0]),
        ),
        traces: [
          ...(input.traces ?? []),
          ...traces.filter((t) => !group.has(t.connection_name!)),
        ],
      }
      const viaChecks = members.map((t) =>
        createTerminalViaClearanceChecker(local, t),
      )
      let accepted = false
      for (const mode of ["cohort", "guarded-cohort"] as CompactionMode[]) {
        const candidate = yield* compactEnvelopeCandidate(local, members, mode)
        if (candidate === members) break
        let viaRejected = false
        for (const fraction of [
          1, 0.999, 0.99, 0.95, 0.9, 0.75, 0.5, 0.25, 0.1,
        ]) {
          const result = candidate.map((t, i) => ({
            ...t,
            route: t.route.map((p, j) => ({
              ...p,
              x:
                members[i].route[j].x +
                (p.x - members[i].route[j].x) * fraction,
              y:
                members[i].route[j].y +
                (p.y - members[i].route[j].y) * fraction,
            })),
          }))
          const area = signalEnvelope(result).areaMm2
          if (
            !Number.isFinite(area) ||
            area >= signalEnvelope(members).areaMm2 - 1e-6
          )
            continue
          if (result.some((t, i) => !viaChecks[i](t.route))) {
            viaRejected = true
            continue
          }
          if (
            result.some(
              (t) =>
                !tuningPathIsSelfClear(
                  t.route,
                  (t.route[0] as Wire).width + clearance,
                ),
            )
          )
            continue
          // Native copper checks have a tighter numerical boundary than the
          // carrier validator. Reserve that sub-nanometer difference here.
          const validator = BusLanesSolver.forValidation(
            { ...local, minTraceToPadEdgeClearance: clearance + 9.5e-9 },
            result,
            options,
          )
          try {
            while (!validator.solved && !validator.failed) {
              validator.step()
              yield
            }
            if (!validator.solved) continue
            const byName = new Map(result.map((t) => [t.connection_name, t]))
            const next = traces.map((t) => byName.get(t.connection_name) ?? t)
            if (exteriorPairSpacingReports(input, next).some((r) => !r.matched))
              continue
            traces = next
            accepted = changed = true
            yield traces
            break
          } finally {
            if (!validator.solved && !validator.failed)
              validator.tryFinalAcceptance()
          }
        }
        if (accepted || !viaRejected) break
      }
    }
    // Interior groups can prepare space within a sweep. Another complete
    // sweep must be justified by measurable progress on the outer envelope.
    if (!changed || before - signalEnvelope(traces).areaMm2 < before * 0.001)
      break
  }
}
