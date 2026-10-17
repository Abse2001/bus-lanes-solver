import {
  distance,
  pointSegmentDistanceToPoints,
  segmentDistance,
} from "./geometry"
import type { Point, SimpleRouteJson, Trace } from "./types"

const epsilon = 1e-9
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/** A single simple polygon, optionally closed by repeating its first vertex.
 * Neither vertex order nor the caller's native outline is changed. */
function polygonEdges(outline: Point[]) {
  const points =
    outline.length > 1 && distance(outline[0], outline.at(-1)!) < epsilon
      ? outline.slice(0, -1)
      : outline
  if (
    points.length < 3 ||
    points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    throw Error("Board outline requires at least three finite vertices")
  const edges = points.map(
    (a, i) => [a, points[(i + 1) % points.length]] as const,
  )
  if (edges.some(([a, b]) => distance(a, b) < epsilon))
    throw Error("Board outline has a zero-length edge")
  let twiceArea = 0
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i],
      c = points[(i + 2) % points.length]
    twiceArea += a.x * b.y - b.x * a.y
    if (
      Math.abs(cross(a, b, c)) < epsilon &&
      (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0
    )
      throw Error("Board outline has overlapping adjacent edges")
    for (let j = i + 2; j < edges.length; j++) {
      if (i === 0 && j === edges.length - 1) continue
      if (segmentDistance([a, b], [...edges[j]]) < epsilon)
        throw Error("Board outline is self-intersecting")
    }
  }
  if (Math.abs(twiceArea) < epsilon)
    throw Error("Board outline has no interior area")
  return edges
}

/** Continuous capsule containment; copper radius and board-edge clearance are
 * both measured from the actual polygon, including concave cutouts. Bounds
 * remain an additional routing limit rather than replacing the outline. */
export class BoardBoundary {
  readonly edges: ReadonlyArray<readonly [Point, Point]>
  constructor(readonly input: SimpleRouteJson) {
    const { minX, maxX, minY, maxY } = input.bounds
    if (
      ![minX, maxX, minY, maxY].every(Number.isFinite) ||
      minX >= maxX ||
      minY >= maxY ||
      !Number.isFinite(input.minBoardEdgeClearance ?? 0) ||
      (input.minBoardEdgeClearance ?? 0) < 0
    )
      throw Error("Invalid board bounds or edge clearance")
    this.edges = input.outline?.length ? polygonEdges(input.outline) : []
  }
  private pointInside(p: Point) {
    let inside = false
    for (const [a, b] of this.edges) {
      if (pointSegmentDistanceToPoints(p, a, b) < epsilon) return true
      if (
        a.y > p.y !== b.y > p.y &&
        p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)
      )
        inside = !inside
    }
    return inside
  }
  containsSegment(a: Point, b: Point, radius: number) {
    if (![a.x, a.y, b.x, b.y, radius].every(Number.isFinite) || radius < 0)
      return false
    const margin = radius + (this.input.minBoardEdgeClearance ?? 0),
      bounds = this.input.bounds
    if (
      Math.min(a.x, b.x) < bounds.minX + margin - epsilon ||
      Math.max(a.x, b.x) > bounds.maxX - margin + epsilon ||
      Math.min(a.y, b.y) < bounds.minY + margin - epsilon ||
      Math.max(a.y, b.y) > bounds.maxY - margin + epsilon
    )
      return false
    if (!this.edges.length) return true
    if (!this.pointInside(a) || !this.pointInside(b)) return false
    const required = Math.max(margin - epsilon, epsilon)
    for (const [c, d] of this.edges) {
      if (
        Math.max(a.x, b.x) + required < Math.min(c.x, d.x) ||
        Math.max(c.x, d.x) + required < Math.min(a.x, b.x) ||
        Math.max(a.y, b.y) + required < Math.min(c.y, d.y) ||
        Math.max(c.y, d.y) + required < Math.min(a.y, b.y)
      )
        continue
      if (segmentDistance([a, b], [c, d]) < required) return false
    }
    return true
  }
  /** Octilinear candidates surrounding polygon corners. Exact capsule tests
   * discard candidates outside the inset, for either polygon winding. */
  vertices(radius: number): Point[] {
    const margin = radius + (this.input.minBoardEdgeClearance ?? 0) + 1e-5
    return this.edges.flatMap(([p]) =>
      [-1, 0, 1].flatMap((x) =>
        [-1, 0, 1].flatMap((y) => {
          if (!x && !y) return []
          const candidate = { x: p.x + x * margin, y: p.y + y * margin }
          return this.containsSegment(candidate, candidate, radius)
            ? [candidate]
            : []
        }),
      ),
    )
  }
}

/** Independent check of every supplied trace's wire capsules and via lands.
 * Adjacent wire/via connectors are checked as copper, including their XY span. */
export function boardBoundaryReports(input: SimpleRouteJson, traces: Trace[]) {
  const boundary = new BoardBoundary(input)
  const issues: Array<{
    traceId: string
    connectionName: string | undefined
    routeIndex: number
    kind: "wire" | "via" | "segment"
  }> = []
  for (const trace of traces) {
    for (let i = 0; i < trace.route.length; i++) {
      const point = trace.route[i]
      const radius =
        point.route_type === "wire"
          ? point.width / 2
          : (point.via_diameter ?? input.minViaPadDiameter ?? 0.3) / 2
      const issue = (kind: "wire" | "via" | "segment") =>
        issues.push({
          traceId: trace.pcb_trace_id,
          connectionName: trace.connection_name,
          routeIndex: i,
          kind,
        })
      if (radius <= 0 || !boundary.containsSegment(point, point, radius))
        issue(point.route_type)
      if (!i) continue
      const previous = trace.route[i - 1]
      const segmentRadius =
        previous.route_type === "wire"
          ? point.route_type === "wire"
            ? Math.max(previous.width, point.width) / 2
            : previous.width / 2
          : radius
      if (!boundary.containsSegment(previous, point, segmentRadius))
        issue("segment")
    }
  }
  return { valid: issues.length === 0, issues }
}
