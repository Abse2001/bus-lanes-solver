import type { Trace } from "./types"

/** Join adjacent straight shared segments without moving copper or handoffs.
 * A sampled curve chord protects both of its vertices, including its tangent
 * endpoints. Only unannotated interior vertices of the shared section qualify.
 */
export function coalesceCoupledStraightSegments(traces: Trace[]): Trace[] {
  return traces.map((trace) => {
    const section = trace.coupledSection
    if (!section) return trace
    const [start, end] = section,
      curved = new Set(trace.curvedSegments ?? []),
      retained: number[] = []
    for (let index = 0; index < trace.route.length; index++) {
      while (retained.length > 1) {
        const middle = retained.at(-1)!,
          before = retained.at(-2)!,
          a = trace.route[before],
          b = trace.route[middle],
          c = trace.route[index]
        if (
          middle <= start ||
          middle >= end ||
          curved.has(middle) ||
          curved.has(middle + 1) ||
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          c.route_type !== "wire" ||
          a.layer !== b.layer ||
          b.layer !== c.layer ||
          a.width !== b.width ||
          b.width !== c.width
        )
          break
        const ux = b.x - a.x,
          uy = b.y - a.y,
          vx = c.x - b.x,
          vy = c.y - b.y,
          cross = ux * vy - uy * vx,
          roundoff =
            16 *
            Number.EPSILON *
            Math.max(1, Math.abs(ux * vy), Math.abs(uy * vx))
        if (ux * vx + uy * vy <= 0 || Math.abs(cross) > roundoff) break
        retained.pop()
      }
      retained.push(index)
    }
    if (retained.length === trace.route.length) return trace
    const remap = new Map(retained.map((old, index) => [old, index]))
    return {
      ...trace,
      route: retained.map((index) => trace.route[index]),
      coupledSection: [remap.get(start)!, remap.get(end)!],
      curvedSegments: trace.curvedSegments?.map((index) => remap.get(index)!),
    }
  })
}
