import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { packageApproachRegions, pointInBox } from "./package-approach-regions"
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
    const regions = packageApproachRegions(
      input,
      first.width +
        (input.differentialPairs?.find((p) =>
          p.connectionNames.includes(t.connection_name!),
        )?.traceGap ?? 0.1) /
          2 +
        (input.minTraceToPadEdgeClearance ??
          input.defaultObstacleMargin ??
          0.075),
    )
    const shorten = (start: number, end: number) => {
      const local = regions.find((r) =>
        pointInBox(t.route[start === 0 ? 0 : t.route.length - 1], r.copper),
      )
      const externalCurve = (t.curvedSegments ?? []).some(
        (i) =>
          i > start &&
          i <= end &&
          (!local ||
            !pointInBox(t.route[i - 1], local.copper) ||
            !pointInBox(t.route[i], local.copper)),
      )
      return externalCurve
        ? reduceOrdinaryTurns(t.route.slice(start, end + 1), scene)
        : t.route.slice(start, end + 1)
    }
    const prefix = shorten(0, s),
      suffix = shorten(e, t.route.length - 1)
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
