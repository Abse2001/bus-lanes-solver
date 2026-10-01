import { CopperIndex } from "./copper-index"
import { distance, segmentDistance, pointSegmentDistance } from "./geometry"
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
      return !this.copperIndex.some(
        { minX, maxX, minY, maxY },
        (c) => clearanceToCopper(a, b, c) < this.margin - 1e-8,
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
      if (clearanceToCopper(a, b, c) < this.margin - 1e-8) return false
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
