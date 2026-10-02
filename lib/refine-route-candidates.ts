import { GridVisibilitySearch } from "./grid-visibility"
import { routeCoupledPair } from "./coupled-pair-routing"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { tuningPathIsSelfClear } from "./length-tuning"
import { RouteCandidatePool } from "./select-route-candidates"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import type { SimpleRouteJson, Trace } from "./types"

/** Generate paths around mutually compatible members of an unresolved group.
 * Soft congestion alone can keep producing the same crossing alternatives.
 * These conditional hard searches change the available routing topology. */
export function* refineRouteCandidates(
  input: SimpleRouteJson,
  fixed: Copper[],
  widths: ReadonlyMap<string, number>,
  candidates: RouteCandidatePool,
  units: string[],
  matchingGroups: string[][],
  terminalLayers: ReadonlyMap<string, string[]>,
): Generator<void, Trace[] | null> {
  const seen = new Map<string, number>()
  let steps = 0
  for (let round = 0; round < 24 && steps < 20000; round++) {
    const result = candidates.select(units, matchingGroups)
    if (result) return result
    const core = candidates.unresolvedUnits(units)
    if (!core?.length) return null
    const key = core.join("\0"),
      visit = seen.get(key) ?? 0
    seen.set(key, visit + 1)
    let added = 0
    for (const name of [...core].sort(
      (a, b) =>
        Number(
          input.differentialPairs?.some((p) => p.connectionNames.includes(a)),
        ) -
        Number(
          input.differentialPairs?.some((p) => p.connectionNames.includes(b)),
        ),
    )) {
      const pair = input.differentialPairs?.find((p) =>
        p.connectionNames.includes(name),
      )
      if (pair) {
        if (added || visit < 1) continue
        for (let trial = 0; trial < 4 && steps < 20000; trial++) {
          const conditional = candidates.conditionalRoutes(
            core.filter((n) => n !== name),
            trial === 0 ? -1 : visit * 4 + trial,
            trial % 2 === 0 ? units.filter((n) => n !== name) : [],
          )
          if (!conditional) continue
          const generator = routeCoupledPair(
            input,
            pair,
            [...fixed, ...conditional.flatMap(routeCopper)],
            { copper: [], penalty: 0, variant: visit },
          )
          let step = generator.next(),
            localSteps = 0
          try {
            while (!step.done && steps < 20000 && localSteps < 2000) {
              steps++
              localSteps++
              yield
              step = generator.next()
            }
          } finally {
            if (!step.done) generator.return(null)
          }
          if (step.done && step.value) {
            const before = candidates.revisionNumber
            candidates.add(name, step.value)
            added += Number(candidates.revisionNumber !== before)
          }
        }
        continue
      }
      const original = input.connections.find((c) => c.name === name)!
      const bus = input.buses?.some((b) => b.connectionNames.includes(name))
      const layers = bus
        ? [original.pointsToConnect[0].layer]
        : (terminalLayers.get(name) ?? [original.pointsToConnect[0].layer])
      const others = core.filter((n) => n !== name)
      for (let trial = 0; trial < 12 && steps < 20000; trial++) {
        const conditional = candidates.conditionalRoutes(
          others,
          trial === 0 ? -1 : visit * 12 + trial,
          trial % 2 === 0 ? units.filter((n) => n !== name) : [],
        )
        if (!conditional) continue
        for (const layer of layers) {
          const connection = {
              ...original,
              pointsToConnect: original.pointsToConnect.map((p) => ({
                ...p,
                layer,
              })),
            },
            width = widths.get(name) ?? input.minTraceWidth
          const scene = new VectorScene(input, connection, width, [
            ...fixed,
            ...conditional.flatMap(routeCopper),
          ])
          const search = new GridVisibilitySearch(
            scene,
            connection.pointsToConnect[0],
            connection.pointsToConnect[1],
          )
          try {
            while (
              !search.solved &&
              !search.failed &&
              search.expanded < 500000 &&
              steps < 20000
            ) {
              search.step()
              steps++
              yield
            }
          } finally {
            search.cancel()
          }
          if (!search.solved) continue
          const points = reduceOrdinaryTurns(search.result, scene)
          if (!tuningPathIsSelfClear(points, width + scene.margin)) continue
          const before = candidates.revisionNumber
          candidates.add(name, [
            {
              type: "pcb_trace",
              pcb_trace_id: `bus_lane_${name}`,
              connection_name: name,
              source_trace_id: original.source_trace_id ?? name,
              route: points.map((p) => ({
                ...p,
                route_type: "wire",
                layer,
                width,
              })),
            },
          ])
          added += Number(candidates.revisionNumber !== before)
        }
      }
    }
    if (!added && visit > 5) return null
  }
  return candidates.select(units, matchingGroups)
}
