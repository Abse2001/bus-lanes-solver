import { distance } from "./geometry"
import type { Trace } from "./types"

/** Remove only redundant straight vertices inside a paired corridor. Preserve
 * terminal approaches, curve chords, endpoints, and copper length. */
export function coalesceSharedRuns(rails: Trace[]): Trace[] {
  return rails.map((trace) => {
    const [start, end] = trace.coupledSection!
    const keep = trace.route
      .map((_, i) => i)
      .filter((i) => {
        if (
          i <= start ||
          i >= end ||
          trace.curvedSegments?.includes(i) ||
          trace.curvedSegments?.includes(i + 1)
        )
          return true
        const a = trace.route[i - 1],
          b = trace.route[i],
          c = trace.route[i + 1],
          ab = distance(a, b),
          bc = distance(b, c)
        return (
          ab < 1e-8 ||
          bc < 1e-8 ||
          Math.abs((b.x - a.x) / ab - (c.x - b.x) / bc) > 1e-7 ||
          Math.abs((b.y - a.y) / ab - (c.y - b.y) / bc) > 1e-7
        )
      })
    return {
      ...trace,
      route: keep.map((i) => trace.route[i]),
      coupledSection: [keep.indexOf(start), keep.indexOf(end)] as [
        number,
        number,
      ],
      curvedSegments: trace.curvedSegments
        ?.map((i) => keep.indexOf(i))
        .filter((i) => i > 0),
    }
  })
}
