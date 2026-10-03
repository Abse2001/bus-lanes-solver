import { coalesceSharedRuns } from "./coalesce-shared-runs"
import { distance } from "./geometry"
import type { Trace, Wire } from "./types"

/** Select a genuine parallel overlap for a paired tuning bank. Package bevels
 * can leave different numbers of vertices on the two rails. Splitting those
 * rails at the same projections preserves copper and the measured coupling. */
export function sharedStraightSection(
  rails: Trace[],
  spacing: number,
): Trace[] | null {
  rails = coalesceSharedRuns(rails)
  let best:
    | {
        indices: number[]
        low: number
        high: number
        direction: { x: number; y: number }
      }
    | undefined
  for (
    let i = rails[0].coupledSection![0];
    i < rails[0].coupledSection![1];
    i++
  ) {
    const a = rails[0].route[i],
      b = rails[0].route[i + 1],
      span = distance(a, b)
    if (span < 1e-8 || rails[0].curvedSegments?.includes(i + 1)) continue
    const u = { x: (b.x - a.x) / span, y: (b.y - a.y) / span }
    const projection = (p: { x: number; y: number }) => p.x * u.x + p.y * u.y
    for (
      let j = rails[1].coupledSection![0];
      j < rails[1].coupledSection![1];
      j++
    ) {
      const c = rails[1].route[j],
        d = rails[1].route[j + 1],
        otherSpan = distance(c, d)
      if (otherSpan < 1e-8 || rails[1].curvedSegments?.includes(j + 1)) continue
      if (
        Math.abs((d.x - c.x) / otherSpan - u.x) > 1e-7 ||
        Math.abs((d.y - c.y) / otherSpan - u.y) > 1e-7
      )
        continue
      if (
        Math.abs(Math.abs((c.x - a.x) * u.y - (c.y - a.y) * u.x) - spacing) >
        1e-7
      )
        continue
      const low = Math.max(projection(a), projection(c)),
        high = Math.min(projection(b), projection(d))
      if (high - low > 1e-8 && (!best || high - low > best.high - best.low))
        best = { indices: [i, j], low, high, direction: u }
    }
  }
  if (!best) return null
  const { indices, low, high, direction: u } = best
  return rails.map((trace, side) => {
    const index = indices[side],
      a = trace.route[index] as Wire,
      b = trace.route[index + 1]
    const point = (projection: number): Wire => {
      const advance = projection - a.x * u.x - a.y * u.y
      return { ...a, x: a.x + advance * u.x, y: a.y + advance * u.y }
    }
    const start = point(low),
      end = point(high)
    const before = trace.route.slice(0, index),
      after = trace.route.slice(index + 2)
    if (distance(a, start) > 1e-8) before.push(a)
    if (distance(b, end) > 1e-8) after.unshift(b)
    const route = [...before, start, end, ...after],
      change = route.length - trace.route.length
    return {
      ...trace,
      route,
      coupledSection: [before.length, before.length + 1] as [number, number],
      curvedSegments: trace.curvedSegments?.map((k) =>
        k > index + 1 ? k + change : k,
      ),
    }
  })
}
