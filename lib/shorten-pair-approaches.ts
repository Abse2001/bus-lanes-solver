import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { remapCurvedSegments } from "./remap-curved-segments"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Remove old individual tuning before rebuilding a pair's package approaches.
 * This deliberately invalidates length matching; callers must rematch and fully
 * validate the result. Shared corridors and immutable input copper stay fixed. */
export function shortenPairApproaches(
  input: SimpleRouteJson,
  traces: Trace[],
): Trace[] {
  const result = [...traces],
    fixed = fixedCopper(input)
  for (let i = 0; i < result.length; i++) {
    const t = result[i]
    if (!t.coupledSection) continue
    const [s, e] = t.coupledSection,
      first = t.route[0] as Wire
    const scene = new VectorScene(
      input,
      input.connections.find((c) => c.name === t.connection_name)!,
      first.width,
      [...fixed, ...result.flatMap(routeCopper)],
    )
    const prefix = reduceOrdinaryTurns(t.route.slice(0, s + 1), scene),
      suffix = reduceOrdinaryTurns(t.route.slice(e), scene)
    const route = [
      ...prefix.slice(0, -1),
      ...t.route.slice(s, e + 1),
      ...suffix.slice(1),
    ].map((p) => ({
      ...p,
      route_type: "wire" as const,
      layer: first.layer,
      width: first.width,
    }))
    result[i] = {
      ...t,
      route,
      curvedSegments: remapCurvedSegments(t, route),
      coupledSection: [prefix.length - 1, prefix.length + e - s - 1],
    }
  }
  return result
}
