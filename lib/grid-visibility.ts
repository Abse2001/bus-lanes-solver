import type { Point, SimpleRouteJson } from "./types"
import { GridHeap } from "./grid-heap"
import { distance, length, simplify, segmentDistance } from "./geometry"
import {
  VectorScene,
  clearanceToCopper,
  copperTooClose,
  fixedCopper,
  type Copper,
} from "./vector-scene"
import { connectors } from "./vector-visibility"

class CopperBuckets {
  private buckets = new Map<number, CopperEntry[]>()
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  readonly width: number
  constructor(bounds: SimpleRouteJson["bounds"]) {
    this.minX = Math.floor(bounds.minX)
    this.minY = Math.floor(bounds.minY)
    this.maxX = Math.ceil(bounds.maxX) + 1
    this.maxY = Math.ceil(bounds.maxY) + 1
    this.width = this.maxX - this.minX + 1
  }
  add(x: number, y: number, entry: CopperEntry) {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return
    const key = x - this.minX + (y - this.minY) * this.width
    let bucket = this.buckets.get(key)
    if (!bucket) this.buckets.set(key, (bucket = []))
    if (bucket.at(-1) !== entry) bucket.push(entry)
  }
  addCopper(entry: CopperEntry, margin: number) {
    const c = entry.copper
    const box = (minX: number, maxX: number, minY: number, maxY: number) => {
      for (let x = Math.floor(minX); x <= Math.floor(maxX); x++)
        for (let y = Math.floor(minY); y <= Math.floor(maxY); y++)
          this.add(x, y, entry)
    }
    if (c.rect) {
      box(entry.minX, entry.maxX, entry.minY, entry.maxY)
      return
    }
    const dx = c.b.x - c.a.x,
      dy = c.b.y - c.a.y
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
    // Each segment point lies within half a sample interval on each axis.
    // Expand by that interval and the copper clearance to cover the entire
    // capsule, without filling a long diagonal's mostly empty bounding box.
    const rx = c.radius + margin + Math.abs(dx) / (2 * steps) + 1e-9
    const ry = c.radius + margin + Math.abs(dy) / (2 * steps) + 1e-9
    for (let i = 0; i <= steps; i++) {
      const x = c.a.x + (dx * i) / steps,
        y = c.a.y + (dy * i) / steps
      box(x - rx, x + rx, y - ry, y + ry)
    }
  }
  get(x: number, y: number) {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY)
      return undefined
    return this.buckets.get(x - this.minX + (y - this.minY) * this.width)
  }
  values() {
    return this.buckets.values()
  }
}

interface CopperEntry {
  copper: Copper
  minX: number
  maxX: number
  minY: number
  maxY: number
}

type Attachment = { id: number; path: Point[] }

interface HardGrid {
  attachments: Map<string, Attachment | undefined>
  blocked: Uint8Array
  edgeKnown: Uint8Array
  edgeBlocked: Uint8Array
  buckets: CopperBuckets
  bytes: number
}
// Request-local memoization, never saved route geometry. A content key prevents
// stale occupancy when negotiated copper changes; cap retained grids at 64 MiB.
const hardGrids = new WeakMap<SimpleRouteJson, Map<string, HardGrid>>()
const maxHardGridBytes = 64 * 1024 * 1024

