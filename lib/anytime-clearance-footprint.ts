import type { SimpleRouteJson, Trace } from "./types"
import { fixedCopper } from "./vector-scene"

export interface AnytimeClearanceFootprint {
  /** Per-layer union summed across layers; units are layer-mm². */
  areaMm2: number
  /** Mean exclusion area over every physical routing layer, in board mm². */
  meanLayerAreaMm2: number
  pitchMm: number
}

type LayerRaster = { immutable: Uint8Array; stamps: Uint32Array }
type TraceRaster = Map<string, Uint32Array>
type RasterCache = {
  pitch: number
  padding: number
  columns: number
  rows: number
  minX: number
  minY: number
  layerNames: string[]
  domain: Uint8Array
  layers: Map<string, LayerRaster>
  epoch: number
  traces: WeakMap<Trace, TraceRaster>
}

const MAX_CELLS_PER_LAYER = 1_000_000
const caches = new WeakMap<SimpleRouteJson, RasterCache>()

function physicalLayers(input: SimpleRouteJson) {
  return Array.from({ length: input.layerCount }, (_, i) =>
    i === 0 ? "top" : i === input.layerCount - 1 ? "bottom" : `inner${i}`,
  )
}

function layerRaster(cache: RasterCache, layer: string) {
  let raster = cache.layers.get(layer)
  if (!raster) {
    const cells = cache.columns * cache.rows
    raster = {
      immutable: cache.domain.slice(),
      stamps: new Uint32Array(cells),
    }
    cache.layers.set(layer, raster)
  }
  return raster
}

function nextEpoch(cache: RasterCache) {
  if (++cache.epoch >= 0xffff_ffff) {
    for (const raster of cache.layers.values()) raster.stamps.fill(0)
    cache.epoch = 1
  }
  return cache.epoch
}

function interval(
  cache: RasterCache,
  row: number,
  minX: number,
  maxX: number,
  write: (cell: number) => void,
) {
  const first = Math.max(
    0,
    Math.ceil((minX - cache.minX) / cache.pitch - 0.5 - 1e-10),
  )
  const last = Math.min(
    cache.columns - 1,
    Math.floor((maxX - cache.minX) / cache.pitch - 0.5 + 1e-10),
  )
  const base = row * cache.columns
  for (let column = first; column <= last; column++) write(base + column)
}

/** A capsule intersects a horizontal scanline in a single interval. Endpoint
 * disks and the normal-offset segment rectangle give its exact interval, so
 * long diagonal traces cost their occupied cells rather than their huge AABB. */
function capsule(
  cache: RasterCache,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
  write: (cell: number) => void,
) {
  const first = Math.max(
    0,
    Math.ceil(
      (Math.min(ay, by) - radius - cache.minY) / cache.pitch - 0.5 - 1e-10,
    ),
  )
  const last = Math.min(
    cache.rows - 1,
    Math.floor(
      (Math.max(ay, by) + radius - cache.minY) / cache.pitch - 0.5 + 1e-10,
    ),
  )
  const dx = bx - ax,
    dy = by - ay,
    square = dx * dx + dy * dy
  const span = Math.sqrt(square),
    rSquare = radius * radius
  for (let row = first; row <= last; row++) {
    const y = cache.minY + (row + 0.5) * cache.pitch
    let lo = Infinity,
      hi = -Infinity
    const da = y - ay,
      db = y - by
    if (Math.abs(da) <= radius) {
      const spread = Math.sqrt(Math.max(0, rSquare - da * da))
      lo = ax - spread
      hi = ax + spread
    }
    if (Math.abs(db) <= radius) {
      const spread = Math.sqrt(Math.max(0, rSquare - db * db))
      lo = Math.min(lo, bx - spread)
      hi = Math.max(hi, bx + spread)
    }
    if (square > 1e-20) {
      if (Math.abs(dy) < 1e-12) {
        if (Math.abs(da) <= radius) {
          lo = Math.min(lo, ax, bx)
          hi = Math.max(hi, ax, bx)
        }
      } else {
        const a = ax + (dx * da - radius * span) / dy
        const b = ax + (dx * da + radius * span) / dy
        let rectLo = Math.min(a, b),
          rectHi = Math.max(a, b)
        if (Math.abs(dx) < 1e-12) {
          if (y < Math.min(ay, by) || y > Math.max(ay, by)) rectLo = Infinity
        } else {
          const p = ax - (dy * da) / dx,
            q = ax + (square - dy * da) / dx
          rectLo = Math.max(rectLo, Math.min(p, q))
          rectHi = Math.min(rectHi, Math.max(p, q))
        }
        if (rectLo <= rectHi) {
          lo = Math.min(lo, rectLo)
          hi = Math.max(hi, rectHi)
        }
      }
    }
    if (lo <= hi) interval(cache, row, lo, hi, write)
  }
}

