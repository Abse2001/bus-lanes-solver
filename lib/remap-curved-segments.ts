import { distance } from "./geometry"
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
  return route
    .slice(1)
    .flatMap((b, i) =>
      chords.some(
        ([a0, b0]) => distance(route[i], a0) < 1e-7 && distance(b, b0) < 1e-7,
      )
        ? [i + 1]
        : [],
    )
}
