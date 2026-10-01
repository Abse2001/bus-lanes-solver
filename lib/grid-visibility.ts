import type { Point, SimpleRouteJson } from "./types"
import { MinHeap } from "./min-heap"
import { distance, length, simplify, segmentDistance } from "./geometry"
import {
  VectorScene,
  clearanceToCopper,
  fixedCopper,
  type Copper,
} from "./vector-scene"
import { connectors } from "./vector-visibility"

// The reference searches a compact rectangle around the packages. Derive that
// rectangle from this layer's copper and terminals, leaving one lane pitch per
// connection outside the occupied envelope. No board coordinates are assumed.
function routingBounds(scene: VectorScene, step: number) {
  const input = scene.input,
    board = input.bounds
  const layer = scene.connection.pointsToConnect[0].layer
  const copper = fixedCopper(input).filter((c) => c.layer === layer)
  const points = input.connections.flatMap((c) => c.pointsToConnect)
  for (const c of copper) {
    if (c.rect)
      points.push(
        { x: c.rect.minX, y: c.rect.minY, layer },
        { x: c.rect.maxX, y: c.rect.maxY, layer },
      )
    else
      points.push(
        {
          x: Math.min(c.a.x, c.b.x) - c.radius,
          y: Math.min(c.a.y, c.b.y) - c.radius,
          layer,
        },
        {
          x: Math.max(c.a.x, c.b.x) + c.radius,
          y: Math.max(c.a.y, c.b.y) + c.radius,
          layer,
        },
      )
  }
  const minX = Math.min(...points.map((p) => p.x)),
    maxX = Math.max(...points.map((p) => p.x))
  const minY = Math.min(...points.map((p) => p.y)),
    maxY = Math.max(...points.map((p) => p.y))
  const pitch =
    input.minTraceWidth +
    (input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075)
  const margin = Math.max(
    2,
    input.connections.length * pitch,
    Math.min(maxX - minX, maxY - minY) / 2,
  )
  const lo = (n: number, origin: number) =>
    origin + Math.floor((n - origin) / step) * step
  const hi = (n: number, origin: number) =>
    origin + Math.ceil((n - origin) / step) * step
  return {
    minX: Math.max(board.minX, lo(minX - margin, board.minX)),
    maxX: Math.min(board.maxX, hi(maxX + margin, board.minX)),
    minY: Math.max(board.minY, lo(minY - margin, board.minY)),
    maxY: Math.min(board.maxY, hi(maxY + margin, board.minY)),
  }
}

/** Single-layer A* adapted from the reference board's routing/single-layer.ts:
 * https://tscircuit.com/seveibar/am3352-ram-dogbone-and-single-layer-route-test
 * Uses its octile heuristic and additive occupancy/history costs. Continuous
 * edge clearance and exact endpoint connectors extend the original raster search.
 * Bounded octilinear grid in board-world mm (+X right, +Y up).
 * Conservative occupied cells accelerate dense pad fields. Every accepted edge
 * and endpoint connector is checked against continuous copper geometry. */
