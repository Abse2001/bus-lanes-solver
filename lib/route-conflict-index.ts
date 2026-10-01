import { segmentDistance } from "./geometry"
import type { Point } from "./types"

type RouteGeometry = {
  edges: [Point, Point][]
  bounds: Float64Array
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** Geometry shared by immutable alternatives during a negotiation. The first
 * intersecting segment pair retains the original nested-loop order because it
 * also determines where the routing history receives its penalty. */
export class RouteConflictIndex {
  private geometry = new WeakMap<Point[], RouteGeometry>()
  private conflicts = new WeakMap<
    Point[],
    WeakMap<Point[], { required: number; result: [number, number] | null }>
  >()

  private getGeometry(route: Point[]): RouteGeometry {
    const cached = this.geometry.get(route)
    if (cached) return cached
    const edges: [Point, Point][] = []
    const bounds = new Float64Array(Math.max(0, route.length - 1) * 4)
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1],
        b = route[i],
        offset = (i - 1) * 4
      edges.push([a, b])
      bounds[offset] = Math.min(a.x, b.x)
      bounds[offset + 1] = Math.max(a.x, b.x)
      bounds[offset + 2] = Math.min(a.y, b.y)
      bounds[offset + 3] = Math.max(a.y, b.y)
      minX = Math.min(minX, bounds[offset])
      maxX = Math.max(maxX, bounds[offset + 1])
      minY = Math.min(minY, bounds[offset + 2])
      maxY = Math.max(maxY, bounds[offset + 3])
    }
    const result = { edges, bounds, minX, maxX, minY, maxY }
    this.geometry.set(route, result)
    return result
  }

  firstConflict(
    first: Point[],
    second: Point[],
    required: number,
  ): [number, number] | null {
    let row = this.conflicts.get(first)
    const cached = row?.get(second)
    if (cached?.required === required) return cached.result
    if (!row) {
      row = new WeakMap()
      this.conflicts.set(first, row)
    }
    const a = this.getGeometry(first),
      b = this.getGeometry(second)
    let result: [number, number] | null = null
    if (
      a.maxX + required >= b.minX &&
      b.maxX + required >= a.minX &&
      a.maxY + required >= b.minY &&
      b.maxY + required >= a.minY
    ) {
      conflict: for (let i = 0; i < a.edges.length; i++) {
        const ai = i * 4
        for (let j = 0; j < b.edges.length; j++) {
          const bj = j * 4
          if (
            a.bounds[ai + 1] + required < b.bounds[bj] ||
            b.bounds[bj + 1] + required < a.bounds[ai] ||
            a.bounds[ai + 3] + required < b.bounds[bj + 2] ||
            b.bounds[bj + 3] + required < a.bounds[ai + 2]
          )
            continue
          if (segmentDistance(a.edges[i], b.edges[j]) < required) {
            result = [i + 1, j + 1]
            break conflict
          }
        }
      }
    }
    row.set(second, { required, result })
    return result
  }
}
