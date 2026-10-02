import { offsetPath } from "./coupled-pair-routing"
import { distance } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import {
  fixedCopper,
  routeCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

/** Replace tight, two-corner returns with tangent semicircles. Both rails are
 * offsets of the same centerline; never round one member independently. This
 * changes lengths and must run before length matching. */
export function roundCoupledReturnBends(
  input: SimpleRouteJson,
  traces: Trace[],
  fixed: Copper[] = fixedCopper(input),
): Trace[] {
  const result = [...traces]
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const chords = 32
  for (const pair of input.differentialPairs ?? []) {
    const indices = pair.connectionNames.map((name) =>
      result.findIndex((t) => t.connection_name === name),
    )
    const rails = indices.map((index) => result[index])
    if (rails.some((t) => !t?.coupledSection)) continue
    const sections = rails.map((t) =>
      t.route.slice(t.coupledSection![0], t.coupledSection![1] + 1),
    )
    const width = (sections[0][0] as Wire).width
    if (
      sections[0].length !== sections[1].length ||
      sections
        .flat()
        .some(
          (p) =>
            p.route_type !== "wire" ||
            p.width !== width ||
            p.layer !== (sections[0][0] as Wire).layer,
        )
    )
      continue
    const center = sections[0].map((p, i) => ({
      x: (p.x + sections[1][i].x) / 2,
      y: (p.y + sections[1][i].y) / 2,
    }))
    const halfSpacing = (width + (pair.traceGap ?? clearance)) / 2
    const offsets = [-halfSpacing, halfSpacing].sort(
      (a, b) =>
        distance(offsetPath(center, a)[0], sections[0][0]) -
        distance(offsetPath(center, b)[0], sections[0][0]),
    )
    const other = result
      .filter((_, i) => !indices.includes(i))
      .flatMap(routeCopper)
    for (let i = 1; i + 2 < center.length; i++) {
      // Do not replace an already tuned or rounded portion of the corridor.
      if (
        rails.some((t) =>
          t.curvedSegments?.some(
            (k) =>
              k >= t.coupledSection![0] + i &&
              k <= t.coupledSection![0] + i + 2,
          ),
        )
      )
        continue
      const [a, b, c, d] = center.slice(i - 1, i + 3)
      const before = distance(a, b),
        after = distance(c, d)
      if (Math.min(before, after) < 1e-8) continue
      const u = { x: (b.x - a.x) / before, y: (b.y - a.y) / before }
      const v = { x: (d.x - c.x) / after, y: (d.y - c.y) / after }
      if (u.x * v.x + u.y * v.y > -1 + 1e-8) continue
      const n = { x: -u.y, y: u.x }
      const separation = (c.x - b.x) * n.x + (c.y - b.y) * n.y
      const turn = Math.sign(separation),
        radius = Math.abs(separation) / 2
      // Account for the polygonal offset's miter before testing inner clearance.
      if (
        radius <
        halfSpacing / Math.cos(Math.PI / (2 * chords)) +
          (width + clearance) / 2 +
          1e-8
      )
        continue
      const advance = (b.x - c.x) * u.x + (b.y - c.y) * u.y
      const trimBefore = Math.max(0, advance),
        trimAfter = Math.max(0, -advance)
      if (trimBefore >= before - 1e-8 || trimAfter >= after - 1e-8) continue
      const start = { x: b.x - u.x * trimBefore, y: b.y - u.y * trimBefore }
      const end = { x: c.x + v.x * trimAfter, y: c.y + v.y * trimAfter }
      const origin = {
        x: start.x + n.x * radius * turn,
        y: start.y + n.y * radius * turn,
      }
      const angle = Math.atan2(start.y - origin.y, start.x - origin.x)
      const arc: Point[] = Array.from({ length: chords + 1 }, (_, k) => ({
        x: origin.x + radius * Math.cos(angle + (turn * Math.PI * k) / chords),
        y: origin.y + radius * Math.sin(angle + (turn * Math.PI * k) / chords),
      }))
      arc[0] = start
      arc[chords] = end
      const points = [...center.slice(0, i), ...arc, ...center.slice(i + 2)]
      const delta = chords - 1
      const candidate = rails.map((t, side): Trace => {
        const [s, e] = t.coupledSection!
        const mid = offsetPath(points, offsets[side]).map((p) => ({
          ...p,
          route_type: "wire" as const,
          layer: (sections[side][0] as Wire).layer,
          width,
        }))
        mid[0] = { ...t.route[s] } as Wire
        mid[mid.length - 1] = { ...t.route[e] } as Wire
        return {
          ...t,
          route: [...t.route.slice(0, s), ...mid, ...t.route.slice(e + 1)],
          coupledSection: [s, e + delta],
          curvedSegments: [
            ...(t.curvedSegments ?? []).map((k) =>
              k > s + i + 1 ? k + delta : k,
            ),
            ...Array.from({ length: chords }, (_, k) => s + i + k + 1),
          ].sort((a, b) => a - b),
        }
      })
      const copper = [...fixed, ...other, ...candidate.flatMap(routeCopper)]
      if (
        candidate.some(
          (t) =>
            !tuningPathIsSelfClear(t.route, width + clearance) ||
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
      indices.forEach((index, side) => {
        result[index] = candidate[side]
      })
      break
    }
  }
  return result
}
