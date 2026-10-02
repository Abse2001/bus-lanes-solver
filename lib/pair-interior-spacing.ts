import { distance, length, pointSegmentDistance } from "./geometry"
import type { SimpleRouteJson, Trace } from "./types"

/** Independently sample physical pair spacing, excluding an explicit arclength
 * allowance at each terminal. Does not trust coupledSection metadata. Positions,
 * widths, sampling pitch and returned gaps are all in board-world millimetres. */
export function pairInteriorSpacing(
  input: SimpleRouteJson,
  traces: Trace[],
  approachLength: number,
  samplingPitch = 0.01,
) {
  return (input.differentialPairs ?? []).map((pair) => {
    const rails = pair.connectionNames.map((name) =>
      traces.find((t) => t.connection_name === name),
    )
    const conductors = rails.map((trace, side) => {
      let minGap = Infinity,
        maxGap = -Infinity,
        samples = 0,
        at = 0
      const mate = rails[1 - side]
      if (trace && mate) {
        const total = length(trace.route)
        const others = mate.route.slice(1).flatMap((b, i) => {
          const a = mate.route[i]
          return a.route_type === "wire" &&
            b.route_type === "wire" &&
            a.layer === b.layer
            ? [{ a, b }]
            : []
        })
        for (let i = 1; i < trace.route.length; i++) {
          const a = trace.route[i - 1],
            b = trace.route[i],
            span = distance(a, b)
          const lo = Math.max(0, approachLength - at),
            hi = Math.min(span, total - approachLength - at)
          if (
            span > 1e-10 &&
            hi >= lo &&
            a.route_type === "wire" &&
            b.route_type === "wire" &&
            a.layer === b.layer
          ) {
            const segments = others.filter((s) => s.a.layer === a.layer)
            const count = Math.max(1, Math.ceil((hi - lo) / samplingPitch))
            for (let k = 0; k <= count; k++) {
              const u = (lo + ((hi - lo) * k) / count) / span
              const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
              let gap = Infinity
              for (const s of segments)
                gap = Math.min(
                  gap,
                  pointSegmentDistance(p, [s.a, s.b]) -
                    (a.width + s.a.width) / 2,
                )
              minGap = Math.min(minGap, gap)
              maxGap = Math.max(maxGap, gap)
              samples++
            }
          }
          at += span
        }
      }
      return {
        name: pair.connectionNames[side],
        samples,
        minGapMm: samples ? minGap : null,
        maxGapMm: samples ? maxGap : null,
      }
    })
    return {
      connectionNames: pair.connectionNames,
      approachLengthMm: approachLength,
      samplingPitchMm: samplingPitch,
      conductors,
    }
  })
}
