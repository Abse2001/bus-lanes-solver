import type { Point, SimpleRouteJson, Trace } from "../lib/types"
import { interPackageTuningWindow } from "../lib/inter-package-tuning-window"

type Bounds = { minX: number; maxX: number; minY: number; maxY: number }
const empty = (): Bounds => ({
  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
})
const include = (b: Bounds, p: Point, r: number) => {
  b.minX = Math.min(b.minX, p.x - r)
  b.maxX = Math.max(b.maxX, p.x + r)
  b.minY = Math.min(b.minY, p.y - r)
  b.maxY = Math.max(b.maxY, p.y + r)
}
const measured = (bounds: Bounds) =>
  Number.isFinite(bounds.minX)
    ? {
        ...bounds,
        widthMm: bounds.maxX - bounds.minX,
        heightMm: bounds.maxY - bounds.minY,
        areaMm2: (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY),
      }
    : null

/** Copper envelopes include wire radii and via pads. Fixed power copper is not
 * counted as signal area. The middle-region score clips segments to the open
 * inter-package window, measured from the physical package-center axis. */
export function measureRoutingFootprint(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  const bounds = empty(),
    layers = new Map<string, Bounds>()
  for (const trace of traces)
    for (const p of trace.route) {
      const radius =
        p.route_type === "wire"
          ? p.width / 2
          : (p.via_diameter ?? input.minViaPadDiameter ?? 0.6) / 2
      include(bounds, p, radius)
      for (const layer of p.route_type === "wire"
        ? [p.layer]
        : (p.layers ?? [p.from_layer, p.to_layer])) {
        if (!layers.has(layer)) layers.set(layer, empty())
        include(layers.get(layer)!, p, radius)
      }
    }
  const allCopper = { ...bounds }
  for (const trace of input.traces ?? [])
    for (const p of trace.route)
      include(
        allCopper,
        p,
        p.route_type === "wire"
          ? p.width / 2
          : (p.via_diameter ?? input.minViaPadDiameter ?? 0.6) / 2,
      )
  const packages = new Map<string, Bounds>()
  for (const pad of input.obstacles)
    if (pad.componentId) {
      if (!packages.has(pad.componentId)) packages.set(pad.componentId, empty())
      const b = packages.get(pad.componentId)!
      const angle = ((pad.ccwRotationDegrees ?? 0) * Math.PI) / 180
      const dx =
        (Math.abs(Math.cos(angle)) * pad.width +
          Math.abs(Math.sin(angle)) * pad.height) /
        2
      const dy =
        (Math.abs(Math.sin(angle)) * pad.width +
          Math.abs(Math.cos(angle)) * pad.height) /
        2
      include(b, { x: pad.center.x - dx, y: pad.center.y - dy }, 0)
      include(b, { x: pad.center.x + dx, y: pad.center.y + dy }, 0)
    }
  let middleRegionMaxCenterOffsetMm: number | null = null
  if (packages.size === 2 && traces.length) {
    let [a, b] = [...packages.values()].map((p) => ({
      x: (p.minX + p.maxX) / 2,
      y: (p.minY + p.maxY) / 2,
    }))
    const direction = traces.reduce(
      (s, t) => ({
        x: s.x + t.route.at(-1)!.x - t.route[0].x,
        y: s.y + t.route.at(-1)!.y - t.route[0].y,
      }),
      { x: 0, y: 0 },
    )
    if ((b.x - a.x) * direction.x + (b.y - a.y) * direction.y < 0)
      [a, b] = [b, a]
    const span = Math.hypot(b.x - a.x, b.y - a.y)
    if (span > 1e-8) {
      const ux = (b.x - a.x) / span,
        uy = (b.y - a.y) / span
      const along = (p: Point) => p.x * ux + p.y * uy
      const cross = (p: Point) => (p.y - a.y) * ux - (p.x - a.x) * uy
      const window = interPackageTuningWindow(input, traces, along, 0)
      if (window.end > window.start) {
        middleRegionMaxCenterOffsetMm = 0
        for (const t of traces)
          for (let i = 1; i < t.route.length; i++) {
            const p = t.route[i - 1],
              q = t.route[i]
            if (
              p.route_type !== "wire" ||
              q.route_type !== "wire" ||
              p.layer !== q.layer
            )
              continue
            const u = along(p),
              v = along(q)
            if (Math.max(u, v) < window.start || Math.min(u, v) > window.end)
              continue
            const values =
              Math.abs(v - u) < 1e-10
                ? [0, 1]
                : [
                    Math.max(0, Math.min(1, (window.start - u) / (v - u))),
                    Math.max(0, Math.min(1, (window.end - u) / (v - u))),
                  ]
            for (const k of values)
              middleRegionMaxCenterOffsetMm = Math.max(
                middleRegionMaxCenterOffsetMm,
                Math.abs(
                  cross({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k }),
                ) +
                  Math.max(p.width, q.width) / 2,
              )
          }
      }
    }
  }
  return {
    bounds: measured(bounds),
    allCopperBounds: measured(allCopper),
    layers: [...layers].map(([layer, b]) => ({ layer, ...measured(b)! })),
    middleRegionMaxCenterOffsetMm,
  }
}
