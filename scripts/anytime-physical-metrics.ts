import { createHash } from "node:crypto"
import { CopperIndex } from "../lib/copper-index"
import { length, pointSegmentDistance } from "../lib/geometry"
import {
  busLengthReports,
  fixedRouteLength,
  pairLengthReports,
} from "../lib/route-lengths"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"
import {
  clearanceToCopper,
  fixedCopper,
  type Copper,
} from "../lib/vector-scene"

export interface PhysicalBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}
export interface PhysicalEnvelope extends PhysicalBounds {
  areaMm2: number
}
export interface AnytimePhysicalProbeOptions {
  roi?: PhysicalBounds
  pitchMm?: number
  clearanceMm?: number
  probeTraceWidthMm?: number
  roiPaddingMm?: number
  maxCellsPerLayer?: number
}
export interface AnytimePhysicalProbe {
  readonly roi: Readonly<PhysicalBounds>
  readonly pitchMm: number
  readonly cellWidthMm: number
  readonly cellHeightMm: number
  readonly columns: number
  readonly rows: number
  readonly layers: readonly string[]
  readonly clearanceMm: number
  readonly probeTraceWidthMm: number
  readonly boardEdgeClearanceMm: number
  readonly inputFingerprint: string
  readonly immutableLayers: ReadonlyArray<{
    layer: string
    immutableBlockedAreaMm2: number
    domainBlockedAreaMm2: number
  }>
}
export interface AnytimePhysicalLayerMetrics {
  layer: string
  carrierTraceCount: number
  fixedTraceCount: number
  carrierViaCount: number
  fixedViaCount: number
  carrierPlanarLengthMm: number
  fixedPlanarLengthMm: number
  totalPlanarLengthMm: number
  carrierEnvelope: PhysicalEnvelope | null
  combinedEnvelope: PhysicalEnvelope | null
  immutableBlockedAreaMm2: number
  domainBlockedAreaMm2: number
  candidateAddedBlockedAreaMm2: number
  totalBlockedAreaMm2: number
  freeAreaMm2: number
  freeFraction: number
  largestFreeRectangleAreaMm2: number
}
export interface AnytimePhysicalMetrics {
  roiAreaMm2: number
  measuredLayerAreaMm2: number
  /** Aggregated raster areas below have units of layer-mm², not board mm². */
  candidateAddedBlockedAreaMm2: number
  immutableBlockedAreaMm2: number
  totalBlockedAreaMm2: number
  freeAreaMm2: number
  freeFraction: number
  carrierEnvelope: PhysicalEnvelope | null
  combinedEnvelope: PhysicalEnvelope | null
  carrierEnvelopeAreaMm2: number
  layerEnvelopeAreaMm2: number
  carrierPlanarLengthMm: number
  fixedPlanarLengthMm: number
  totalPlanarLengthMm: number
  /** Associated pad-to-pad signal copper; excludes unrelated fixed power nets. */
  signalPlanarLengthMm: number
  /** True when native copper OR its probe-clearance exclusion spills past ROI. */
  outsideProbeCopper: boolean
  maxCopperRoiOverflowMm: number
  maxClearanceRoiOverflowMm: number
  layers: AnytimePhysicalLayerMetrics[]
  busLengths: ReturnType<typeof busLengthReports>
  pairLengths: ReturnType<typeof pairLengthReports>
  caveats: readonly string[]
}

type Scene = {
  copper: Copper[]
  lengths: Map<string, number>
  counts: Map<string, number>
  vias: Map<string, number>
}
type ProbeCache = {
  input: SimpleRouteJson
  fixed: Scene
  immutable: Map<string, Uint8Array>
  domainBlocked: number
}
const probeCaches = new WeakMap<AnytimePhysicalProbe, ProbeCache>()
const fingerprint = (input: SimpleRouteJson) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex")
const physicalLayers = (input: SimpleRouteJson) =>
  Array.from({ length: input.layerCount }, (_, i) =>
    i === 0 ? "top" : i === input.layerCount - 1 ? "bottom" : `inner${i}`,
  )
