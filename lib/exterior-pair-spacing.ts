import { CopperIndex } from "./copper-index"
import { distance, pointSegmentDistanceToPoints } from "./geometry"
import { packageApproachRegions, pointInBox } from "./package-approach-regions"
import type { Point, SimpleRouteJson, Trace } from "./types"

type Box = SimpleRouteJson["bounds"]
/** Exact parameter intervals outside the union of the two package regions. */
function exteriorIntervals(a: Point, b: Point, boxes: Box[]) {
  const inside: Array<[number, number]> = []
  for (const box of boxes) {
    let lo = 0,
      hi = 1
    for (const [axis, min, max] of [
      ["x", box.minX, box.maxX],
      ["y", box.minY, box.maxY],
    ] as const) {
      const delta = b[axis] - a[axis]
      if (Math.abs(delta) < 1e-15) {
        if (a[axis] < min || a[axis] > max) {
          lo = 1
          hi = 0
          break
        }
      } else {
        const p = (min - a[axis]) / delta,
          q = (max - a[axis]) / delta
        lo = Math.max(lo, Math.min(p, q))
        hi = Math.min(hi, Math.max(p, q))
      }
    }
    if (lo < hi) inside.push([lo, hi])
  }
  inside.sort((a, b) => a[0] - b[0])
  const outside: Array<[number, number]> = []
  let end = 0
  for (const [lo, hi] of inside) {
    if (lo > end) outside.push([end, lo])
    end = Math.max(end, hi)
  }
  if (end < 1) outside.push([end, 1])
  return outside
}

/** Check physical coupling outside native package/fanout regions, independently
 * of coupledSection annotations. Local breakouts are measured separately by
 * pairCouplingReports; a shortened annotation cannot hide a separated trunk. */
export function exteriorPairSpacingReports(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  const localDogbones = traces.flatMap((t) => {
    const vias = t.route.flatMap((p, i) => (p.route_type === "via" ? [i] : []))
    return vias.length === 2
      ? [
          { ...t, route: t.route.slice(0, vias[0] + 2) },
          { ...t, route: t.route.slice(vias[1] - 1).toReversed() },
        ]
      : []
  })
  return (input.differentialPairs ?? []).map((pair) => {
    const rails = pair.connectionNames.map((name) =>
      traces.find(
        (t) => t.connection_name === name || t.source_trace_id === name,
      ),
    )
    const width = Math.max(
      ...rails.flatMap(
        (t) =>
          t?.route.flatMap((p) => (p.route_type === "wire" ? [p.width] : [])) ??
          [],
      ),
    )
    const clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
    const gap = pair.traceGap ?? clearance
    // The whole pair envelope needs room around the outermost fanout copper.
    const regions = packageApproachRegions(
      { ...input, traces: [...(input.traces ?? []), ...localDogbones] },
      width + gap / 2 + clearance,
    )
    const fields = [0, 1].flatMap((end) => {
      const r = regions.find((r) =>
        rails.every(
          (t) =>
            t?.route.length &&
            pointInBox(end ? t.route.at(-1)! : t.route[0], r.copper),
        ),
      )
      return r ? [r.copper] : []
    })
    const applicable =
      (pair.traceGap !== undefined || pair.maxUncoupledLength !== undefined) &&
      fields.length === 2 &&
      rails.every((t) => t?.route.length)
    const base = { connectionNames: pair.connectionNames, applicable }
    if (!applicable)
      return {
        ...base,
        matched: true,
        maxExteriorEdgeGapMm: null,
        maxSamplingErrorMm: null,
        separatedExteriorLengthMm: null,
      }
    const segments = (trace: Trace) =>
      trace.route.slice(1).flatMap((b, i) => {
        const a = trace.route[i]
        return a.route_type === "wire" &&
          b.route_type === "wire" &&
          a.layer === b.layer
          ? [{ a, b, radius: a.width / 2, layer: a.layer, owners: [] }]
          : []
      })
    let max = -Infinity,
      error = 0,
      separated = 0
    const maxAllowed = (width + gap) / Math.cos(Math.PI / 8) - width + 0.002
    for (let side = 0; side < 2; side++) {
      const mate = segments(rails[1 - side]!)
      const indexes = new Map(
        [...new Set(mate.map((s) => s.layer))].map((layer) => [
          layer,
          new CopperIndex(mate.filter((s) => s.layer === layer)),
        ]),
      )
      for (const { a, b } of segments(rails[side]!)) {
        const span = distance(a, b)
        for (const [lo, hi] of exteriorIntervals(a, b, fields)) {
          const count = Math.max(1, Math.ceil(((hi - lo) * span) / 0.002))
          const step = ((hi - lo) * span) / count
          error = Math.max(error, step / 2)
          for (let k = 0; k < count; k++) {
            const t = lo + ((hi - lo) * (k + 0.5)) / count
            const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
            const spacing =
              (indexes
                .get(a.layer)
                ?.distanceToPoint(
                  p,
                  (s) => pointSegmentDistanceToPoints(p, s.a, s.b) - s.radius,
                ) ?? Infinity) -
              a.width / 2
            max = Math.max(max, spacing)
            if (spacing + step / 2 > maxAllowed) separated += step
          }
        }
      }
    }
    return {
      ...base,
      matched: separated === 0,
      maxExteriorEdgeGapMm: max === -Infinity ? null : max,
      maxSamplingErrorMm: error,
      separatedExteriorLengthMm: separated,
    }
  })
}
