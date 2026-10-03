import { distance } from "./geometry"
import type { Trace, Wire } from "./types"

/** Smooth routes turn by at most 45 degrees at an ordinary corner or sampled
 * curve point. Repeated points cannot conceal a sharp handoff. */
export function routeAnglesAreConventional(traces: Trace[]): boolean {
  return traces.every((trace) => {
    let previous: Wire | undefined
    let direction: { x: number; y: number } | undefined
    for (const point of trace.route) {
      if (point.route_type !== "wire") {
        previous = direction = undefined
        continue
      }
      if (!previous || previous.layer !== point.layer) {
        previous = point
        direction = undefined
        continue
      }
      const span = distance(previous, point)
      if (span < 1e-8) continue
      const next = {
        x: (point.x - previous.x) / span,
        y: (point.y - previous.y) / span,
      }
      if (
        direction &&
        direction.x * next.x + direction.y * next.y <
          Math.cos((45.2 * Math.PI) / 180)
      )
        return false
      previous = point
      direction = next
    }
    return true
  })
}
