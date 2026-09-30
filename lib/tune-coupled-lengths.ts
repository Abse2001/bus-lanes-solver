import { smoothPairedLobes } from "./smooth-tuning"
import { tuneSmoothLengths } from "./smooth-length-tuning"
import { fixedRouteLength, minimumLengthTargets } from "./route-lengths"
import { distance, length } from "./geometry"
import { VectorScene, fixedCopper, routeCopper } from "./vector-scene"
import { tuningPathIsSelfClear } from "./length-tuning"
import type { SimpleRouteJson, Trace, Point, Wire } from "./types"

/** Tune shared corridors jointly; residual skew corrections are restricted to
 * package approaches. All coordinates and planar copper lengths are board mm. */
export function tuneCoupledLengths(
  input: SimpleRouteJson,
  traces: Trace[],
): Trace[] {
  // First fix pair skew without allowing the individual tuner into the corridor.
  const pairedInput = { ...input, buses: [] }
  let result = tuneSmoothLengths(
    input,
    traces,
    minimumLengthTargets(pairedInput, traces),
  )
  const fixed = fixedCopper(input)
  const total = (trace: Trace) =>
    length(trace.route) + fixedRouteLength(input, trace.connection_name!)
  for (const pair of input.differentialPairs ?? []) {
    const indices = pair.connectionNames.map((n) =>
      result.findIndex((t) => t.connection_name === n),
    )
    const rails = indices.map((i) => result[i])
    if (rails.some((t) => !t.coupledSection)) continue
    const targets = minimumLengthTargets(input, result)
    const deficit = Math.max(
      ...rails.map((t) => targets.get(t.connection_name!)! - total(t)),
    )
    if (deficit < 1e-8) continue
    const width = (rails[0].route[0] as Wire).width
    const gap =
      pair.traceGap ??
      input.minTraceToPadEdgeClearance ??
      input.defaultObstacleMargin ??
      0.075
    const spacing = width + gap,
      clearance =
        input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
    let accepted: Trace[] | undefined
    for (
      let i = rails[0].coupledSection![0];
      i < rails[0].coupledSection![1] && !accepted;
      i++
    ) {
      const a = rails[0].route[i],
        b = rails[0].route[i + 1],
        span = distance(a, b)
      if (span < width * 8) continue
      const ux = (b.x - a.x) / span,
        uy = (b.y - a.y) / span
      for (
        let j = rails[1].coupledSection![0];
        j < rails[1].coupledSection![1] && !accepted;
        j++
      ) {
        const c = rails[1].route[j],
          d = rails[1].route[j + 1],
          otherSpan = distance(c, d)
        if (
          otherSpan < width * 8 ||
          Math.abs((d.x - c.x) / otherSpan - ux) > 1e-6 ||
          Math.abs((d.y - c.y) / otherSpan - uy) > 1e-6
        )
          continue
        const offset = -(c.x - a.x) * uy + (c.y - a.y) * ux
        if (Math.abs(Math.abs(offset) - spacing) > 1e-6) continue
        const project = (p: Point) => (p.x - a.x) * ux + (p.y - a.y) * uy
        const lo = Math.max(0, project(c)) + width * 2,
          hi = Math.min(span, project(d)) - width * 2
        if (hi - lo < width * 8) continue
        const center = (x: number) => ({
          x: a.x + ux * x - (uy * offset) / 2,
          y: a.y + uy * x + (ux * offset) / 2,
        })
        tuningCandidate: for (const fraction of [0.9, 0.65, 0.4])
          for (const lobes of [1, 2, 3, 4, 6, 8])
            for (const side of [1, -1]) {
              const margin = ((hi - lo) * (1 - fraction)) / 2
              const waves = smoothPairedLobes(
                center(lo + margin),
                center(hi - margin),
                spacing,
                deficit,
                lobes,
                side,
                Math.max(width * 1.2, clearance),
              )
              if (!waves) continue
              // The first rail is on the opposite side of the signed offset.
              const ordered = offset > 0 ? waves.toReversed() : waves
              const candidate = rails.map((t, k) => {
                const segment = k === 0 ? i : j,
                  points = [
                    ...t.route.slice(0, segment + 1),
                    ...ordered[k],
                    ...t.route.slice(segment + 1),
                  ]
                const added = points.length - t.route.length
                return {
                  ...t,
                  coupledSection: [
                    t.coupledSection![0],
                    t.coupledSection![1] + added,
                  ] as [number, number],
                  curvedSegments: points.slice(1).flatMap((p, n) => {
                    const dx = Math.abs(p.x - points[n].x),
                      dy = Math.abs(p.y - points[n].y)
                    return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8
                      ? [n + 1]
                      : []
                  }),
                  route: points.map((p) => ({
                    ...p,
                    route_type: "wire" as const,
                    layer: (t.route[0] as Wire).layer,
                    width,
                  })),
                }
              })
              const copper = [
                ...fixed,
                ...result
                  .filter((_, n) => !indices.includes(n))
                  .flatMap(routeCopper),
                ...candidate.flatMap(routeCopper),
              ]
              if (
                candidate.some(
                  (t, k) =>
                    !new VectorScene(
                      input,
                      input.connections.find(
                        (c) => c.name === t.connection_name,
                      )!,
                      width,
                      copper,
                    ).pathVisible(t.route) ||
                    !tuningPathIsSelfClear(t.route, width + clearance) ||
                    total(t) < targets.get(t.connection_name!)! - 1e-6,
                )
              )
                continue
              if (
                Math.abs(total(candidate[0]) - total(candidate[1])) >
                pair.lengthTolerance + 1e-6
              )
                continue
              accepted = candidate
              break tuningCandidate
            }
      }
    }
    if (!accepted)
      throw Error(
        `No shared tuning corridor for ${pair.connectionNames.join(", ")}`,
      )
    indices.forEach((index, k) => {
      result[index] = accepted![k]
    })
  }
  // Shared additions can raise overlapping bus targets; propagate before tuning singles.
  return tuneSmoothLengths(input, result, minimumLengthTargets(input, result))
}
