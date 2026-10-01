import { CopperIndex } from "./copper-index"
import {
  distance,
  segmentDistance,
  pointSegmentDistance,
  pointSegmentDistanceToPoints,
} from "./geometry"
import type { Point, SimpleRouteJson, Connection, Trace } from "./types"
export interface Copper {
  a: Point
  b: Point
  radius: number
  layer: string
  owners: string[]
  rect?: { minX: number; maxX: number; minY: number; maxY: number }
}
export function fixedCopper(input: SimpleRouteJson): Copper[] {
  const result: Copper[] = []
  for (const o of input.obstacles) {
    // A rotated rectangle uses a conservative axis-aligned envelope. Circular
    // pads retain their exact radius, independent of rotation.
    const angle = ((o.ccwRotationDegrees ?? 0) * Math.PI) / 180
    const width =
      Math.abs(Math.cos(angle)) * o.width + Math.abs(Math.sin(angle)) * o.height
    const height =
      Math.abs(Math.sin(angle)) * o.width + Math.abs(Math.cos(angle)) * o.height
    for (const layer of o.layers)
      result.push({
        a: o.center,
        b: o.center,
        radius: o.shape === "circle" ? o.width / 2 : 0,
        layer,
        owners: o.connectedTo,
        rect:
          o.shape === "circle"
            ? undefined
            : {
                minX: o.center.x - width / 2,
                maxX: o.center.x + width / 2,
                minY: o.center.y - height / 2,
                maxY: o.center.y + height / 2,
              },
      })
  }
  const layers = Array.from({ length: input.layerCount }, (_, i) =>
    i === 0 ? "top" : i === input.layerCount - 1 ? "bottom" : `inner${i}`,
  )
  for (const t of input.traces ?? [])
    for (let i = 0; i < t.route.length; i++) {
      const p = t.route[i],
        q = t.route[i + 1],
        owners = [t.connection_name ?? "", t.source_trace_id ?? ""]
      if (p.route_type === "via") {
        const a = layers.indexOf(p.from_layer),
          b = layers.indexOf(p.to_layer)
        for (const layer of p.layers ??
          layers.slice(Math.min(a, b), Math.max(a, b) + 1))
          result.push({
            a: p,
            b: p,
            radius: (p.via_diameter ?? 0.3) / 2,
            layer,
            owners,
          })
      } else if (q?.route_type === "wire") {
        if (p.layer !== q.layer)
          throw Error("Fixed trace changes layer without a via")
        result.push({ a: p, b: q, radius: p.width / 2, layer: p.layer, owners })
      }
      if (q && p.route_type !== q.route_type && distance(p, q) > 1e-10) {
        const wire = p.route_type === "wire" ? p : (q as import("./types").Wire)
        result.push({
          a: p,
          b: q,
          radius: wire.width / 2,
          layer: wire.layer,
          owners,
        })
      }
    }
  return result
}
export function routeCopper(t: Trace): Copper[] {
  return t.route.slice(1).map((p, i) => ({
    a: t.route[i],
    b: p,
    radius: (p as any).width / 2,
    layer: (p as any).layer,
    owners: [t.connection_name ?? ""],
  }))
}
const intersectsRect = (a: Point, b: Point, r: NonNullable<Copper["rect"]>) => {
  let t0 = 0,
    t1 = 1
  for (const [origin, delta, min, max] of [
    [a.x, b.x - a.x, r.minX, r.maxX],
    [a.y, b.y - a.y, r.minY, r.maxY],
  ]) {
    if (Math.abs(delta) < 1e-12) {
      if (origin < min || origin > max) return false
      continue
    }
    let lo = (min - origin) / delta,
      hi = (max - origin) / delta
    if (lo > hi) [lo, hi] = [hi, lo]
    t0 = Math.max(t0, lo)
    t1 = Math.min(t1, hi)
    if (t0 > t1) return false
  }
  return true
}
export function clearanceToCopper(a: Point, b: Point, c: Copper) {
  if (!c.rect) {
    // Raster occupancy asks about points, and circular pads/vias have a
    // zero-length centerline. Avoid four equivalent segment projections.
    if (a.x === b.x && a.y === b.y) {
      if (c.a.x === c.b.x && c.a.y === c.b.y) return distance(a, c.a) - c.radius
      return pointSegmentDistance(a, [c.a, c.b]) - c.radius
    }
    if (c.a.x === c.b.x && c.a.y === c.b.y)
      return pointSegmentDistance(c.a, [a, b]) - c.radius
    return segmentDistance([a, b], [c.a, c.b]) - c.radius
  }
  const r = c.rect
  if (intersectsRect(a, b, r)) return 0
  const corners = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ]
  return Math.min(
    ...corners.map((p, i) =>
      segmentDistance([a, b], [p, corners[(i + 1) % 4]]),
    ),
  )
}
/** Predicate equivalent to clearanceToCopper(a, b, c) < margin. Stop after
 * the first colliding projection; retain the same sqrt/subtraction arithmetic. */
