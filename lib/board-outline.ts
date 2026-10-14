import {
  distance,
  pointSegmentDistanceToPoints,
  segmentDistance,
} from "./geometry"
import type { Point, SimpleRouteJson, Trace } from "./types"

const epsilon = 1e-9
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/** A single simple board perimeter, implicitly closed. Internal normalization
 * never changes the supplied outline or its serialized output. */
export class BoardOutline {
  readonly points: readonly Point[]
  private readonly edges: Array<[Point, Point]>

  constructor(outline: readonly Point[]) {
    if (!Array.isArray(outline)) throw Error("Board outline must be a polygon")
    const points = outline.map((p) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
        throw Error("Board outline has a nonfinite vertex")
      return { x: p.x, y: p.y }
    })
    if (
      points.length > 1 &&
      points[0].x === points.at(-1)!.x &&
      points[0].y === points.at(-1)!.y
    )
      points.pop()
    if (points.length < 3) throw Error("Board outline needs three vertices")
    this.points = points
    this.edges = points.map((p, i) => [p, points[(i + 1) % points.length]])
    let area = 0
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length]
      if (distance(a, b) < 1e-12)
        throw Error("Board outline has a zero-length edge")
      area += cross(points[0], a, b)
      const c = points[(i + 2) % points.length]
      if (
        Math.abs(cross(a, b, c)) < 1e-12 &&
        (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) > 0
      )
        throw Error("Board outline has overlapping adjacent edges")
      for (let j = i + 1; j < points.length; j++) {
        if (j === i + 1 || (i === 0 && j === points.length - 1)) continue
        if (segmentDistance(this.edges[i], this.edges[j]) < 1e-12)
          throw Error("Board outline is self-intersecting")
      }
    }
    if (!Number.isFinite(area) || Math.abs(area) < 1e-12)
      throw Error("Board outline is degenerate")
  }

  containsPoint(p: Point) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false
    let inside = false
    for (const [a, b] of this.edges) {
      if (pointSegmentDistanceToPoints(p, a, b) <= epsilon) return true
      if (
        a.y > p.y !== b.y > p.y &&
        p.x < a.x + ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y)
      )
        inside = !inside
    }
    return inside
  }

  pointIsClear(p: Point, clearance: number) {
    if (!Number.isFinite(clearance) || clearance < 0 || !this.containsPoint(p))
      return false
    return this.edges.every(
      ([a, b]) => pointSegmentDistanceToPoints(p, a, b) + epsilon >= clearance,
    )
  }

  /** Allocation-free grid query. Compute each edge distance once while retaining
   * the public containment and clearance predicates' exact arithmetic. */
  pointIsClearXY(x: number, y: number, clearance: number) {
    if (this.containsPoint !== originalContainsPoint || this.pointIsClear !== originalPointIsClear)
      return this.pointIsClear({ x, y }, clearance)
    if (!Number.isFinite(clearance) || clearance < 0 || !Number.isFinite(x) || !Number.isFinite(y))
      return false
    let inside = false, boundary = false
    for (let index = 0; index < this.edges.length; index++) {
      const edge = this.edges[index], a = edge[0], b = edge[1]
      const dx = b.x - a.x, dy = b.y - a.y, ex = x - a.x, ey = y - a.y
      let d: number
      if (dx === 0 && dy === 0) d = Math.sqrt(ex * ex + ey * ey)
      else {
        const t = Math.max(0, Math.min(1, (ex * dx + ey * dy) / (dx * dx + dy * dy || 1)))
        const rx = ex - t * dx, ry = ey - t * dy
        d = Math.sqrt(rx * rx + ry * ry)
      }
      // The original every() rejects NaN as well as insufficient clearance.
      if (!(d + epsilon >= clearance)) return false
      if (d <= epsilon) boundary = true
      else if (!boundary && a.y > y !== b.y > y &&
        x < a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y)) inside = !inside
    }
    return boundary || inside
  }

  /** Continuous capsule clearance checks every perimeter edge, including
   * concave cutouts between endpoints that both lie inside the board. */
  capsuleIsClear(a: Point, b: Point, clearance: number) {
    if (
      !Number.isFinite(clearance) ||
      clearance < 0 ||
      !this.containsPoint(a) ||
      !this.containsPoint(b)
    )
      return false
    if (a.x === b.x && a.y === b.y) return this.pointIsClear(a, clearance)
    for (const edge of this.edges) {
      const d = segmentDistance([a, b], edge)
      if (d + epsilon < clearance || (clearance === 0 && d <= epsilon))
        return false
    }
    return true
  }

  /** Safe visibility candidates around perimeter corners. The continuous
   * predicate filters exterior candidates and checks all connecting edges. */
  verticesForClearance(clearance: number): Point[] {
    const margin = clearance + 1e-5,
      k = Math.SQRT2 - 1
    return this.points
      .flatMap((p) =>
        [
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
          [1, k],
          [k, 1],
          [-k, 1],
          [-1, k],
          [-1, -k],
          [-k, -1],
          [k, -1],
          [1, -k],
        ].map(([x, y]) => ({ x: p.x + x * margin, y: p.y + y * margin })),
      )
      .filter((p) => this.pointIsClear(p, clearance))
  }
}

