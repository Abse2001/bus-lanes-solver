import { offsetPath } from "./coupled-pair-routing"
import { distance } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

/** Bevel a shared centerline jointly before matching. Offset both rails and
 * retain a candidate only when clearance and coupling survive the change. */
export function bevelCoupledCorners(
  input: SimpleRouteJson,
  traces: Trace[],
): Trace[] {
  const result = [...traces],
    fixed = fixedCopper(input)
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  for (const pair of input.differentialPairs ?? []) {
    const indices = pair.connectionNames.map((n) =>
      result.findIndex((t) => t.connection_name === n),
    )
    const rails = indices.map((i) => result[i])
    if (
      rails.some(
        (t) =>
          !t?.coupledSection ||
          t.curvedSegments?.some(
            (k) => k > t.coupledSection![0] && k <= t.coupledSection![1],
          ),
      )
    )
      continue
    const sections = rails.map(
      (t) =>
        t.route.slice(t.coupledSection![0], t.coupledSection![1] + 1) as Wire[],
    )
    if (sections[0].length !== sections[1].length) continue
    const width = sections[0][0].width,
      halfSpacing = (width + (pair.traceGap ?? clearance)) / 2
    let center = sections[0].map((p, i) => ({
      x: (p.x + sections[1][i].x) / 2,
      y: (p.y + sections[1][i].y) / 2,
    }))
    const offsets = [-halfSpacing, halfSpacing].sort(
      (a, b) =>
        distance(offsetPath(center, a)[0], sections[0][0]) -
        distance(offsetPath(center, b)[0], sections[0][0]),
    )
    const rebuild = (points: Point[]): Trace[] =>
      rails.map((t, side) => {
        const [s, e] = t.coupledSection!,
          mid = offsetPath(points, offsets[side]).map((p) => ({
            ...p,
            route_type: "wire" as const,
            layer: sections[side][0].layer,
            width,
          }))
        const delta = mid.length - (e - s + 1)
        return {
          ...t,
          route: [...t.route.slice(0, s), ...mid, ...t.route.slice(e + 1)],
          coupledSection: [s, e + delta],
          curvedSegments: t.curvedSegments?.map((k) => (k > e ? k + delta : k)),
        }
      })
    const others = result
      .filter((_, i) => !indices.includes(i))
      .flatMap(routeCopper)
    let latest = rails
    for (let i = 1; i + 1 < center.length; i++) {
      const [a, b, c] = center.slice(i - 1, i + 2),
        before = distance(a, b),
        after = distance(b, c)
      if (Math.min(before, after) < 1e-8) continue
      const u = { x: (b.x - a.x) / before, y: (b.y - a.y) / before },
        v = { x: (c.x - b.x) / after, y: (c.y - b.y) / after },
        dot = u.x * v.x + u.y * v.y
      if (dot > Math.SQRT1_2 - 1e-8) continue
      for (let attempt = 0; attempt < 10; attempt++) {
        const trim = Math.min(width * 10, before / 2, after / 2) / 2 ** attempt
        const start = { x: b.x - u.x * trim, y: b.y - u.y * trim },
          end = { x: b.x + v.x * trim, y: b.y + v.y * trim }
        const turn = Math.sign(u.x * v.y - u.y * v.x),
          bevel = (Math.SQRT2 - 1) * trim
        const middle = {
          x: start.x + (u.x - turn * u.y) * Math.SQRT1_2 * bevel,
          y: start.y + (u.y + turn * u.x) * Math.SQRT1_2 * bevel,
        }
        const inserted = dot < -0.1 ? [start, middle, end] : [start, end]
        const points = [
            ...center.slice(0, i),
            ...inserted,
            ...center.slice(i + 1),
          ],
          candidate = rebuild(points)
        if (
          candidate.some(
            (t, side) =>
              tuningPathIsSelfClear(latest[side].route, width + clearance) &&
              !tuningPathIsSelfClear(t.route, width + clearance),
          )
        )
          continue
        const copper = [...fixed, ...others, ...candidate.flatMap(routeCopper)]
        if (
          candidate.some(
            (t) =>
              !new VectorScene(
                input,
                input.connections.find((c) => c.name === t.connection_name)!,
                width,
                copper,
              ).pathVisible(t.route),
          )
        )
          continue
        if (
          sharedPairSpacingReports(
            { ...input, differentialPairs: [pair] },
            candidate,
          ).some((p) => !p.matched)
        )
          continue
        center = points
        latest = candidate
        i += inserted.length - 1
        break
      }
    }
    indices.forEach((index, side) => {
      result[index] = latest[side]
    })
  }
  return result
}
