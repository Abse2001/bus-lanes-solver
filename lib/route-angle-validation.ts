import { distance } from "./geometry"
import type { Trace } from "./types"

/** Smooth routes turn by at most 45 degrees at an ordinary corner or sampled
 * curve point. Curve annotations never excuse a sharp handoff. */
export function routeAnglesAreConventional(traces: Trace[]): boolean {
  return traces.every((trace) => {
    for (let i = 1; i + 1 < trace.route.length; i++) {
      const [a, b, c] = trace.route.slice(i - 1, i + 2)
      if (
        a.route_type !== "wire" ||
        b.route_type !== "wire" ||
        c.route_type !== "wire" ||
        a.layer !== b.layer ||
        b.layer !== c.layer
      )
        continue
      const before = distance(a, b),
        after = distance(b, c)
      if (before < 1e-8 || after < 1e-8) continue
      const cosine =
        ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
        (before * after)
      if (cosine < Math.cos((45.2 * Math.PI) / 180)) return false
    }
    return true
  })
}