function rectangle(
  cache: RasterCache,
  rect: { minX: number; maxX: number; minY: number; maxY: number },
  radius: number,
  write: (cell: number) => void,
) {
  const first = Math.max(
    0,
    Math.ceil((rect.minY - radius - cache.minY) / cache.pitch - 0.5 - 1e-10),
  )
  const last = Math.min(
    cache.rows - 1,
    Math.floor((rect.maxY + radius - cache.minY) / cache.pitch - 0.5 + 1e-10),
  )
  for (let row = first; row <= last; row++) {
    const y = cache.minY + (row + 0.5) * cache.pitch
    const vertical = Math.max(0, rect.minY - y, y - rect.maxY)
    const spread = Math.sqrt(Math.max(0, radius * radius - vertical * vertical))
    interval(cache, row, rect.minX - spread, rect.maxX + spread, write)
  }
}

function cacheFor(input: SimpleRouteJson): RasterCache {
  const cached = caches.get(input)
  if (cached) return cached
  const width = input.bounds.maxX - input.bounds.minX
  const height = input.bounds.maxY - input.bounds.minY
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isInteger(input.layerCount) ||
    input.layerCount < 1
  )
    throw Error(
      "Clearance footprint requires finite board bounds and physical layers",
    )
  const base = Math.max(input.minTraceWidth, 0.1)
  // (width / pitch + 1) * (height / pitch + 1) <= cap bounds ceil() counts.
  const adaptive =
    (width +
      height +
      Math.sqrt(
        (width + height) ** 2 + 4 * (MAX_CELLS_PER_LAYER - 1) * width * height,
      )) /
    (2 * (MAX_CELLS_PER_LAYER - 1))
  const pitch = Math.max(base, adaptive * (1 + 1e-12))
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const columns = Math.ceil(width / pitch),
    rows = Math.ceil(height / pitch)
  const domain = new Uint8Array(columns * rows)
  const boardGuard =
    (input.minBoardEdgeClearance ?? 0) +
    input.minTraceWidth / 2 +
    pitch * Math.SQRT1_2 +
    1e-12
  const firstColumn = Math.max(0, Math.floor(boardGuard / pitch - 0.5) + 1)
  const lastColumn = Math.min(
    columns - 1,
    Math.ceil((width - boardGuard) / pitch - 0.5) - 1,
  )
  const firstRow = Math.max(0, Math.floor(boardGuard / pitch - 0.5) + 1)
  const lastRow = Math.min(
    rows - 1,
    Math.ceil((height - boardGuard) / pitch - 0.5) - 1,
  )
  if (firstColumn > lastColumn || firstRow > lastRow) domain.fill(1)
  else {
    domain.fill(1, 0, firstRow * columns)
    domain.fill(1, (lastRow + 1) * columns)
    for (let row = firstRow; row <= lastRow; row++) {
      domain.fill(1, row * columns, row * columns + firstColumn)
      domain.fill(1, row * columns + lastColumn + 1, (row + 1) * columns)
    }
  }
  const cache: RasterCache = {
    pitch,
    padding: clearance + input.minTraceWidth / 2 + pitch * Math.SQRT1_2,
    columns,
    rows,
    minX: input.bounds.minX,
    minY: input.bounds.minY,
    layerNames: physicalLayers(input),
    domain,
    layers: new Map(),
    epoch: 0,
    traces: new WeakMap(),
  }
  const native = {
    ...input,
    traces: input.traces?.map((trace) => ({
      ...trace,
      route: trace.route.map((point) =>
        point.route_type === "via" && point.via_diameter === undefined
          ? { ...point, via_diameter: input.minViaPadDiameter ?? 0.3 }
          : point,
      ),
    })),
  }
  for (const copper of fixedCopper(native)) {
    const immutable = layerRaster(cache, copper.layer).immutable
    const write = (cell: number) => {
      immutable[cell] = 1
    }
    if (copper.rect) rectangle(cache, copper.rect, cache.padding, write)
    else
      capsule(
        cache,
        copper.a.x,
        copper.a.y,
        copper.b.x,
        copper.b.y,
        copper.radius + cache.padding,
        write,
      )
  }
  caches.set(input, cache)
  return cache
}

