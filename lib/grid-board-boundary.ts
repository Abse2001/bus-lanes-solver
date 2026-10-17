import type { BoardBoundary } from "./board-boundary"
import { pointSegmentDistanceToPoints } from "./geometry"

// Boundary occupancy does not change when negotiation changes copper or sites.
// Cache by value so scoped/spread scene inputs share it, while mutated outlines
// and clearances still receive a fresh mask. Callers always own their copy.
const masks = new Map<string, Uint8Array>()
const maxMaskBytes = 16 * 1024 * 1024
let retainedBytes = 0
const epsilon = 1e-9

function lowerBound(values: Float64Array, target: number) {
  let lo = 0,
    hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(values: Float64Array, target: number) {
  let lo = 0,
    hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Point occupancy equivalent to BoardBoundary.containsSegment(p, p, radius).
 * Uniform, increasing grid axes are the GridHistoryProjector's coordinates.
 * Scanline fills classify the polygon interior without checking every edge for
 * every cell. Exact distances are needed only in narrow edge clearance halos.
 * Every routed edge still receives the continuous capsule containment check. */
export function gridBoardBoundaryMask(
  boundary: BoardBoundary,
  xs: Float64Array,
  ys: Float64Array,
  radius: number,
) {
  const input = boundary.input,
    bounds = input.bounds,
    nx = xs.length,
    ny = ys.length
  const key = JSON.stringify([
    bounds,
    input.outline,
    input.minBoardEdgeClearance,
    radius,
    nx,
    ny,
    xs[0],
    xs[1],
    xs.at(-1),
    ys[0],
    ys[1],
    ys.at(-1),
  ])
  const cached = masks.get(key)
  if (cached) {
    masks.delete(key)
    masks.set(key, cached)
    return cached.slice()
  }
  const blocked = new Uint8Array(nx * ny)
  blocked.fill(1)
  const margin = radius + (input.minBoardEdgeClearance ?? 0),
    minX = bounds.minX + margin - epsilon,
    maxX = bounds.maxX - margin + epsilon,
    minY = bounds.minY + margin - epsilon,
    maxY = bounds.maxY - margin + epsilon,
    loX = lowerBound(xs, minX),
    hiX = upperBound(xs, maxX)
  for (let y = lowerBound(ys, minY); y < ny && ys[y] <= maxY; y++) {
    const row = y * nx,
      py = ys[y]
    if (!boundary.edges.length) {
      blocked.fill(0, row + loX, row + hiX)
      continue
    }
    const crossings: number[] = []
    for (const [a, b] of boundary.edges)
      if (a.y > py !== b.y > py)
        crossings.push(a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y))
    crossings.sort((a, b) => a - b)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const lo = Math.max(loX, lowerBound(xs, crossings[i])),
        hi = Math.min(hiX, lowerBound(xs, crossings[i + 1]))
      if (lo < hi) blocked.fill(0, row + lo, row + hi)
    }
  }
  const required = Math.max(margin - epsilon, epsilon)
  for (const [a, b] of boundary.edges) {
    const dx = b.x - a.x,
      dy = b.y - a.y,
      firstY = lowerBound(ys, Math.min(a.y, b.y) - required),
      lastY = upperBound(ys, Math.max(a.y, b.y) + required)
    for (let y = firstY; y < lastY; y++) {
      const py = ys[y],
        row = y * nx
      // Intersect the centerline with this row's vertical clearance band.
      // Inflating its x interval bounds the capsule without filling a long
      // diagonal edge's mostly empty axis-aligned bounding rectangle.
      const t0 = dy ? Math.max(0, Math.min(1, (py - required - a.y) / dy)) : 0,
        t1 = dy ? Math.max(0, Math.min(1, (py + required - a.y) / dy)) : 1,
        x0 = a.x + t0 * dx,
        x1 = a.x + t1 * dx,
        firstX = lowerBound(xs, Math.min(x0, x1) - required),
        lastX = upperBound(xs, Math.max(x0, x1) + required)
      for (let x = firstX; x < lastX; x++) {
        const id = row + x
        if (
          !blocked[id] &&
          pointSegmentDistanceToPoints({ x: xs[x], y: py }, a, b) < required
        )
          blocked[id] = 1
      }
    }
  }
  if (blocked.byteLength <= maxMaskBytes) {
    while (retainedBytes + blocked.byteLength > maxMaskBytes && masks.size) {
      const oldest = masks.keys().next().value!
      retainedBytes -= masks.get(oldest)!.byteLength
      masks.delete(oldest)
    }
    masks.set(key, blocked.slice())
    retainedBytes += blocked.byteLength
  }
  return blocked
}
