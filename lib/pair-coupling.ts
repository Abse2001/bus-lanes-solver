import { CopperIndex } from "./copper-index"
import { distance, pointSegmentDistanceToPoints } from "./geometry"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import type { SimpleRouteJson, Trace } from "./types"

/** Measure total uncoupled copper per conductor in board-world mm (+X right,
 * +Y up). Fixed dogbones count too. Sampling reports a conservative interval:
 * ambiguous intervals count as uncoupled, never as proof of compliance. */
export function pairCouplingReports(input: SimpleRouteJson, traces: Trace[]) {
  const shared = sharedPairSpacingReports(input, traces)
  const all = [...(input.traces ?? []), ...traces]
  const segments = (name: string) =>
    all
      .filter((t) => t.connection_name === name || t.source_trace_id === name)
      .flatMap((t) =>
        t.route.slice(1).flatMap((b, i) => {
          const a = t.route[i]
          return a.route_type === "wire" &&
            b.route_type === "wire" &&
            a.layer === b.layer
            ? [{ a, b }]
            : []
        }),
      )
  return (input.differentialPairs ?? [])
    .filter(
      (p) => p.traceGap !== undefined || p.maxUncoupledLength !== undefined,
    )
    .map((pair) => {
      const routes = pair.connectionNames.map(segments)
      const gap =
        pair.traceGap ??
        input.minTraceToPadEdgeClearance ??
        input.defaultObstacleMargin ??
        0.075
      const tolerance = Math.max(0.002, gap * 0.1)
      const indexes = routes.map((route) => {
        const layers = new Set(route.map((s) => s.a.layer))
        return new Map(
          [...layers].map((layer) => [
            layer,
            new CopperIndex(
              route
                .filter((s) => s.a.layer === layer)
                .map((s) => ({
                  ...s,
                  radius: s.a.width / 2,
                  layer,
                  owners: [],
                })),
            ),
          ]),
        )
      })
      const conductors = routes.map((route, index) => {
        let uncoupled = 0,
          total = 0
        for (const { a, b } of route) {
          const span = distance(a, b),
            count = Math.max(1, Math.ceil(span / (tolerance / 2)))
          total += span
          const mate = indexes[1 - index].get(a.layer)
          const spacing = (p: { x: number; y: number }) =>
            mate?.distanceToPoint(
              p,
              (s) =>
                pointSegmentDistanceToPoints(p, s.a, s.b) -
                (a.width + s.radius * 2) / 2,
              a.width / 2,
            ) ?? Infinity
          for (let k = 0; k < count; k++) {
            const t = (k + 0.5) / count,
              p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
            const error = Math.abs(spacing(p) - gap)
            if (error + span / (2 * count) > tolerance)
              uncoupled += span / count
          }
        }
        return {
          name: pair.connectionNames[index],
          totalLengthMm: total,
          uncoupledLengthMm: uncoupled,
          coupledFraction: total ? 1 - uncoupled / total : 0,
        }
      })
      return {
        connectionNames: pair.connectionNames,
        conductors,
        maxUncoupledLengthMm: pair.maxUncoupledLength ?? null,
        matched:
          shared.find(
            (report) => report.connectionNames === pair.connectionNames,
          )!.matched &&
          (pair.maxUncoupledLength === undefined ||
            conductors.every(
              (c) => c.uncoupledLengthMm <= pair.maxUncoupledLength! + 1e-8,
            )),
      }
    })
}