const emptyBounds = (): PhysicalBounds => ({
  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
})
const include = (bounds: PhysicalBounds, point: Point, radius = 0) => {
  bounds.minX = Math.min(bounds.minX, point.x - radius)
  bounds.maxX = Math.max(bounds.maxX, point.x + radius)
  bounds.minY = Math.min(bounds.minY, point.y - radius)
  bounds.maxY = Math.max(bounds.maxY, point.y + radius)
}
const copperBounds = (copper: Copper[], padding = 0) => {
  const bounds = emptyBounds()
  for (const c of copper) {
    if (c.rect) {
      include(bounds, { x: c.rect.minX, y: c.rect.minY }, padding)
      include(bounds, { x: c.rect.maxX, y: c.rect.maxY }, padding)
    } else {
      include(bounds, c.a, c.radius + padding)
      include(bounds, c.b, c.radius + padding)
    }
  }
  return bounds
}
const envelope = (bounds: PhysicalBounds): PhysicalEnvelope | null =>
  Number.isFinite(bounds.minX)
    ? {
        ...bounds,
        areaMm2: (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY),
      }
    : null
const add = (map: Map<string, number>, key: string, value: number) =>
  map.set(key, (map.get(key) ?? 0) + value)
const nativeTraces = (input: SimpleRouteJson, traces: Trace[]) =>
  traces.map((trace) => ({
    ...trace,
    route: trace.route.map((p) =>
      p.route_type === "via" && p.via_diameter === undefined
        ? { ...p, via_diameter: input.minViaPadDiameter ?? 0.3 }
        : p,
    ),
  }))

/** Reuse repository-native segment/via topology. Physical primitives never
 * depend on curvedSegments annotations, tuning-bank partitions or route scores. */
function traceScene(input: SimpleRouteJson, traces: Trace[]): Scene {
  const copper = fixedCopper({
    ...input,
    obstacles: [],
    traces: nativeTraces(input, traces),
  })
  const lengths = new Map<string, number>(),
    counts = new Map<string, number>(),
    vias = new Map<string, number>()
  const layers = physicalLayers(input)
  for (const trace of traces) {
    const touched = new Set<string>()
    for (const p of trace.route) {
      if (p.route_type === "wire") touched.add(p.layer)
      else {
        const a = layers.indexOf(p.from_layer),
          b = layers.indexOf(p.to_layer)
        for (const layer of p.layers ??
          layers.slice(Math.min(a, b), Math.max(a, b) + 1)) {
          touched.add(layer)
          add(vias, layer, 1)
        }
      }
    }
    for (const layer of touched) add(counts, layer, 1)
  }
  for (const c of copper)
    add(lengths, c.layer, Math.hypot(c.a.x - c.b.x, c.a.y - c.b.y))
  return { copper, lengths, counts, vias }
}
function pointInside(point: Point, polygon: Point[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j]
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside
  }
  return inside
}
function blockedAt(index: CopperIndex, point: Point, margin: number) {
  return index.some(
    {
      minX: point.x - margin,
      maxX: point.x + margin,
      minY: point.y - margin,
      maxY: point.y + margin,
    },
    (c) => clearanceToCopper(point, point, c) <= margin,
  )
}
function largestRectangle(blocked: Uint8Array, columns: number, rows: number) {
  const heights = new Uint32Array(columns)
  let largest = 0
  for (let y = 0; y < rows; y++) {
    const stack: number[] = []
    for (let x = 0; x < columns; x++)
      heights[x] = blocked[y * columns + x] ? 0 : heights[x] + 1
    for (let x = 0; x <= columns; x++) {
      const h = x === columns ? 0 : heights[x]
      while (stack.length && heights[stack[stack.length - 1]] > h) {
        const top = stack.pop()!
        largest = Math.max(
          largest,
          heights[top] * (x - (stack[stack.length - 1] ?? -1) - 1),
        )
      }
      stack.push(x)
    }
  }
  return largest
}
function validBounds(bounds: PhysicalBounds) {
  return (
    Object.values(bounds).every(Number.isFinite) &&
    bounds.maxX > bounds.minX &&
    bounds.maxY > bounds.minY
  )
}

/** Freeze this ONCE from a pristine 0x baseline, then reuse it for every effort.
 * Each certified cell's whole diagonal-radius disk must fit within the board
 * and clear immutable copper/keepouts for an unrelated probe trace. Masks are
 * private caches; JSON serialization preserves definitions without megabytes
 * of cell arrays. Default ROI uses baseline native copper + terminal bounds,
 * padded independently of pitch, so .1/.05 mm convergence uses identical ROI. */
