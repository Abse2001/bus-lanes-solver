import { BusLanesSolver } from "./bus-lanes-solver"
import { routeCoupledPair } from "./coupled-pair-routing"
import { ejectBlockingLanes } from "./eject-blocking-lanes"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { extendPackageCoupling } from "./extend-package-coupling"
import { repairGridJogs } from "./repair-grid-jogs"
import { pairLengthReports } from "./route-lengths"
import { runBoundedRouting } from "./run-bounded-routing"
import { shortenPairApproaches } from "./shorten-pair-approaches"
import { signalWidth } from "./repair-bus-dogbones"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import type { SimpleRouteJson, SolverOptions, Trace, Wire } from "./types"

/** Repair package entries without placing individual skew compensation outside
 * the package. A standalone pair may displace ordinary lanes; completed pairs
 * and all supplied copper remain hard obstacles. */
export function* repairPairApproaches(
  input: SimpleRouteJson,
  original: Trace[],
  terminalLayers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
): Generator<void, Trace[]> {
  let result = original
  for (const pair of input.differentialPairs ?? []) {
    const members = input.connections.filter((c) =>
      pair.connectionNames.includes(c.name),
    )
    const local: SimpleRouteJson = {
      ...input,
      connections: structuredClone(members),
      buses: [],
      differentialPairs: [pair],
    }
    const current = result.filter((t) =>
      pair.connectionNames.includes(t.connection_name!),
    )
    if (
      exteriorPairSpacingReports(local, current).every((r) => r.matched) &&
      pairLengthReports(local, current).every((r) => r.matched)
    )
      continue
    const inBus = input.buses?.some((b) =>
      pair.connectionNames.some((n) => b.connectionNames.includes(n)),
    )
    const others = result.filter(
      (t) => !pair.connectionNames.includes(t.connection_name!),
    )
    const paired = others.filter((t) => t.coupledSection)
    const ordinary = others.filter((t) => !t.coupledSection)
    const layers = [
      ...new Set([
        members[0].pointsToConnect[0].layer,
        ...(!inBus
          ? (terminalLayers.get(members[0].name) ?? []).filter((layer) =>
              members.every((c) => terminalLayers.get(c.name)?.includes(layer)),
            )
          : []),
      ]),
    ].filter(
      (layer) => !input.allowedLayers || input.allowedLayers.includes(layer),
    )
    let accepted: Trace[] | undefined
    for (const soft of inBus ? [false] : [false, true]) {
      for (const layer of layers) {
        for (const c of local.connections)
          for (const p of c.pointsToConnect) p.layer = layer
        local.traces = [...(input.traces ?? []), ...(soft ? paired : others)]
        for (let variant = 0; variant < 6 && !accepted; variant++) {
          const rails = yield* runBoundedRouting(
            routeCoupledPair(local, pair, fixedCopper(local), {
              copper: soft ? ordinary.flatMap(routeCopper) : [],
              penalty: soft ? 4 : 0,
              variant,
            }),
            20000,
          )
          if (!rails) continue
          const extended = yield* extendPackageCoupling(
            local,
            shortenPairApproaches(local, rails),
            { preserveMatching: false },
          )
          if (
            exteriorPairSpacingReports(local, extended).some((r) => !r.matched)
          )
            continue
          const matcher = BusLanesSolver.forRefinement(local, extended, {
            ...options,
            packageOnlyPairTuning: true,
          })
          try {
            while (!matcher.solved && !matcher.failed) {
              matcher.step()
              yield
            }
            if (
              !matcher.solved ||
              exteriorPairSpacingReports(local, matcher.traces).some(
                (r) => !r.matched,
              )
            )
              continue
            const replacements = matcher.traces
            if (!soft) {
              accepted = [...others, ...replacements]
              break
            }
            const blocked = new Set(
              ordinary.filter((t) =>
                replacements.some(
                  (r) =>
                    !new VectorScene(
                      local,
                      local.connections.find(
                        (c) => c.name === r.connection_name,
                      )!,
                      (r.route[0] as Wire).width,
                      routeCopper(t),
                    ).pathVisible(r.route),
                ),
              ),
            )
            if (blocked.size > 8) continue
            const candidateInput = {
              ...input,
              connections: structuredClone(
                input.connections.map(
                  (c) => local.connections.find((p) => p.name === c.name) ?? c,
                ),
              ),
            }
            const completed = yield* runBoundedRouting(
              ejectBlockingLanes(
                candidateInput,
                [
                  ...paired,
                  ...replacements,
                  ...ordinary.filter((t) => !blocked.has(t)),
                ],
                fixedCopper(input),
                new Map(
                  input.connections.map((c) => [c.name, signalWidth(input, c)]),
                ),
                terminalLayers,
                { maxSearches: 4000, maxDepth: 10 },
              ),
              250000,
            )
            if (!completed) continue
            for (const c of candidateInput.connections)
              for (const p of c.pointsToConnect)
                p.layer = (
                  completed.find((t) => t.connection_name === c.name)!
                    .route[0] as Wire
                ).layer
            if (
              !(yield* repairGridJogs(
                candidateInput,
                completed,
                fixedCopper(candidateInput),
              ))
            )
              continue
            accepted = completed
          } finally {
            if (!matcher.solved && !matcher.failed) matcher.tryFinalAcceptance()
          }
        }
        if (accepted) break
      }
      if (accepted) break
    }
    if (accepted) result = accepted
  }
  return result
}
