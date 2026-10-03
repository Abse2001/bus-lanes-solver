import { routeAnglesAreConventional } from "./route-angle-validation"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import type { SimpleRouteJson, Trace, Wire } from "./types"
import { fixedCopper, type Copper } from "./vector-scene"

type Axis = "x" | "y"
type Side = "minimum" | "maximum"

export interface AnytimeStripCollapseOperation {
  layer: string
  axis: Axis
  side: Side
  strip: { min: number; max: number }
  translationMm: number
}

export interface AnytimeStripCollapseProposal {
  traces: Trace[]
  /** The identical continuous coordinate map for previously accepted banks. */
  transform: (traces: Trace[]) => Trace[]
  changedNames: string[]
  operations: AnytimeStripCollapseOperation[]
  estimatedLayerAreaSavingMm2: number
}

export interface AnytimeStripCollapseOptions {
  /** Bounded geometric attempts, including rejected paired-corridor changes. */
  maxCandidates?: number
  fractions?: number[]
}

interface Band {
  layer: string
  axis: Axis
  side: Side
  min: number
  max: number
  pitch: number
  potential: number
}

const EPSILON = 1e-8

function layerArea(traces: Trace[]) {
  const layers = new Map<string, [number, number, number, number]>()
  for (const trace of traces)
    for (const p of trace.route) {
      if (p.route_type !== "wire") continue
      const b = layers.get(p.layer) ?? [
        Infinity,
        -Infinity,
        Infinity,
        -Infinity,
      ]
      b[0] = Math.min(b[0], p.x - p.width / 2)
      b[1] = Math.max(b[1], p.x + p.width / 2)
      b[2] = Math.min(b[2], p.y - p.width / 2)
      b[3] = Math.max(b[3], p.y + p.width / 2)
      layers.set(p.layer, b)
    }
  return [...layers.values()].reduce(
    (sum, b) => sum + (b[1] - b[0]) * (b[3] - b[2]),
    0,
  )
}

function copperProjection(copper: Copper, axis: Axis) {
  if (copper.rect)
    return axis === "x"
      ? [copper.rect.minX, copper.rect.maxX]
      : [copper.rect.minY, copper.rect.maxY]
  return [
    Math.min(copper.a[axis], copper.b[axis]) - copper.radius,
    Math.max(copper.a[axis], copper.b[axis]) + copper.radius,
  ]
}

/** Only the outer half-network can move: all terminals, via handoffs, and
 * immutable copper remain on the stationary side of the band. Including
 * physical obstacle/copper envelopes makes the anchor hull conservative. */