export function copperTooClose(a: Point, b: Point, c: Copper, margin: number) {
  if (c.rect) return clearanceToCopper(a, b, c) < margin
  const u = c.a,
    v = c.b,
    radius = c.radius
  if (u.x === v.x && u.y === v.y)
    return pointSegmentDistanceToPoints(u, a, b) - radius < margin
  if (a.x === b.x && a.y === b.y)
    return pointSegmentDistanceToPoints(a, u, v) - radius < margin
  if (
    Math.max(a.x, b.x) >= Math.min(u.x, v.x) &&
    Math.max(u.x, v.x) >= Math.min(a.x, b.x) &&
    Math.max(a.y, b.y) >= Math.min(u.y, v.y) &&
    Math.max(u.y, v.y) >= Math.min(a.y, b.y) &&
    ((b.x - a.x) * (u.y - a.y) - (b.y - a.y) * (u.x - a.x)) *
      ((b.x - a.x) * (v.y - a.y) - (b.y - a.y) * (v.x - a.x)) <=
      0 &&
    ((v.x - u.x) * (a.y - u.y) - (v.y - u.y) * (a.x - u.x)) *
      ((v.x - u.x) * (b.y - u.y) - (v.y - u.y) * (b.x - u.x)) <=
      0
  )
    return -radius < margin
  return (
    pointSegmentDistanceToPoints(a, u, v) - radius < margin ||
    pointSegmentDistanceToPoints(b, u, v) - radius < margin ||
    pointSegmentDistanceToPoints(u, a, b) - radius < margin ||
    pointSegmentDistanceToPoints(v, a, b) - radius < margin
  )
}
/** Geometry shared by the many tiny grid edges tested against one copper
 * item. Preparation only caches immutable differences, without rounding. */
export interface PreparedCopper {
  copper: Copper
  ax: number
  ay: number
  bx: number
  by: number
  dx: number
  dy: number
  denominator: number
}
export function prepareCopper(copper: Copper): PreparedCopper {
  const dx = copper.b.x - copper.a.x,
    dy = copper.b.y - copper.a.y
  return {
    copper,
    ax: copper.a.x,
    ay: copper.a.y,
    bx: copper.b.x,
    by: copper.b.y,
    dx,
    dy,
    denominator: dx * dx + dy * dy,
  }
}
function pointPreparedSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  denominator: number,
) {
  const ex = px - ax,
    ey = py - ay
  if (dx === 0 && dy === 0) return Math.sqrt(ex * ex + ey * ey)
  const t = Math.max(0, Math.min(1, (ex * dx + ey * dy) / (denominator || 1)))
  const rx = ex - t * dx,
    ry = ey - t * dy
  return Math.sqrt(rx * rx + ry * ry)
}
/** Scalar version of copperTooClose for grid edges. It retains the exact
 * projection, sqrt and radius-subtraction arithmetic of the public predicate. */
export function copperTooClosePrepared(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  dx: number,
  dy: number,
  denominator: number,
  c: PreparedCopper,
  margin: number,
): boolean {
  const radius = c.copper.radius
  if (c.copper.rect)
    return copperTooClose({ x: ax, y: ay }, { x: bx, y: by }, c.copper, margin)
  if (c.dx === 0 && c.dy === 0)
    return (
      pointPreparedSegmentDistance(c.ax, c.ay, ax, ay, dx, dy, denominator) -
        radius <
      margin
    )
  if (dx === 0 && dy === 0)
    return (
      pointPreparedSegmentDistance(
        ax,
        ay,
        c.ax,
        c.ay,
        c.dx,
        c.dy,
        c.denominator,
      ) -
        radius <
      margin
    )
  if (
    Math.max(ax, bx) >= Math.min(c.ax, c.bx) &&
    Math.max(c.ax, c.bx) >= Math.min(ax, bx) &&
    Math.max(ay, by) >= Math.min(c.ay, c.by) &&
    Math.max(c.ay, c.by) >= Math.min(ay, by) &&
    (dx * (c.ay - ay) - dy * (c.ax - ax)) *
      (dx * (c.by - ay) - dy * (c.bx - ax)) <=
      0 &&
    (c.dx * (ay - c.ay) - c.dy * (ax - c.ax)) *
      (c.dx * (by - c.ay) - c.dy * (bx - c.ax)) <=
      0
  )
    return -radius < margin
  return (
    pointPreparedSegmentDistance(
      ax,
      ay,
      c.ax,
      c.ay,
      c.dx,
      c.dy,
      c.denominator,
    ) -
      radius <
      margin ||
    pointPreparedSegmentDistance(
      bx,
      by,
      c.ax,
      c.ay,
      c.dx,
      c.dy,
      c.denominator,
    ) -
      radius <
      margin ||
    pointPreparedSegmentDistance(c.ax, c.ay, ax, ay, dx, dy, denominator) -
      radius <
      margin ||
    pointPreparedSegmentDistance(c.bx, c.by, ax, ay, dx, dy, denominator) -
      radius <
      margin
  )
}
/** Continuous board-world geometry in mm. Bounds checks and segment/capsule
 * predicates are exact; no coordinate quantization or raster cells are used. */
