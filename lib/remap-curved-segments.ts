import { distance, pointSegmentDistanceToPoints } from "./geometry"
import type { Point, Trace } from "./types"

/** Preserve annotations only for curve chords whose geometry survives an edit.
 * A new non-octilinear segment is never declared a curve just by its angle. */
export function remapCurvedSegments(trace: Trace, route: Point[]): number[] {
  const chords = (trace.curvedSegments ?? []).flatMap((i) =>
    i > 0 && i < trace.route.length
      ? [[trace.route[i - 1], trace.route[i]]]
      : [],
  )
  if (!chords.length) return []
  const curved = new Set(trace.curvedSegments)
  return route.slice(1).flatMap((b, i) => {
    const a = route[i]
    if (
      chords.some(
        ([a0, b0]) => distance(a, a0) < 1e-7 && distance(b, b0) < 1e-7,
      )
    )
      return [i + 1]
    // Simplification may coalesce collinear chords of the same existing arc.
    // Preserve that provenance only when every old chord is annotated and
    // lies on the replacement; a new shortcut through an arc is not a curve.
    const start = trace.route.findIndex((p) => distance(p, a) < 1e-7)
    const end = trace.route.findIndex((p) => distance(p, b) < 1e-7)
    if (start < 0 || end <= start) return []
    for (let k = start + 1; k <= end; k++)
      if (
        !curved.has(k) ||
        pointSegmentDistanceToPoints(trace.route[k - 1], a, b) > 1e-10 ||
        pointSegmentDistanceToPoints(trace.route[k], a, b) > 1e-10
      )
        return []
    return [i + 1]
  })
}