// Bounds include the routing clearance. They only reject distant geometry;
// possible contacts still use the original continuous distance predicate.
function copperEntry(copper: Copper, margin: number): CopperEntry {
  const r = copper.rect ?? {
    minX: Math.min(copper.a.x, copper.b.x) - copper.radius,
    maxX: Math.max(copper.a.x, copper.b.x) + copper.radius,
    minY: Math.min(copper.a.y, copper.b.y) - copper.radius,
    maxY: Math.max(copper.a.y, copper.b.y) + copper.radius,
  }
  return {
    copper: {
      ...copper,
      a: { ...copper.a },
      b: { ...copper.b },
      rect: copper.rect ? { ...copper.rect } : undefined,
    },
    minX: r.minX - margin,
    maxX: r.maxX + margin,
    minY: r.minY - margin,
    maxY: r.maxY + margin,
  }
}

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
  private heap: GridHeap
  private neighbors: Array<{
    dx: number
    dy: number
    offset: number
    cost: number
    bit: number
    reverse: number
    diagonal: boolean
  }>
  private travel?: Float64Array
  private maxLength = Infinity
  private best: Float64Array
  private parent: Int32Array
  private blocked: Uint8Array
  private nx: number
  private ny: number
  private stepSize: number
  private softMargin: number
  private softBuckets: CopperBuckets
  private softEdgeKnown: Uint8Array
  private softEdgeBlocked: Uint8Array
  private hardEdgeKnown: Uint8Array
  private hardEdgeBlocked: Uint8Array
  private copperBuckets: CopperBuckets
  private goal = -1
  private startPath: Point[] = []
  private endPath: Point[] = []
  private origin: Point
  private xs: Float64Array
  private ys: Float64Array
  private hx: Float64Array
  private hy: Float64Array
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
    this.softBuckets = new CopperBuckets(b)
    this.copperBuckets = new CopperBuckets(b)
    this.nx = Math.ceil((b.maxX - b.minX) / this.stepSize) + 1
    this.ny = Math.ceil((b.maxY - b.minY) / this.stepSize) + 1
    this.neighbors = []
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!(dx || dy)) continue
        const direction = (dy + 1) * 3 + dx + 1
        const index = direction > 4 ? direction - 1 : direction
        this.neighbors.push({
          dx,
          dy,
          offset: dx + dy * this.nx,
          diagonal: !!(dx && dy),
          cost: dx && dy ? Math.SQRT2 : 1,
          bit: 1 << index,
          reverse: 1 << (7 - index),
        })
      }
    this.xs = Float64Array.from(
      { length: this.nx },
      (_, x) => this.origin.x + x * this.stepSize,
    )
    this.ys = Float64Array.from(
      { length: this.ny },
      (_, y) => this.origin.y + y * this.stepSize,
    )
    this.hx = this.xs.map((x) => Math.abs(x - this.end.x) / this.stepSize)
    this.hy = this.ys.map((y) => Math.abs(y - this.end.y) / this.stepSize)
    const n = this.nx * this.ny
    if (n > 8_000_000) throw Error("Dense grid search budget exceeded")
    this.heap = new GridHeap(n)
    this.softEdgeKnown = new Uint8Array(n)
    this.softEdgeBlocked = new Uint8Array(n)
    const grids = hardGrids.get(scene.input) ?? new Map<string, HardGrid>()
    hardGrids.set(scene.input, grids)
    const gridKey = JSON.stringify([
      b.minX,
      b.minY,
      b.maxX,
      b.maxY,
      this.nx,
      this.ny,
      this.stepSize,
      scene.margin,
      scene.width,
      scene.input.minBoardEdgeClearance,
      scene.input.bounds,
      scene.copper.map((c) => [c.a.x, c.a.y, c.b.x, c.b.y, c.radius, c.rect]),
    ])
    const cachedGrid = grids.get(gridKey)
    const attachments =
      cachedGrid?.attachments ?? new Map<string, Attachment | undefined>()
    if (cachedGrid) {
      grids.delete(gridKey)
      grids.set(gridKey, cachedGrid)
    }
    this.blocked = cachedGrid?.blocked ?? new Uint8Array(n)
    this.hardEdgeKnown = cachedGrid?.edgeKnown ?? new Uint8Array(n)
    this.hardEdgeBlocked = cachedGrid?.edgeBlocked ?? new Uint8Array(n)
    if (cachedGrid) this.copperBuckets = cachedGrid.buckets
    this.maxLength = grid?.maxLength ?? Infinity
    if (Number.isFinite(this.maxLength)) this.travel = new Float64Array(n)
    this.best = new Float64Array(n)
    this.best.fill(Infinity)
    this.parent = new Int32Array(n)
    this.parent.fill(-1)
    if (!cachedGrid) {
      // Adjacent samples of a long segment overlap. Test each cell at most
      // once per copper item, including clear cells in its bounding halo.
      const testedBy = new Uint32Array(n)
      let copperStamp = 0
      const markBox = (
        minX: number,
        maxX: number,
        minY: number,
        maxY: number,
        copper: Copper,
      ) => {
        const loX = Math.max(0, Math.floor((minX - b.minX) / this.stepSize))
        const hiX = Math.min(
          this.nx - 1,
          Math.ceil((maxX - b.minX) / this.stepSize),
        )
        const loY = Math.max(0, Math.floor((minY - b.minY) / this.stepSize))
        const hiY = Math.min(
          this.ny - 1,
          Math.ceil((maxY - b.minY) / this.stepSize),
        )
        const circle =
          !copper.rect && copper.a.x === copper.b.x && copper.a.y === copper.b.y
        const threshold = scene.margin - 1e-8
        for (let y = loY; y <= hiY; y++) {
          const py = this.ys[y],
            dy = py - copper.a.y
          const row = y * this.nx
          for (let x = loX; x <= hiX; x++) {
            const id = x + row
            if (this.blocked[id] || testedBy[id] === copperStamp) continue
            testedBy[id] = copperStamp
            if (circle) {
              const dx = this.xs[x] - copper.a.x
              if (Math.sqrt(dx * dx + dy * dy) - copper.radius < threshold)
                this.blocked[id] = 1
            } else {
              const p = { x: this.xs[x], y: py }
              if (clearanceToCopper(p, p, copper) < threshold)
                this.blocked[id] = 1
            }
          }
        }
      }
      for (const copper of scene.copper) {
        copperStamp++
        const entry = copperEntry(copper, scene.margin)
        const r = scene.margin + copper.radius
        this.copperBuckets.addCopper(entry, scene.margin)
        if (copper.rect) {
          const q = copper.rect
          markBox(q.minX - r, q.maxX + r, q.minY - r, q.maxY + r, copper)
          continue
        }
        const span = distance(copper.a, copper.b),
          steps = Math.max(1, Math.ceil(span / this.stepSize))
        for (let i = 0; i <= steps; i++) {
          const p = {
            x: copper.a.x + ((copper.b.x - copper.a.x) * i) / steps,
            y: copper.a.y + ((copper.b.y - copper.a.y) * i) / steps,
          }
          markBox(p.x - r, p.x + r, p.y - r, p.y + r, copper)
        }
      }
      const bytes =
        n * 3 +
        gridKey.length * 2 +
        [...this.copperBuckets.values()].reduce(
          (sum, bucket) => sum + bucket.length * 8 + 64,
          0,
        ) +
        scene.copper.length * 80
      if (bytes <= maxHardGridBytes) {
        let retained = [...grids.values()].reduce(
          (sum, value) => sum + value.bytes,
          0,
        )
        while (retained + bytes > maxHardGridBytes && grids.size) {
          const oldest = grids.keys().next().value!
          retained -= grids.get(oldest)!.bytes
          grids.delete(oldest)
        }
        grids.set(gridKey, {
          attachments,
          blocked: this.blocked,
          edgeKnown: this.hardEdgeKnown,
          edgeBlocked: this.hardEdgeBlocked,
          buckets: this.copperBuckets,
          bytes,
        })
      }
    }
    for (const copper of softCopper.filter(
      (c) => c.layer === scene.connection.pointsToConnect[0].layer,
    )) {
      const entry = copperEntry(copper, this.softMargin)
      this.softBuckets.addCopper(entry, this.softMargin)
    }
    const attach = (p: Point): Attachment | undefined => {
      const key = JSON.stringify(p)
      if (attachments.has(key)) return structuredClone(attachments.get(key))
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
      const result = candidates.sort(
        (a, b) => length(a.path) - length(b.path),
      )[0]
      if (attachments.size >= 128)
        attachments.delete(attachments.keys().next().value!)
      attachments.set(key, structuredClone(result))
      return result
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
    this.heap.push(a.id, 0, this.heuristic(start))
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
      x: this.xs[id % this.nx],
      y: this.ys[Math.floor(id / this.nx)],
    }
  }
  private edgeClear(
    from: Point,
    to: Point,
    buckets: CopperBuckets,
    margin = this.scene.margin,
  ): boolean {
    const minX = Math.min(from.x, to.x),
      maxX = Math.max(from.x, to.x)
    const minY = Math.min(from.y, to.y),
      maxY = Math.max(from.y, to.y)
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++)
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++)
        for (const entry of buckets.get(x, y) ?? []) {
          if (
            entry.minX > maxX ||
            entry.maxX < minX ||
            entry.minY > maxY ||
            entry.maxY < minY
          )
            continue
          if (copperTooClose(from, to, entry.copper, margin - 1e-8))
            return false
        }
    return true
  }
  private heuristic(point: Point) {
    const dx = Math.abs(point.x - this.end.x) / this.stepSize
    const dy = Math.abs(point.y - this.end.y) / this.stepSize
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
  }
  step() {
    const {
      heap,
      best,
      parent,
      blocked,
      nx,
      ny,
      xs,
      ys,
      hx,
      hy,
      history,
      travel,
      stepSize,
      maxLength,
      penalty,
      softEdgeKnown,
      softEdgeBlocked,
      hardEdgeKnown,
      hardEdgeBlocked,
      softBuckets,
      copperBuckets,
      softMargin,
    } = this
    const bounds = this.scene.input.bounds
    const edge =
      this.scene.width / 2 + (this.scene.input.minBoardEdgeClearance ?? 0)
    const minX = bounds.minX + edge,
      maxX = bounds.maxX - edge
    const minY = bounds.minY + edge,
      maxY = bounds.maxY - edge
    for (let batch = 0; batch < 500 && !this.failed && !this.solved; batch++) {
      if (!heap.length) {
        this.failed = true
        return
      }
      heap.pop()
      const curId = heap.id,
        curG = heap.g
      if (curG !== best[curId]) continue
      this.expanded++
      if (curId === this.goal) {
        const path: Point[] = []
        for (let id = curId; id >= 0; id = parent[id]) path.push(this.point(id))
        this.result = simplify([
          ...this.startPath,
          ...path.reverse().slice(1),
          ...this.endPath.slice(1),
        ])
        if (
          length(this.result) > maxLength + 1e-8 ||
          !this.scene.pathVisible(this.result)
        ) {
          this.failed = true
          return
        }
        this.solved = true
        return
      }
      const x = curId % nx,
        y = Math.floor(curId / nx)
      let from: Point | undefined
      for (const { dx, dy, offset, diagonal, cost, bit, reverse } of this
        .neighbors) {
        if (x + dx < 0 || x + dx >= nx || y + dy < 0 || y + dy >= ny) continue
        const id = curId + offset
        if (
          blocked[id] ||
          (diagonal && (blocked[curId + dx] || blocked[curId + dy * nx]))
        )
          continue
        // With nonnegative occupancy cost, this is a lower bound on g.
        // An edge that cannot improve the route needs no geometry checks.
        // Keep the addition order used by g below to preserve tie decisions.
        const minimumG = curG + cost + 0 + (history?.[id] ?? 0)
        if (penalty >= 0 && minimumG >= best[id] - 1e-10) continue
        const goalDx = hx[x + dx],
          goalDy = hy[y + dy]
        const heuristic =
          Math.max(goalDx, goalDy) + (Math.SQRT2 - 1) * Math.min(goalDx, goalDy)
        const travelled = (travel?.[curId] ?? 0) + cost * stepSize
        if (travel && travelled + heuristic * stepSize > maxLength + 1e-8)
          continue
        const px = xs[x + dx],
          py = ys[y + dy]
        let point: Point | undefined
        if (px < minX || px > maxX || py < minY || py > maxY) continue
        // Penalize continuous edges, not just occupied vertices: diagonal
        // crossings can occur between clear cells. Use physical clearance
        // so tightly packed but legal parallel lanes remain available.
        if (!(softEdgeKnown[curId] & bit)) {
          softEdgeKnown[curId] |= bit
          softEdgeKnown[id] |= reverse
          if (
            !this.edgeClear(
              (from ??= { x: xs[x], y: ys[y] }),
              (point ??= { x: px, y: py }),
              softBuckets,
              softMargin,
            )
          ) {
            softEdgeBlocked[curId] |= bit
            softEdgeBlocked[id] |= reverse
          }
        }
        const softCost = softEdgeBlocked[curId] & bit ? penalty : 0
        const g = curG + cost + softCost + (history?.[id] ?? 0)
        if (g >= best[id] - 1e-10) continue
        if (!(hardEdgeKnown[curId] & bit)) {
          hardEdgeKnown[curId] |= bit
          hardEdgeKnown[id] |= reverse
          if (
            !this.edgeClear(
              (from ??= { x: xs[x], y: ys[y] }),
              (point ??= { x: px, y: py }),
              copperBuckets,
            )
          ) {
            hardEdgeBlocked[curId] |= bit
            hardEdgeBlocked[id] |= reverse
          }
        }
        if (hardEdgeBlocked[curId] & bit) continue
        best[id] = g
        if (travel) travel[id] = travelled
        parent[id] = curId
        heap.push(id, g, g + heuristic)
      }
    }
  }
}