export class GridVisibilitySearch {
  expanded = 0
  failed = false
  solved = false
  result: Point[] = []
  private heap = new MinHeap<{ id: number; g: number; f: number }>()
  private travel?: Float64Array
  private maxLength = Infinity
  private best: Float64Array
  private parent: Int32Array
  private blocked: Uint8Array
  private nx: number
  private ny: number
  private stepSize: number
  private softMargin: number
  private softBuckets = new Map<string, Copper[]>()
  private softEdgeKnown: Uint8Array
  private softEdgeBlocked: Uint8Array
  private copperBuckets = new Map<string, Copper[]>()
  private goal = -1
  private startPath: Point[] = []
  private endPath: Point[] = []
  private origin: Point
  constructor(
    readonly scene: VectorScene,
    readonly start: Point,
    readonly end: Point,
    softCopper: Copper[] = [],
    private penalty = 4,
    private history?: Float32Array,
    grid?: {
      step?: number
      maxLength?: number
      bounds?: SimpleRouteJson["bounds"]
    },
  ) {
    // The reference's successful dense-package search uses a half-trace-width
    // grid; pair approaches use the separately bounded finer grid above.
    const packageGrid = scene.input.obstacles.some((o) => o.componentId)
    this.stepSize = Math.max(
      0.01,
      grid?.step ?? scene.input.minTraceWidth / (packageGrid ? 2 : 1),
    )
    // Legal parallel tracks must not cost more than crossing them. Inflating
    // soft clearance closes nominal multi-track channels between BGA vias.
    this.softMargin = scene.margin
    const b =
      grid?.bounds ??
      (packageGrid ? routingBounds(scene, this.stepSize) : scene.input.bounds)
    this.origin = { x: b.minX, y: b.minY }
    this.nx = Math.ceil((b.maxX - b.minX) / this.stepSize) + 1
    this.ny = Math.ceil((b.maxY - b.minY) / this.stepSize) + 1
    const n = this.nx * this.ny
    if (n > 8_000_000) throw Error("Dense grid search budget exceeded")
    this.softEdgeKnown = new Uint8Array(n)
    this.softEdgeBlocked = new Uint8Array(n)
    this.blocked = new Uint8Array(n)
    this.maxLength = grid?.maxLength ?? Infinity
    if (Number.isFinite(this.maxLength)) this.travel = new Float64Array(n)
    this.best = new Float64Array(n)
    this.best.fill(Infinity)
    this.parent = new Int32Array(n)
    this.parent.fill(-1)
    const markBox = (
      minX: number,
      maxX: number,
      minY: number,
      maxY: number,
      predicate: (p: Point) => boolean,
    ) => {
      for (
        let y = Math.max(0, Math.floor((minY - b.minY) / this.stepSize));
        y <= Math.min(this.ny - 1, Math.ceil((maxY - b.minY) / this.stepSize));
        y++
      )
        for (
          let x = Math.max(0, Math.floor((minX - b.minX) / this.stepSize));
          x <=
          Math.min(this.nx - 1, Math.ceil((maxX - b.minX) / this.stepSize));
          x++
        ) {
          const id = x + y * this.nx
          if (!this.blocked[id] && predicate(this.point(id)))
            this.blocked[id] = 1
        }
    }
    for (const copper of scene.copper) {
      const r = scene.margin + copper.radius
      const box = copper.rect ?? {
        minX: Math.min(copper.a.x, copper.b.x),
        maxX: Math.max(copper.a.x, copper.b.x),
        minY: Math.min(copper.a.y, copper.b.y),
        maxY: Math.max(copper.a.y, copper.b.y),
      }
      for (let x = Math.floor(box.minX - r); x <= Math.floor(box.maxX + r); x++)
        for (
          let y = Math.floor(box.minY - r);
          y <= Math.floor(box.maxY + r);
          y++
        ) {
          const key = `${x},${y}`,
            items = this.copperBuckets.get(key) ?? []
          items.push(copper)
          this.copperBuckets.set(key, items)
        }
      if (copper.rect) {
        const q = copper.rect
        markBox(
          q.minX - r,
          q.maxX + r,
          q.minY - r,
          q.maxY + r,
          (p) => clearanceToCopper(p, p, copper) < scene.margin - 1e-8,
        )
        continue
      }
      const span = distance(copper.a, copper.b),
        steps = Math.max(1, Math.ceil(span / this.stepSize))
      for (let i = 0; i <= steps; i++) {
        const p = {
          x: copper.a.x + ((copper.b.x - copper.a.x) * i) / steps,
          y: copper.a.y + ((copper.b.y - copper.a.y) * i) / steps,
        }
        markBox(
          p.x - r,
          p.x + r,
          p.y - r,
          p.y + r,
          (q) => clearanceToCopper(q, q, copper) < scene.margin - 1e-8,
        )
      }
    }
    for (const copper of softCopper.filter(
      (c) => c.layer === scene.connection.pointsToConnect[0].layer,
    )) {
      const radius = this.softMargin + copper.radius
      for (
        let x = Math.floor(Math.min(copper.a.x, copper.b.x) - radius);
        x <= Math.floor(Math.max(copper.a.x, copper.b.x) + radius);
        x++
      )
        for (
          let y = Math.floor(Math.min(copper.a.y, copper.b.y) - radius);
          y <= Math.floor(Math.max(copper.a.y, copper.b.y) + radius);
          y++
        ) {
          const key = `${x},${y}`,
            items = this.softBuckets.get(key) ?? []
          items.push(copper)
          this.softBuckets.set(key, items)
        }
    }
    const attach = (p: Point) => {
      const x = Math.round((p.x - b.minX) / this.stepSize),
        y = Math.round((p.y - b.minY) / this.stepSize)
      const candidates: Array<{ id: number; path: Point[] }> = []
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          if (
            x + dx < 0 ||
            x + dx >= this.nx ||
            y + dy < 0 ||
            y + dy >= this.ny
          )
            continue
          const id = x + dx + (y + dy) * this.nx
          if (this.blocked[id]) continue
          for (const path of connectors(p, this.point(id)))
            if (scene.pathVisible(path)) {
              candidates.push({ id, path })
              break
            }
        }
      return candidates.sort((a, b) => length(a.path) - length(b.path))[0]
    }
    const a = attach(start),
      z = attach(end)
    if (!a || !z) {
      this.failed = true
      return
    }
    this.startPath = a.path
    this.endPath = z.path.toReversed()
    this.goal = z.id
    this.best[a.id] = 0
    if (this.travel) this.travel[a.id] = length(a.path)
    this.heap.push({ id: a.id, g: 0, f: this.heuristic(start) })
  }
  get cellCount() {
    return this.nx * this.ny
  }
  penalizeIntersection(
    history: Float32Array,
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    radius: number,
    wholeSegments = false,
  ) {
    // Reference negotiated-route.ts accumulates history along both colliding
    // segments. Charging only the crossing point lets it slide along the same
    // corridor indefinitely without changing the routes' topology.
    const touched = new Set<number>()
    for (const [start, end] of [
      [a, b],
      [c, d],
    ]) {
      const samples = Math.max(
        1,
        Math.ceil(distance(start, end) / this.stepSize),
      )
      for (let i = 0; i <= samples; i++) {
        const p = {
          x: start.x + ((end.x - start.x) * i) / samples,
          y: start.y + ((end.y - start.y) * i) / samples,
        }
        const cx = Math.round((p.x - this.origin.x) / this.stepSize),
          cy = Math.round((p.y - this.origin.y) / this.stepSize),
          n = Math.ceil(radius / this.stepSize)
        for (let dy = -n; dy <= n; dy++)
          for (let dx = -n; dx <= n; dx++) {
            if (
              cx + dx < 0 ||
              cx + dx >= this.nx ||
              cy + dy < 0 ||
              cy + dy >= this.ny
            )
              continue
            const id = cx + dx + (cy + dy) * this.nx
            const point = this.point(id)
            if (segmentDistance([point, point], [start, end]) > radius) continue
            if (
              !wholeSegments &&
              (segmentDistance([point, point], [a, b]) > radius ||
                segmentDistance([point, point], [c, d]) > radius)
            )
              continue
            touched.add(id)
          }
      }
    }
    for (const id of touched) history[id] += wholeSegments ? 0.3 : 1
  }
  private point(id: number): Point {
    return {
      x: this.origin.x + (id % this.nx) * this.stepSize,
      y: this.origin.y + Math.floor(id / this.nx) * this.stepSize,
    }
  }
  private edgeClear(
    from: Point,
    to: Point,
    buckets: Map<string, Copper[]>,
    margin = this.scene.margin,
  ): boolean {
    for (
      let x = Math.floor(Math.min(from.x, to.x));
      x <= Math.floor(Math.max(from.x, to.x));
      x++
    )
      for (
        let y = Math.floor(Math.min(from.y, to.y));
        y <= Math.floor(Math.max(from.y, to.y));
        y++
      )
        for (const copper of buckets.get(`${x},${y}`) ?? [])
          if (clearanceToCopper(from, to, copper) < margin - 1e-8) return false
    return true
  }
  private heuristic(point: Point) {
    const dx = Math.abs(point.x - this.end.x) / this.stepSize
    const dy = Math.abs(point.y - this.end.y) / this.stepSize
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
  }
  step() {
    for (let batch = 0; batch < 500 && !this.failed && !this.solved; batch++) {
      if (!this.heap.length) {
        this.failed = true
        return
      }
      const cur = this.heap.pop()
      if (cur.g !== this.best[cur.id]) continue
      this.expanded++
      if (cur.id === this.goal) {
        const path: Point[] = []
        for (let id = cur.id; id >= 0; id = this.parent[id])
          path.push(this.point(id))
        this.result = simplify([
          ...this.startPath,
          ...path.reverse().slice(1),
          ...this.endPath.slice(1),
        ])
        if (
          length(this.result) > this.maxLength + 1e-8 ||
          !this.scene.pathVisible(this.result)
        ) {
          this.failed = true
          return
        }
        this.solved = true
        return
      }
      const x = cur.id % this.nx,
        y = Math.floor(cur.id / this.nx)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (
            !(dx || dy) ||
            x + dx < 0 ||
            x + dx >= this.nx ||
            y + dy < 0 ||
            y + dy >= this.ny
          )
            continue
          const id = cur.id + dx + dy * this.nx
          if (
            this.blocked[id] ||
            (dx &&
              dy &&
              (this.blocked[cur.id + dx] ||
                this.blocked[cur.id + dy * this.nx]))
          )
            continue
          // With nonnegative occupancy cost, this is a lower bound on g.
          // An edge that cannot improve the route needs no geometry checks.
          // Keep the addition order used by g below to preserve tie decisions.
          const minimumG =
            cur.g + (dx && dy ? Math.SQRT2 : 1) + 0 + (this.history?.[id] ?? 0)
          if (this.penalty >= 0 && minimumG >= this.best[id] - 1e-10) continue
          const point = this.point(id),
            bounds = this.scene.input.bounds,
            edge =
              this.scene.width / 2 +
              (this.scene.input.minBoardEdgeClearance ?? 0)
          if (
            point.x < bounds.minX + edge ||
            point.x > bounds.maxX - edge ||
            point.y < bounds.minY + edge ||
            point.y > bounds.maxY - edge
          )
            continue
          const from = this.point(cur.id)
          // Penalize continuous edges, not just occupied vertices: diagonal
          // crossings can occur between clear cells. Use physical clearance
          // so tightly packed but legal parallel lanes remain available.
          const direction = (dy + 1) * 3 + dx + 1
          const bit = 1 << (direction > 4 ? direction - 1 : direction)
          if (!(this.softEdgeKnown[cur.id] & bit)) {
            this.softEdgeKnown[cur.id] |= bit
            if (!this.edgeClear(from, point, this.softBuckets, this.softMargin))
              this.softEdgeBlocked[cur.id] |= bit
          }
          const softCost = this.softEdgeBlocked[cur.id] & bit ? this.penalty : 0
          const travelled =
            (this.travel?.[cur.id] ?? 0) +
            (dx && dy ? Math.SQRT2 : 1) * this.stepSize
          if (
            this.travel &&
            travelled + this.heuristic(point) * this.stepSize >
              this.maxLength + 1e-8
          )
            continue
          const g =
            cur.g +
            (dx && dy ? Math.SQRT2 : 1) +
            softCost +
            (this.history?.[id] ?? 0)
          if (g >= this.best[id] - 1e-10) continue
          if (!this.edgeClear(from, point, this.copperBuckets)) continue
          this.best[id] = g
          if (this.travel) this.travel[id] = travelled
          this.parent[id] = cur.id
          this.heap.push({
            id,
            g,
            f: g + this.heuristic(point),
          })
        }
    }
  }
}