// Preserve custom/subclass predicates on the scalar entry point as well.
const originalContainsPoint = BoardOutline.prototype.containsPoint
const originalPointIsClear = BoardOutline.prototype.pointIsClear

const outlines = new WeakMap<Point[], { key: string; polygon: BoardOutline }>()
export function getBoardOutline(
  input: SimpleRouteJson,
): BoardOutline | undefined {
  if (input.outline === undefined) return undefined
  // An empty optional outline has historically selected rectangular bounds.
  if (Array.isArray(input.outline) && input.outline.length === 0)
    return undefined
  // Content keys avoid stale geometry if an external caller edits an outline
  // between searches. The solver's own cloned input remains immutable.
  const key = JSON.stringify(input.outline)
  const cached = outlines.get(input.outline)
  if (cached?.key === key) return cached.polygon
  const polygon = new BoardOutline(input.outline)
  outlines.set(input.outline, { key, polygon })
  return polygon
}

export interface BoardOutlineViolation {
  pcbTraceId: string
  routeIndex: number
  kind: "wire" | "via"
}

/** Validate actual wire widths and via land diameters, including supplied
 * immutable fanout copper. A wire/via transition may have a nonzero chord. */
export function boardOutlineViolations(
  input: SimpleRouteJson,
  traces: readonly Trace[],
) {
  const outline = getBoardOutline(input)
  if (!outline) return []
  const edge = input.minBoardEdgeClearance ?? 0
  const violations: BoardOutlineViolation[] = []
  for (const trace of traces) {
    for (let i = 0; i < trace.route.length; i++) {
      const p = trace.route[i],
        q = trace.route[i + 1]
      if (p.route_type === "via") {
        const diameter = p.via_diameter ?? input.minViaPadDiameter ?? 0.3
        if (
          !Number.isFinite(diameter) ||
          diameter <= 0 ||
          !outline.pointIsClear(p, diameter / 2 + edge)
        )
          violations.push({
            pcbTraceId: trace.pcb_trace_id,
            routeIndex: i,
            kind: "via",
          })
      } else if (
        !Number.isFinite(p.width) ||
        p.width <= 0 ||
        !outline.pointIsClear(p, p.width / 2 + edge)
      ) {
        violations.push({
          pcbTraceId: trace.pcb_trace_id,
          routeIndex: i,
          kind: "wire",
        })
      }
      if (!q || (p.route_type === "via" && q.route_type === "via")) continue
      const width =
        p.route_type === "wire"
          ? q.route_type === "wire"
            ? Math.max(p.width, q.width)
            : p.width
          : q.route_type === "wire"
            ? q.width
            : 0
      if (!outline.capsuleIsClear(p, q, width / 2 + edge))
        violations.push({
          pcbTraceId: trace.pcb_trace_id,
          routeIndex: i,
          kind: "wire",
        })
    }
  }
  return violations
}
