import { distance } from "./geometry"
import type { CompactionVertex } from "./compaction-motion-groups"
import type { Point } from "./types"

/** Remove simplex output rounding from rigid-group translations. Project only
 * onto the original edge directions; sampled arcs remain rigid and terminal
 * groups remain fixed. The caller still validates every resulting proposal. */
export function projectCompactionDirections(
  paths: CompactionVertex[][],
  values: ReadonlyMap<string, number>,
  pinStationary = true,
): Map<number, Point> {
  const shifts = new Map<number, Point>()
  for (const path of paths)
    for (const p of path)
      if (p.group !== undefined)
        shifts.set(p.group, {
          x:
            (values.get(`${p.group}_x_1`) ?? 0) -
            (values.get(`${p.group}_x_-1`) ?? 0),
          y:
            (values.get(`${p.group}_y_1`) ?? 0) -
            (values.get(`${p.group}_y_-1`) ?? 0),
        })
  // Keep numerically stationary coordinates exactly stationary. Otherwise
  // equality projection can drift across a tight, already-valid copper gap.
  const free = new Map<Point, Point>()
  for (const p of shifts.values()) {
    const axes = {
      x: !pinStationary || Math.abs(p.x) >= 1e-7 ? 1 : 0,
      y: !pinStationary || Math.abs(p.y) >= 1e-7 ? 1 : 0,
    }
    if (!axes.x) p.x = 0
    if (!axes.y) p.y = 0
    free.set(p, axes)
  }
  const edges = paths.flatMap((path) =>
    path.slice(1).flatMap((b, i) => {
      const a = path[i],
        span = distance(a, b)
      if (a.group === b.group) return []
      const normals =
        span < 1e-8
          ? [
              { x: 1, y: 0 },
              { x: 0, y: 1 },
            ]
          : [{ x: -(b.y - a.y) / span, y: (b.x - a.x) / span }]
      return normals.map((n) => ({
        a: shifts.get(a.group!),
        b: shifts.get(b.group!),
        n,
      }))
    }),
  )
  // Direction chains can amplify a small local residual at a fixed clearance
  // boundary. Resolve well below the final validators' geometric tolerances.
  for (let sweep = 0; sweep < 20000; sweep++) {
    let error = 0
    for (const { a, b, n } of edges) {
      const residual =
        ((b?.x ?? 0) - (a?.x ?? 0)) * n.x + ((b?.y ?? 0) - (a?.y ?? 0)) * n.y
      error = Math.max(error, Math.abs(residual))
      const aa = a ? free.get(a)! : { x: 0, y: 0 }
      const bb = b ? free.get(b)! : { x: 0, y: 0 }
      const denominator = (aa.x + bb.x) * n.x * n.x + (aa.y + bb.y) * n.y * n.y
      if (denominator < 1e-16) continue
      const adjustment = residual / denominator
      if (a) {
        a.x += adjustment * n.x * aa.x
        a.y += adjustment * n.y * aa.y
      }
      if (b) {
        b.x -= adjustment * n.x * bb.x
        b.y -= adjustment * n.y * bb.y
      }
    }
    if (error < 1e-14) break
  }
  return shifts
}