function layerBands(
  input: SimpleRouteJson,
  traces: Trace[],
  fixed: Copper[],
  layer: string,
  axis: Axis,
): Band[] {
  const other = axis === "x" ? "y" : "x",
    wires = traces.flatMap((t) =>
      t.route.filter(
        (p): p is Wire => p.route_type === "wire" && p.layer === layer,
      ),
    )
  if (!wires.length) return []
  const clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    maxWidth = Math.max(...wires.map((p) => p.width)),
    anchors: number[] = []
  for (const trace of traces)
    for (let i = 0; i < trace.route.length; i++) {
      const p = trace.route[i]
      if (p.route_type !== "wire" || p.layer !== layer) continue
      const before = trace.route[i - 1],
        after = trace.route[i + 1]
      if (
        !before ||
        !after ||
        before.route_type === "via" ||
        after.route_type === "via" ||
        (before.route_type === "wire" && before.layer !== layer) ||
        (after.route_type === "wire" && after.layer !== layer)
      )
        anchors.push(p[axis])
    }
  for (const connection of input.connections)
    for (const p of connection.pointsToConnect)
      if (p.layer === layer || p.layers?.includes(layer)) anchors.push(p[axis])
  for (const copper of fixed) {
    if (copper.layer !== layer) continue
    const [min, max] = copperProjection(copper, axis),
      margin = clearance + maxWidth / 2
    anchors.push(min - margin, max + margin)
  }
  if (!anchors.length) return []
  const anchorMin = Math.min(...anchors),
    anchorMax = Math.max(...anchors),
    values = [...new Set([...wires.map((p) => p[axis]), anchorMin, anchorMax])]
      .filter(Number.isFinite)
      .sort((a, b) => a - b),
    breadth =
      Math.max(...wires.map((p) => p[other] + p.width / 2)) -
      Math.min(...wires.map((p) => p[other] - p.width / 2))
  let pitch = maxWidth + clearance
  for (const pair of input.differentialPairs ?? []) {
    const rail = traces.find(
        (t) => t.connection_name === pair.connectionNames[0],
      ),
      p = rail?.coupledSection ? rail.route[rail.coupledSection[0]] : undefined
    if (p?.route_type === "wire" && p.layer === layer)
      pitch = Math.max(pitch, p.width + (pair.traceGap ?? clearance))
  }
  const bands: Band[] = []
  for (let i = 0; i < values.length - 1; i++) {
    const min = values[i],
      max = values[i + 1],
      gap = max - min
    if (gap <= pitch + EPSILON) continue
    const side: Side | undefined =
      max <= anchorMin + EPSILON
        ? "minimum"
        : min >= anchorMax - EPSILON
          ? "maximum"
          : undefined
    if (!side) continue
    // Every segment entering the open band must shorten along the cut axis.
    // Diagonal/curved crossings would change headings or rail offsets.
    let crosses = false,
      safe = true
    for (const trace of traces) {
      const curves = new Set(trace.curvedSegments)
      for (let j = 1; j < trace.route.length; j++) {
        const a = trace.route[j - 1],
          b = trace.route[j]
        if (
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          a.layer !== layer ||
          b.layer !== layer ||
          Math.min(a[axis], b[axis]) >= max - EPSILON ||
          Math.max(a[axis], b[axis]) <= min + EPSILON
        )
          continue
        crosses = true
        if (Math.abs(a[other] - b[other]) > EPSILON || curves.has(j)) {
          safe = false
          break
        }
      }
      if (!safe) break
    }
    if (!safe || !crosses) continue
    bands.push({
      layer,
      axis,
      side,
      min,
      max,
      pitch,
      potential: (gap - pitch) * breadth,
    })
  }
  return bands
}

function operation(
  band: Band,
  fraction: number,
): AnytimeStripCollapseOperation {
  const gap = band.max - band.min
  return {
    layer: band.layer,
    axis: band.axis,
    side: band.side,
    strip: { min: band.min, max: band.max },
    translationMm: Math.min(gap * fraction, gap - band.pitch),
  }
}

function transformer(operations: AnytimeStripCollapseOperation[]) {
  return (traces: Trace[]): Trace[] =>
    traces.map((trace) => {
      let changed = false
      const route = trace.route.map((p) => {
        if (p.route_type !== "wire") return p
        let next = p
        for (const op of operations) {
          if (p.layer !== op.layer) continue
          const value = next[op.axis],
            { min, max } = op.strip,
            weight =
              op.side === "minimum"
                ? Math.max(0, Math.min(1, (max - value) / (max - min)))
                : Math.max(0, Math.min(1, (value - min) / (max - min))),
            delta = weight * op.translationMm * (op.side === "minimum" ? 1 : -1)
          if (Math.abs(delta) <= 1e-12) continue
          next = { ...next, [op.axis]: value + delta }
          changed = true
        }
        return next
      })
      return changed ? { ...trace, route } : trace
    })
}

/** Collapse provably empty outer strips without searching or changing the
 * skeleton topology. Same-side vertices move rigidly; straight crossings
 * shorten and retain their headings. The continuous map also rebases accepted
 * bank geometry, which the transaction caller retunes and validates strictly.
 * Independent layer/axis/side moves commute, so cumulative proposals can
 * reclaim the board envelope even when several layers share its boundary. */
