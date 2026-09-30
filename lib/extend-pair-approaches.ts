import { distance } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import type { Connection, Point, SimpleRouteJson, Trace } from "./types"

/** Extend shared geometry into parallel package approaches. Use one offset path
 * around the connecting bend instead of two independently shaped returns.
 * Board-world points in mm, +X right, +Y up; original terminals remain fixed. */
export function extendPairApproaches(
  input: SimpleRouteJson,
  members: Connection[],
  traces: Trace[],
  fixed: Copper[],
  width: number,
  gap: number,
  clearance: number,
  offsetPath: (path: Point[], offset: number) => Point[],
): Trace[] {
  const result = traces.map((t) => ({ ...t, route: [...t.route] }))
  const pitch = width + gap
  for (let leader = 0; leader < 2; leader++) {
    const first = result[leader],
      mate = result[1 - leader]
    if (!first.coupledSection || !mate.coupledSection) continue
    const start = first.coupledSection[1] - 1,
      mateStart = mate.coupledSection[1] - 1
    for (let i = first.coupledSection[1] + 1; i < first.route.length - 1; i++) {
      const a = first.route[i],
        b = first.route[i + 1],
        span = distance(a, b)
      if (span < 4 * pitch) continue
      const u = { x: (b.x - a.x) / span, y: (b.y - a.y) / span }
      for (let j = mate.coupledSection[1] + 1; j < mate.route.length - 1; j++) {
        const c = mate.route[j],
          d = mate.route[j + 1],
          otherSpan = distance(c, d)
        if (
          otherSpan < 4 * pitch ||
          Math.abs((d.x - c.x) / otherSpan - u.x) > 1e-7 ||
          Math.abs((d.y - c.y) / otherSpan - u.y) > 1e-7
        )
          continue
        const offset = -(c.x - a.x) * u.y + (c.y - a.y) * u.x
        if (Math.abs(Math.abs(offset) - pitch) > 1e-7) continue
        const projection = (p: Point) => (p.x - a.x) * u.x + (p.y - a.y) * u.y
        if (projection(d) < span - 1e-7 || projection(c) > span - 4 * pitch)
          continue
        let shared: Point[]
        try {
          shared = offsetPath(first.route.slice(start, i + 2), offset)
        } catch {
          continue
        }
        const originalStart = mate.route[mateStart],
          originalEnd = mate.route[mateStart + 1]
        const dx = originalEnd.x - originalStart.x,
          dy = originalEnd.y - originalStart.y
        if (
          Math.abs(
            (shared[0].x - originalStart.x) * dy -
              (shared[0].y - originalStart.y) * dx,
          ) > 1e-7
        )
          continue
        if (distance(shared[0], originalStart) < 1e-8) shared = shared.slice(1)
        const route = [
          ...mate.route.slice(0, mateStart + 1),
          ...shared.map((p) => ({ ...mate.route[0], ...p })),
          ...mate.route.slice(
            distance(shared.at(-1)!, mate.route[j + 1]) < 1e-8 ? j + 2 : j + 1,
          ),
        ]
        if (
          !tuningPathIsSelfClear(route, width + clearance) ||
          !new VectorScene(input, members[1 - leader], width, [
            ...fixed,
            ...routeCopper(first),
          ]).pathVisible(route)
        )
          continue
        mate.route = route
        mate.coupledSection = [
          mate.coupledSection[0],
          mateStart + shared.length,
        ]
        first.coupledSection = [first.coupledSection[0], i + 1]
        return result
      }
    }
  }
  return traces
}