export function createAnytimePhysicalProbe(
  input: SimpleRouteJson,
  baselineCarriers: Trace[],
  options: AnytimePhysicalProbeOptions = {},
): AnytimePhysicalProbe {
  const pitchMm = options.pitchMm ?? 0.1
  const clearanceMm =
    options.clearanceMm ??
    input.minTraceToPadEdgeClearance ??
    input.defaultObstacleMargin ??
    0.075
  const probeTraceWidthMm = options.probeTraceWidthMm ?? input.minTraceWidth
  const padding =
    options.roiPaddingMm ??
    clearanceMm + probeTraceWidthMm / 2 + input.minTraceWidth
  if (
    ![pitchMm, probeTraceWidthMm].every((v) => Number.isFinite(v) && v > 0) ||
    ![clearanceMm, padding].every((v) => Number.isFinite(v) && v >= 0)
  )
    throw Error("Invalid physical probe pitch, width or clearance")
  if (
    !validBounds(input.bounds) ||
    !Number.isInteger(input.layerCount) ||
    input.layerCount < 1
  )
    throw Error("Physical probe requires valid board bounds/layers")
  const baseline = traceScene(input, baselineCarriers)
  const bounds = copperBounds(baseline.copper)
  for (const connection of input.connections)
    for (const point of connection.pointsToConnect)
      include(bounds, point, input.minTraceWidth / 2)
  const derived = Number.isFinite(bounds.minX)
    ? {
        minX: bounds.minX - padding,
        maxX: bounds.maxX + padding,
        minY: bounds.minY - padding,
        maxY: bounds.maxY + padding,
      }
    : input.bounds
  const roi = { ...(options.roi ?? derived) }
  if (!validBounds(roi))
    throw Error("Physical probe requires a nonempty finite ROI")
  const columns = Math.ceil((roi.maxX - roi.minX) / pitchMm),
    rows = Math.ceil((roi.maxY - roi.minY) / pitchMm)
  if (columns * rows > (options.maxCellsPerLayer ?? 2_000_000))
    throw Error(
      "Physical probe exceeds maxCellsPerLayer; use an explicit larger limit or coarser fixed pitch",
    )
  const cellWidthMm = (roi.maxX - roi.minX) / columns,
    cellHeightMm = (roi.maxY - roi.minY) / rows
  const halo = Math.hypot(cellWidthMm, cellHeightMm) / 2
  const boardEdgeClearanceMm = input.minBoardEdgeClearance ?? 0
  const guard = clearanceMm + probeTraceWidthMm / 2 + halo + 1e-12
  const boardGuard = boardEdgeClearanceMm + probeTraceWidthMm / 2 + halo + 1e-12
  const pristine = structuredClone(input)
  const fixed = traceScene(pristine, pristine.traces ?? [])
  const immutableCopper = [
    ...fixed.copper,
    ...fixedCopper({ ...pristine, traces: [] }),
  ]
  const layers = [
    ...new Set([
      ...physicalLayers(pristine),
      ...(pristine.allowedLayers ?? []),
      ...immutableCopper.map((c) => c.layer),
      ...baseline.copper.map((c) => c.layer),
    ]),
  ]
  const domain = new Uint8Array(columns * rows)
  let domainBlocked = 0
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const point = {
        x: roi.minX + (x + 0.5) * cellWidthMm,
        y: roi.minY + (y + 0.5) * cellHeightMm,
      }
      let blocked =
        point.x <= pristine.bounds.minX + boardGuard ||
        point.x >= pristine.bounds.maxX - boardGuard ||
        point.y <= pristine.bounds.minY + boardGuard ||
        point.y >= pristine.bounds.maxY - boardGuard
      const outline = pristine.outline
      if (!blocked && outline?.length)
        blocked =
          !pointInside(point, outline) ||
          outline.some(
            (p, i) =>
              pointSegmentDistance(point, [
                p,
                outline[(i + 1) % outline.length],
              ]) <= boardGuard,
          )
      if (blocked) {
        domain[y * columns + x] = 1
        domainBlocked++
      }
    }
  const immutable = new Map<string, Uint8Array>()
  const immutableLayers = layers.map((layer) => {
    const mask = domain.slice(),
      index = new CopperIndex(immutableCopper.filter((c) => c.layer === layer))
    let blocked = domainBlocked
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) {
        const i = y * columns + x
        if (
          !mask[i] &&
          blockedAt(
            index,
            {
              x: roi.minX + (x + 0.5) * cellWidthMm,
              y: roi.minY + (y + 0.5) * cellHeightMm,
            },
            guard,
          )
        ) {
          mask[i] = 1
          blocked++
        }
      }
    immutable.set(layer, mask)
    return Object.freeze({
      layer,
      immutableBlockedAreaMm2: blocked * cellWidthMm * cellHeightMm,
      domainBlockedAreaMm2: domainBlocked * cellWidthMm * cellHeightMm,
    })
  })
  const probe = Object.freeze({
    roi: Object.freeze(roi),
    pitchMm,
    cellWidthMm,
    cellHeightMm,
    columns,
    rows,
    layers: Object.freeze(layers),
    clearanceMm,
    probeTraceWidthMm,
    boardEdgeClearanceMm,
    inputFingerprint: fingerprint(input),
    immutableLayers: Object.freeze(immutableLayers),
  })
  probeCaches.set(probe, { input: pristine, fixed, immutable, domainBlocked })
  return probe
}

