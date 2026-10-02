import { chamferPairApproaches } from "./chamfer-pair-approaches"
import { routeCopper, type Copper } from "./vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** A conservative alternative to full approach refinement: remove acute
 * package-approach corners while retaining existing shared rail interiors.
 * Every bevel sees the other pair and all remaining nets as hard copper. */
export function bevelPairApproaches(
  input: SimpleRouteJson,
  traces: Trace[],
  fixed: Copper[],
  maxTrimInTraceWidths: number,
): Trace[] {
  const result = [...traces]
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  for (const pair of input.differentialPairs ?? []) {
    const indices = pair.connectionNames.map((name) =>
      result.findIndex((trace) => trace.connection_name === name),
    )
    const rails = indices.map((index) => result[index])
    if (rails.some((trace) => !trace?.coupledSection)) continue
    const members = pair.connectionNames.map(
      (name) =>
        input.connections.find((connection) => connection.name === name)!,
    )
    const copper = [
      ...fixed,
      ...result
        .filter((_, index) => !indices.includes(index))
        .flatMap(routeCopper),
    ]
    const beveled = chamferPairApproaches(
      input,
      members,
      rails,
      copper,
      (rails[0].route[0] as Wire).width,
      clearance,
      maxTrimInTraceWidths,
    )
    indices.forEach((index, side) => {
      result[index] = beveled[side]
    })
  }
  return result
}