export function* stripCollapseCandidates(
  input: SimpleRouteJson,
  skeletons: Trace[],
  options: AnytimeStripCollapseOptions = {},
): Generator<AnytimeStripCollapseProposal | undefined> {
  const maximum = options.maxCandidates ?? 128
  if (!Number.isFinite(maximum) || maximum < 1) return
  const fractions = [...new Set(options.fractions ?? [0.9, 0.75, 0.5, 0.25])]
    .filter((f) => Number.isFinite(f) && f > 0 && f < 1)
    .sort((a, b) => b - a)
  const layers = [
      ...new Set(
        skeletons.flatMap((t) =>
          t.route.flatMap((p) => (p.route_type === "wire" ? [p.layer] : [])),
        ),
      ),
    ].sort(),
    fixed = fixedCopper(input),
    bands: Band[] = []
  for (const layer of layers) {
    for (const axis of ["x", "y"] as const)
      bands.push(...layerBands(input, skeletons, fixed, layer, axis))
    yield undefined
  }
  bands.sort(
    (a, b) =>
      b.potential - a.potential ||
      b.max - b.min - (a.max - a.min) ||
      a.layer.localeCompare(b.layer) ||
      a.axis.localeCompare(b.axis) ||
      a.side.localeCompare(b.side) ||
      a.min - b.min,
  )
  const best = new Map<string, Band>()
  const groups = new Map<string, Band[]>()
  const directions = new Map<string, Band[]>()
  for (const band of bands) {
    const key = `${band.layer}:${band.axis}:${band.side}`
    if (!best.has(key)) best.set(key, band)
    const group = groups.get(key) ?? []
    group.push(band)
    groups.set(key, group)
    const direction = `${band.axis}:${band.side}`,
      directional = directions.get(direction) ?? []
    directional.push(band)
    directions.set(direction, directional)
  }
  const plans: { bands: Band[]; fraction: number; priority: number }[] = []
  const ordered = (items: Band[]) =>
    [...items].sort(
      (a, b) =>
        a.layer.localeCompare(b.layer) ||
        a.axis.localeCompare(b.axis) ||
        a.side.localeCompare(b.side) ||
        (a.side === "minimum" ? a.min - b.min : b.min - a.min),
    )
  for (const fraction of fractions) {
    // Outside-in ordering leaves the next band's coordinates unchanged. The
    // inner prefix translation then moves every earlier collapsed gap rigidly.
    if (bands.length > 1)
      plans.push({
        bands: ordered(bands),
        fraction,
        priority: bands.reduce((sum, b) => sum + b.potential * fraction, 0),
      })
    // A complete collapse can shorten one matching driver so much that its
    // cohort needs more padding than nearby pockets can hold. Keep bounded
    // alternatives that retain one stationary group, or collapse just one
    // outer direction across layers. These reclaim a shared board boundary
    // without forcing every independent matching correction at once.
    if (groups.size > 1) {
      for (const excluded of groups.values()) {
        const selected = bands.filter((band) => !excluded.includes(band))
        plans.push({
          bands: ordered(selected),
          fraction,
          priority: selected.reduce(
            (sum, b) => sum + b.potential * fraction,
            0,
          ),
        })
      }
      for (const selected of directions.values())
        if (selected.length > 1 && selected.length < bands.length)
          plans.push({
            bands: ordered(selected),
            fraction,
            priority: selected.reduce(
              (sum, b) => sum + b.potential * fraction,
              0,
            ),
          })
    }
    if (best.size > 1 && best.size < bands.length)
      plans.push({
        bands: ordered([...best.values()]),
        fraction,
        priority: [...best.values()].reduce(
          (sum, b) => sum + b.potential * fraction,
          0,
        ),
      })
    for (const band of bands)
      plans.push({
        bands: [band],
        fraction,
        priority: band.potential * fraction,
      })
  }
  plans.sort((a, b) => b.priority - a.priority)
  const beforeArea = layerArea(skeletons),
    seen = new Set<string>()
  let attempted = 0
  for (const plan of plans) {
    const operations = plan.bands.map((band) => operation(band, plan.fraction)),
      key = JSON.stringify(operations)
    if (seen.has(key)) continue
    seen.add(key)
    if (attempted++ >= maximum) return
    const transform = transformer(operations),
      traces = transform(skeletons),
      changedNames = traces
        .filter((t, i) => t !== skeletons[i])
        .map((t) => t.connection_name!)
    if (
      !changedNames.length ||
      !routeAnglesAreConventional(traces) ||
      sharedPairSpacingReports(input, traces).some((r) => !r.matched)
    ) {
      yield undefined
      continue
    }
    const saving = beforeArea - layerArea(traces)
    if (saving <= EPSILON) {
      yield undefined
      continue
    }
    yield {
      traces,
      transform,
      changedNames,
      operations,
      estimatedLayerAreaSavingMm2: saving,
    }
  }
}