export class VectorScene {
  private visibleCalls = 0
  private copperIndex?: CopperIndex
  readonly copper: Copper[]
  readonly owners: Set<string>
  readonly margin: number
  constructor(
    readonly input: SimpleRouteJson,
    readonly connection: Connection,
    readonly width: number,
    all: Copper[],
  ) {
    this.owners = new Set(
      [
        connection.name,
        connection.source_trace_id,
        ...connection.pointsToConnect.flatMap((p) => [
          p.pointId,
          p.pcb_port_id,
        ]),
      ].filter((s): s is string => !!s),
    )
    this.copper = all.filter(
      (c) =>
        c.layer === connection.pointsToConnect[0].layer &&
        !c.owners.some((n) => this.owners.has(n)),
    )
    this.margin =
      width / 2 +
      (input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075)
  }
  visible(a: Point, b: Point) {
    const m = this.width / 2 + (this.input.minBoardEdgeClearance ?? 0),
      r = this.input.bounds
    if (
      [a, b].some(
        (p) =>
          p.x < r.minX + m - 1e-9 ||
          p.x > r.maxX - m + 1e-9 ||
          p.y < r.minY + m - 1e-9 ||
          p.y > r.maxY - m + 1e-9,
      )
    )
      return false
    const minX = Math.min(a.x, b.x) - this.margin,
      maxX = Math.max(a.x, b.x) + this.margin,
      minY = Math.min(a.y, b.y) - this.margin,
      maxY = Math.max(a.y, b.y) + this.margin
    if (++this.visibleCalls === 16)
      this.copperIndex = new CopperIndex(this.copper)
    if (this.copperIndex)
      return !this.copperIndex.some({ minX, maxX, minY, maxY }, (c) =>
        copperTooClose(a, b, c, this.margin - 1e-8),
      )
    for (const c of this.copper) {
      const r = c.rect ?? {
        minX: Math.min(c.a.x, c.b.x) - c.radius,
        maxX: Math.max(c.a.x, c.b.x) + c.radius,
        minY: Math.min(c.a.y, c.b.y) - c.radius,
        maxY: Math.max(c.a.y, c.b.y) + c.radius,
      }
      if (r.minX > maxX || r.maxX < minX || r.minY > maxY || r.maxY < minY)
        continue
      if (copperTooClose(a, b, c, this.margin - 1e-8)) return false
    }
    return true
  }
  pathVisible(path: Point[]) {
    return path.slice(1).every((b, i) => this.visible(path[i], b))
  }
  /** Vertices of circumscribed octagonal Minkowski offsets. Their edges are
   * horizontal, vertical or 45 degrees, including circular vias and trace caps. */
  vertices(): Point[] {
    const result: Point[] = [],
      k = Math.SQRT2 - 1,
      epsilon = 1e-5
    for (const c of this.copper) {
      if (c.rect) {
        const r = c.rect,
          m = this.margin + epsilon
        result.push(
          { x: r.minX - m, y: r.minY - m },
          { x: r.minX - m, y: r.maxY + m },
          { x: r.maxX + m, y: r.minY - m },
          { x: r.maxX + m, y: r.maxY + m },
        )
      } else {
        const r = c.radius + this.margin + epsilon
        for (const p of distance(c.a, c.b) < 1e-9 ? [c.a] : [c.a, c.b])
          for (const [x, y] of [
            [1, k],
            [k, 1],
            [-k, 1],
            [-1, k],
            [-1, -k],
            [-k, -1],
            [k, -1],
            [1, -k],
          ])
            result.push({ x: p.x + x * r, y: p.y + y * r })
      }
    }
    const seen = new Set<string>()
    return result.filter((p) => {
      const key = `${p.x.toFixed(9)},${p.y.toFixed(9)}`
      if (seen.has(key)) return false
      seen.add(key)
      return this.visible(p, p)
    })
  }
}
