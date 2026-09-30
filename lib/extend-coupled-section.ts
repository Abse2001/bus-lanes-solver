import { distance } from "./geometry"
import type { Trace, Wire } from "./types"

/** Include collinear approach copper that already continues the paired trunk.
 * Only redundant vertices/section boundaries change; copper does not move. */
export function extendCoupledSectionEnds(traces: Trace[]): Trace[] {
  if (traces.length !== 2 || traces.some((t) => !t.coupledSection))
    return traces
  const ends = traces.map((t) => t.coupledSection![1])
  const points = traces.map((t, i) => t.route[ends[i]])
  const directions = traces.map((t, i) => {
    const a = t.route[ends[i] - 1],
      b = points[i],
      d = distance(a, b)
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }
  })
  if (distance(directions[0], directions[1]) > 1e-7) return traces
  const direction = directions[0]
  const spans = traces.map((t, i) => {
    let span = 0
    for (let k = ends[i] + 1; k < t.route.length; k++) {
      const p = t.route[k],
        dx = p.x - points[i].x,
        dy = p.y - points[i].y
      const along = dx * direction.x + dy * direction.y
      if (Math.abs(dx * direction.y - dy * direction.x) > 1e-8 || along < span)
        break
      span = along
    }
    return span
  })
  const advance = Math.min(...spans)
  if (advance < 1e-8) return traces
  return traces.map((t, i) => {
    const endpoint = {
      ...points[i],
      x: points[i].x + direction.x * advance,
      y: points[i].y + direction.y * advance,
    } as Wire
    let tail = ends[i] + 1
    while (tail < t.route.length) {
      const dx = t.route[tail].x - points[i].x,
        dy = t.route[tail].y - points[i].y
      if (
        Math.abs(dx * direction.y - dy * direction.x) > 1e-8 ||
        dx * direction.x + dy * direction.y > advance + 1e-8
      )
        break
      tail++
    }
    return {
      ...t,
      curvedSegments: t.curvedSegments
        ?.filter((n) => n <= ends[i] || n >= tail)
        .map((n) => (n >= tail ? n - (tail - ends[i] - 1) : n)),
      route: [...t.route.slice(0, ends[i]), endpoint, ...t.route.slice(tail)],
    }
  })
}