/** Conservative raster estimate, not exact freed board area or an additional
 * routed connection. Compare candidate-added exclusion area using the SAME
 * probe, and reject a release claim when outsideProbeCopper is true. */
export function measureAnytimePhysicalMetrics(
  input: SimpleRouteJson,
  candidateCarriers: Trace[],
  probe: AnytimePhysicalProbe,
): AnytimePhysicalMetrics {
  const cache = probeCaches.get(probe)
  if (!cache || fingerprint(input) !== probe.inputFingerprint)
    throw Error(
      "Physical probe must be reused with its pristine input in the same process",
    )
  const fixedIds = new Set((input.traces ?? []).map((t) => t.pcb_trace_id))
  if (candidateCarriers.some((t) => fixedIds.has(t.pcb_trace_id)))
    throw Error(
      "Pass carrier traces only; fixed fanouts are already included once",
    )
  const candidate = traceScene(input, candidateCarriers)
  if (candidate.copper.some((c) => !probe.layers.includes(c.layer)))
    throw Error(
      "Candidate introduced a layer outside the frozen physical probe",
    )
  const cellArea = probe.cellWidthMm * probe.cellHeightMm
  const halo = Math.hypot(probe.cellWidthMm, probe.cellHeightMm) / 2
  const padding = probe.clearanceMm + probe.probeTraceWidthMm / 2
  const guard = padding + halo + 1e-12
  const layers = probe.layers.map((layer) => {
    const copper = candidate.copper.filter((c) => c.layer === layer),
      fixedCopperLayer = cache.fixed.copper.filter((c) => c.layer === layer)
    const index = new CopperIndex(copper),
      blocked = cache.immutable.get(layer)!.slice()
    let added = 0,
      free = 0
    for (let y = 0; y < probe.rows; y++)
      for (let x = 0; x < probe.columns; x++) {
        const i = y * probe.columns + x
        if (
          !blocked[i] &&
          blockedAt(
            index,
            {
              x: probe.roi.minX + (x + 0.5) * probe.cellWidthMm,
              y: probe.roi.minY + (y + 0.5) * probe.cellHeightMm,
            },
            guard,
          )
        ) {
          blocked[i] = 1
          added++
        }
        if (!blocked[i]) free++
      }
    const immutable = probe.immutableLayers.find((l) => l.layer === layer)!
    const carrierPlanarLengthMm = candidate.lengths.get(layer) ?? 0,
      fixedPlanarLengthMm = cache.fixed.lengths.get(layer) ?? 0
    return {
      layer,
      carrierTraceCount: candidate.counts.get(layer) ?? 0,
      fixedTraceCount: cache.fixed.counts.get(layer) ?? 0,
      carrierViaCount: candidate.vias.get(layer) ?? 0,
      fixedViaCount: cache.fixed.vias.get(layer) ?? 0,
      carrierPlanarLengthMm,
      fixedPlanarLengthMm,
      totalPlanarLengthMm: carrierPlanarLengthMm + fixedPlanarLengthMm,
      carrierEnvelope: envelope(copperBounds(copper)),
      combinedEnvelope: envelope(
        copperBounds([...copper, ...fixedCopperLayer]),
      ),
      immutableBlockedAreaMm2: immutable.immutableBlockedAreaMm2,
      domainBlockedAreaMm2: immutable.domainBlockedAreaMm2,
      candidateAddedBlockedAreaMm2: added * cellArea,
      totalBlockedAreaMm2: (probe.columns * probe.rows - free) * cellArea,
      freeAreaMm2: free * cellArea,
      freeFraction: free / (probe.columns * probe.rows),
      largestFreeRectangleAreaMm2:
        largestRectangle(blocked, probe.columns, probe.rows) * cellArea,
    }
  })
  const raw = copperBounds(candidate.copper),
    expanded = copperBounds(candidate.copper, padding)
  const overflow = (b: PhysicalBounds) =>
    Number.isFinite(b.minX)
      ? Math.max(
          0,
          probe.roi.minX - b.minX,
          b.maxX - probe.roi.maxX,
          probe.roi.minY - b.minY,
          b.maxY - probe.roi.maxY,
        )
      : 0
  const maxCopperRoiOverflowMm = overflow(raw),
    maxClearanceRoiOverflowMm = overflow(expanded)
  const carrierEnvelope = envelope(raw),
    combinedEnvelope = envelope(
      copperBounds([...candidate.copper, ...cache.fixed.copper]),
    )
  const carrierPlanarLengthMm = candidateCarriers.reduce(
      (s, t) => s + length(t.route),
      0,
    ),
    fixedPlanarLengthMm = (input.traces ?? []).reduce(
      (s, t) => s + length(t.route),
      0,
    )
  const sum = (
    field:
      | "candidateAddedBlockedAreaMm2"
      | "immutableBlockedAreaMm2"
      | "totalBlockedAreaMm2"
      | "freeAreaMm2",
  ) => layers.reduce((s, l) => s + l[field], 0)
  const roiAreaMm2 =
      (probe.roi.maxX - probe.roi.minX) * (probe.roi.maxY - probe.roi.minY),
    measuredLayerAreaMm2 = roiAreaMm2 * probe.layers.length
  return {
    roiAreaMm2,
    measuredLayerAreaMm2,
    candidateAddedBlockedAreaMm2: sum("candidateAddedBlockedAreaMm2"),
    immutableBlockedAreaMm2: sum("immutableBlockedAreaMm2"),
    totalBlockedAreaMm2: sum("totalBlockedAreaMm2"),
    freeAreaMm2: sum("freeAreaMm2"),
    freeFraction: sum("freeAreaMm2") / measuredLayerAreaMm2,
    carrierEnvelope,
    combinedEnvelope,
    carrierEnvelopeAreaMm2: carrierEnvelope?.areaMm2 ?? 0,
    layerEnvelopeAreaMm2: layers.reduce(
      (s, l) => s + (l.carrierEnvelope?.areaMm2 ?? 0),
      0,
    ),
    carrierPlanarLengthMm,
    fixedPlanarLengthMm,
    totalPlanarLengthMm: carrierPlanarLengthMm + fixedPlanarLengthMm,
    signalPlanarLengthMm: candidateCarriers.reduce(
      (s, t) =>
        s + length(t.route) + fixedRouteLength(input, t.connection_name ?? ""),
      0,
    ),
    outsideProbeCopper: maxClearanceRoiOverflowMm > 1e-9,
    maxCopperRoiOverflowMm,
    maxClearanceRoiOverflowMm,
    layers,
    busLengths: busLengthReports(input, candidateCarriers),
    pairLengths: pairLengthReports(input, candidateCarriers),
    caveats: [
      "Free cells conservatively certify an unrelated probe trace centerline, including cell half-diagonal, trace half-width, declared clearance and board-edge inset.",
      "Immutable blockage includes board/outline exclusions, input obstacles/keepouts and native fixed copper. Rotated obstacle AABBs and supplied raster keepouts conservatively understate available space.",
      "Candidate-added blocked area is the union of additional excluded cells beyond immutable blockage, not a sum of wire or tuning-bank bounding rectangles.",
      "Aggregated occupancy areas have units of layer-mm²; they do not measure board footprint. Report all physical layers, including unused layers.",
      "Raster free area and largest rectangle are lower bounds; their differences are resolution-dependent estimates, not exact freed area or demonstrated additional routing capacity. Audit the same frozen ROI at a finer pitch.",
      "outsideProbeCopper includes clearance-footprint overflow: suppress release claims for such candidates. Raw native envelope/length measurements still include all candidate copper outside the ROI.",
      "Planar lengths include XY wire-to-via approaches but exclude via depth and package delay. Fixed physical totals include unrelated power traces; signal/bus/pair lengths include associated fixed fanouts only.",
    ],
  }
}
