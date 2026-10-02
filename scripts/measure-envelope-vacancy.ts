import { pointSegmentDistance } from "../lib/geometry"
import { fixedCopper } from "../lib/vector-scene"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

/** Conservative free-space estimate for a minimum-width trace centerline.
 * Count only grid cells wholly outside copper + clearance; this is a packing
 * diagnostic, never a substitute for native DRC. Envelopes are per-layer
 * rectangles clipped to the open inter-package window, not board bounds. */
export function measureEnvelopeVacancy(
  input: SimpleRouteJson,
  traces: Trace[],
  project: (p: Point) => Point,
  window: { start: number; end: number },
) {
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const padding = clearance + input.minTraceWidth / 2
  const envelopes = new Map<string, { min: number; max: number }>()
  for (const trace of traces)
    for (let i = 1; i < trace.route.length; i++) {
      const a = trace.route[i - 1],
        b = trace.route[i]
      if (
        a.route_type !== "wire" ||
        b.route_type !== "wire" ||
        a.layer !== b.layer
      )
        continue
      const p = project(a),
        q = project(b)
      if (Math.max(p.x, q.x) < window.start || Math.min(p.x, q.x) > window.end)
        continue
      const values =
        Math.abs(q.x - p.x) < 1e-10
          ? [0, 1]
          : [
              Math.max(0, Math.min(1, (window.start - p.x) / (q.x - p.x))),
              Math.max(0, Math.min(1, (window.end - p.x) / (q.x - p.x))),
            ]
      const envelope = envelopes.get(a.layer) ?? {
        min: Infinity,
        max: -Infinity,
      }
      for (const t of values) {
        const v = p.y + (q.y - p.y) * t
        envelope.min = Math.min(
          envelope.min,
          v - Math.max(a.width, b.width) / 2,
        )
        envelope.max = Math.max(
          envelope.max,
          v + Math.max(a.width, b.width) / 2,
        )
      }
      envelopes.set(a.layer, envelope)
    }
  const copper = fixedCopper({
    ...input,
    traces: [...(input.traces ?? []), ...traces],
  })
  const layers = [...envelopes].map(([layer, envelope]) => {
    const width = window.end - window.start,
      height = envelope.max - envelope.min
    const resolution = Math.max(0.1, Math.sqrt((width * height) / 250_000))
    const nx = Math.max(1, Math.ceil(width / resolution)),
      ny = Math.max(1, Math.ceil(height / resolution))
    const dx = width / nx,
      dy = height / ny,
      halo = Math.hypot(dx, dy) / 2
    const blocked = new Uint8Array(nx * ny)
    for (const c of copper) {
      if (c.layer !== layer) continue
      const a = project(c.a),
        b = project(c.b)
      const corners = c.rect
        ? [
            project({ x: c.rect.minX, y: c.rect.minY }),
            project({ x: c.rect.minX, y: c.rect.maxY }),
            project({ x: c.rect.maxX, y: c.rect.minY }),
            project({ x: c.rect.maxX, y: c.rect.maxY }),
          ]
        : [a, b]
      const radius = c.radius + padding + halo
      const minX = Math.min(...corners.map((p) => p.x)) - radius,
        maxX = Math.max(...corners.map((p) => p.x)) + radius
      const minY = Math.min(...corners.map((p) => p.y)) - radius,
        maxY = Math.max(...corners.map((p) => p.y)) + radius
      const x0 = Math.max(0, Math.floor((minX - window.start) / dx)),
        x1 = Math.min(nx - 1, Math.floor((maxX - window.start) / dx))
      const y0 = Math.max(0, Math.floor((minY - envelope.min) / dy)),
        y1 = Math.min(ny - 1, Math.floor((maxY - envelope.min) / dy))
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          if (blocked[y * nx + x]) continue
          const p = {
            x: window.start + (x + 0.5) * dx,
            y: envelope.min + (y + 0.5) * dy,
          }
          if (c.rect || pointSegmentDistance(p, [a, b]) <= radius)
            blocked[y * nx + x] = 1
        }
    }
    // Largest axis-aligned wholly free rectangle, using row histograms.
    const heights = new Uint32Array(nx)
    let free = 0,
      largest = 0
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const available = !blocked[y * nx + x]
        free += Number(available)
        heights[x] = available ? heights[x] + 1 : 0
      }
      const stack: number[] = []
      for (let x = 0; x <= nx; x++) {
        const h = x === nx ? 0 : heights[x]
        while (stack.length && heights[stack.at(-1)!] > h) {
          const top = stack.pop()!
          largest = Math.max(
            largest,
            heights[top] * (x - (stack.at(-1) ?? -1) - 1),
          )
        }
        stack.push(x)
      }
    }
    return {
      layer,
      envelopeAreaMm2: width * height,
      unoccupiedAreaMm2: free * dx * dy,
      unoccupiedFraction: free / (nx * ny),
      largestFreeRectangleMm2: largest * dx * dy,
      gridResolutionMm: resolution,
    }
  })
  return {
    layers,
    envelopeAreaMm2: layers.reduce((s, l) => s + l.envelopeAreaMm2, 0),
    unoccupiedAreaMm2: layers.reduce((s, l) => s + l.unoccupiedAreaMm2, 0),
  }
}
