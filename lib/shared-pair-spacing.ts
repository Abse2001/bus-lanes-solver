import { distance, pointSegmentDistanceToPoints } from "./geometry"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Check both rails across the entire declared shared corridor, including
 * meanders. Package approaches remain outside this corridor. A 45-degree
 * miter increases nearest-rail distance by sec(22.5 degrees); allow that
 * geometric effect, but never allow independently wandering rails. */
export function sharedPairSpacingReports(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  return (input.differentialPairs ?? []).map((pair) => {
    const rails = pair.connectionNames.map((name) =>
      traces.find(
        (t) => t.connection_name === name || t.source_trace_id === name,
      ),
    )
    const paths = rails.map((t) =>
      t?.coupledSection
        ? t.route.slice(t.coupledSection[0], t.coupledSection[1] + 1)
        : [],
    )
    const valid =
      rails.every(
        (t) =>
          t?.coupledSection?.length === 2 &&
          t.coupledSection.every(Number.isInteger) &&
          t.coupledSection[0] >= 0 &&
          t.coupledSection[1] < t.route.length &&
          t.coupledSection[0] < t.coupledSection[1],
      ) &&
      paths.every(
        (path) =>
          path.length >= 2 &&
          path.every(
            (p) =>
              p.route_type === "wire" &&
              Number.isFinite(p.x) &&
              Number.isFinite(p.y) &&
              Number.isFinite(p.width) &&
              p.width > 0,
          ),
      ) &&
      paths
        .flat()
        .every((p) => (p as Wire).layer === (paths[0][0] as Wire)?.layer)
    const required =
      pair.traceGap !== undefined || pair.maxUncoupledLength !== undefined
    const gap =
      pair.traceGap ??
      input.minTraceToPadEdgeClearance ??
      input.defaultObstacleMargin ??
      0.075
    const base = {
      connectionNames: pair.connectionNames,
      requestedGapMm: pair.traceGap ?? null,
    }
    if (!valid)
      return {
        ...base,
        sharedSectionPresent: false,
        minEdgeGapMm: null,
        maxEdgeGapMm: null,
        maxSamplingErrorMm: null,
        sharedCopperMm: null,
        maxAllowedEdgeGapMm: null,
        matched: !required,
      }
    const widths = paths.map((path) => (path[0] as Wire).width)
    if (
      paths.some((path, side) =>
        path.some((p) => Math.abs((p as Wire).width - widths[side]) > 1e-8),
      )
    )
      return {
        ...base,
        sharedSectionPresent: false,
        minEdgeGapMm: null,
        maxEdgeGapMm: null,
        maxSamplingErrorMm: null,
        sharedCopperMm: null,
        maxAllowedEdgeGapMm: null,
        matched: !required,
      }
    const halfWidths = (widths[0] + widths[1]) / 2
    const maxAllowedEdgeGapMm =
      (halfWidths + gap) / Math.cos(Math.PI / 8) - halfWidths + 0.002
    let min = Infinity,
      max = -Infinity,
      maxSamplingErrorMm = 0
    const sharedCopperMm = [0, 0]
    for (let side = 0; side < 2; side++) {
      const path = paths[side] as Wire[],
        mate = rails[1 - side]!.route
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1],
          b = path[i],
          span = distance(a, b)
        const steps = Math.max(1, Math.ceil(span / 0.002))
        sharedCopperMm[side] += span
        // Distance to a polyline is 1-Lipschitz. Include the half-interval
        // error bound so an excursion between samples cannot pass.
        maxSamplingErrorMm = Math.max(maxSamplingErrorMm, span / (2 * steps))
        for (let j = 0; j < steps; j++) {
          const fraction = (j + 0.5) / steps
          const p = {
            x: a.x + (b.x - a.x) * fraction,
            y: a.y + (b.y - a.y) * fraction,
          }
          let separation = Infinity
          for (let k = 1; k < mate.length; k++) {
            const u = mate[k - 1],
              v = mate[k]
            if (
              u.route_type !== "wire" ||
              v.route_type !== "wire" ||
              u.layer !== a.layer ||
              v.layer !== a.layer
            )
              continue
            separation = Math.min(
              separation,
              pointSegmentDistanceToPoints(p, u, v) - (a.width + u.width) / 2,
            )
          }
          min = Math.min(min, separation)
          max = Math.max(max, separation)
        }
      }
    }
    return {
      ...base,
      sharedSectionPresent: true,
      minEdgeGapMm: min,
      maxEdgeGapMm: max,
      maxSamplingErrorMm,
      sharedCopperMm,
      maxAllowedEdgeGapMm,
      matched:
        !required ||
        (sharedCopperMm.every((n) => n > 0) &&
          max + maxSamplingErrorMm <= maxAllowedEdgeGapMm),
    }
  })
}
