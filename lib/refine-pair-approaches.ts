import { tightenPairApproaches } from "./tighten-pair-approaches"
import { chamferPairApproaches } from "./chamfer-pair-approaches"
import { extendPairApproaches } from "./extend-pair-approaches"
import { offsetPath } from "./coupled-pair-routing"
import { routeCopper, type Copper } from "./vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Refine a complete routing solution before matching, with every other net's
 * copper fixed. Keeping refinement outside candidate generation avoids changing
 * corridor selection merely to improve a local approach. Board-world mm. */
export function refinePairApproaches(
  input: SimpleRouteJson,
  traces: Trace[],
  fixed: Copper[],
): Trace[] {
  const result = [...traces]
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  for (const pair of input.differentialPairs ?? []) {
    const indices = pair.connectionNames.map((name) =>
      result.findIndex((t) => t.connection_name === name),
    )
    const rails = indices.map((i) => result[i])
    if (rails.some((t) => !t?.coupledSection)) continue
    const members = pair.connectionNames.map(
      (name) => input.connections.find((c) => c.name === name)!,
    )
    const copper = [
      ...fixed,
      ...result.filter((_, i) => !indices.includes(i)).flatMap(routeCopper),
    ]
    const width = (rails[0].route[0] as Wire).width,
      gap = pair.traceGap ?? clearance
    const tightened = tightenPairApproaches(
      input,
      members,
      rails,
      copper,
      width,
      gap,
      clearance,
    )
    const chamfered = chamferPairApproaches(
      input,
      members,
      tightened,
      copper,
      width,
      clearance,
    )
    const extended = extendPairApproaches(
      input,
      members,
      chamfered,
      copper,
      width,
      gap,
      clearance,
      offsetPath,
    )
    indices.forEach((i, k) => {
      result[i] = extended[k]
    })
  }
  return result
}