function rasterizeTrace(
  input: SimpleRouteJson,
  cache: RasterCache,
  trace: Trace,
) {
  const cached = cache.traces.get(trace)
  if (cached) return cached
  const epoch = nextEpoch(cache)
  const occupied = new Map<string, number[]>()
  const writers = new Map<string, (cell: number) => void>()
  const writer = (layer: string) => {
    let write = writers.get(layer)
    if (!write) {
      const raster = layerRaster(cache, layer),
        cells: number[] = []
      occupied.set(layer, cells)
      write = (cell: number) => {
        if (!raster.immutable[cell] && raster.stamps[cell] !== epoch) {
          raster.stamps[cell] = epoch
          cells.push(cell)
        }
      }
      writers.set(layer, write)
    }
    return write
  }
  for (let index = 0; index < trace.route.length; index++) {
    const a = trace.route[index],
      b = trace.route[index + 1]
    if (a.route_type === "via") {
      const first = cache.layerNames.indexOf(a.from_layer),
        last = cache.layerNames.indexOf(a.to_layer)
      const layers =
        a.layers ??
        (first >= 0 && last >= 0
          ? cache.layerNames.slice(
              Math.min(first, last),
              Math.max(first, last) + 1,
            )
          : [...new Set([a.from_layer, a.to_layer])])
      for (const layer of layers)
        capsule(
          cache,
          a.x,
          a.y,
          a.x,
          a.y,
          (a.via_diameter ?? input.minViaPadDiameter ?? 0.3) / 2 +
            cache.padding,
          writer(layer),
        )
    }
    if (
      a.route_type === "wire" &&
      b?.route_type === "wire" &&
      a.layer === b.layer
    )
      capsule(
        cache,
        a.x,
        a.y,
        b.x,
        b.y,
        a.width / 2 + cache.padding,
        writer(a.layer),
      )
    else if (b && a.route_type !== b.route_type) {
      const wire = a.route_type === "wire" ? a : (b as import("./types").Wire)
      capsule(
        cache,
        a.x,
        a.y,
        b.x,
        b.y,
        wire.width / 2 + cache.padding,
        writer(wire.layer),
      )
    } else if (a.route_type === "wire" && !b && trace.route.length === 1)
      capsule(
        cache,
        a.x,
        a.y,
        a.x,
        a.y,
        a.width / 2 + cache.padding,
        writer(a.layer),
      )
  }
  const result = new Map(
    [...occupied].map(([layer, cells]) => [layer, Uint32Array.from(cells)]),
  )
  cache.traces.set(trace, result)
  return result
}

/** Rasterize the extra space excluded to an unrelated minimum-width probe.
 * The board-anchored grid defaults to max(minTraceWidth, .1 mm), increasing
 * deterministically to at most one million cells per layer. Each cell center
 * uses wire radius + clearance + half probe width + half cell diagonal, making
 * the blocked mask conservative. Fixed native obstacles/traces are subtracted
 * once; overlapping generated capsules on a layer count once. Rectangular board
 * edges subtract the probe half-width + edge clearance + half-cell diagonal.
 * Board outlines are not masked; the report's independent probe supports them.
 * Input and trace geometries must be immutable: replacing a changed object
 * invalidates its WeakMap cache. Curved/bank annotations never affect masks.
 */
export function anytimeClearanceFootprint(
  input: SimpleRouteJson,
  traces: Trace[],
): AnytimeClearanceFootprint {
  const cache = cacheFor(input)
  // Prepare every missing trace before stamping the complete union. Reusing
  // the same stamp arrays avoids clearing a board-sized bitmap per proposal.
  const rasters = traces.map((trace) => rasterizeTrace(input, cache, trace))
  const epoch = nextEpoch(cache)
  let cells = 0
  for (const raster of rasters)
    for (const [layer, indices] of raster) {
      const stamps = layerRaster(cache, layer).stamps
      for (const index of indices)
        if (stamps[index] !== epoch) {
          stamps[index] = epoch
          cells++
        }
    }
  const areaMm2 = cells * cache.pitch * cache.pitch
  return {
    areaMm2,
    meanLayerAreaMm2: areaMm2 / input.layerCount,
    pitchMm: cache.pitch,
  }
}
