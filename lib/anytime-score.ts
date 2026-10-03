import { length } from "./geometry"
import {
  busLengthReports,
  pairLengthReports,
  fixedRouteLength,
} from "./route-lengths"
import type { SimpleRouteJson, Trace } from "./types"

export interface AnytimeScoreWeights {
  area: number
  skew: number
  length: number
}

export const defaultAnytimeScoreWeights: AnytimeScoreWeights = {
  area: 1,
  skew: 0.1,
  length: 0.2,
}

type Bounds = { minX: number; maxX: number; minY: number; maxY: number }
const emptyBounds = (): Bounds => ({
  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
})
const include = (b: Bounds, x: number, y: number, radius: number) => {
  b.minX = Math.min(b.minX, x - radius)
  b.maxX = Math.max(b.maxX, x + radius)
  b.minY = Math.min(b.minY, y - radius)
  b.maxY = Math.max(b.maxY, y + radius)
}
const area = (b: Bounds) =>
  Number.isFinite(b.minX) ? (b.maxX - b.minX) * (b.maxY - b.minY) : 0

/** Sum envelopes of sampled tuning banks. Ordinary gaps of at most three
 * chords connect the quarter-arcs of a bank. This makes compacting a bank
 * visible to the score even when terminal approaches set the larger bounds. */
function tuningArea(traces: Trace[]) {
  let total = 0
  for (const t of traces) {
    const indices = [...new Set(t.curvedSegments ?? [])]
      .filter((i) => i > 0 && i < t.route.length)
      .sort((a, b) => a - b)
    let bank = emptyBounds(),
      last = -Infinity
    for (const i of indices) {
      if (i - last > 3) {
        total += area(bank)
        bank = emptyBounds()
      }
      for (const p of [t.route[i - 1], t.route[i]])
        if (p.route_type === "wire") include(bank, p.x, p.y, p.width / 2)
      last = i
    }
    total += area(bank)
  }
  return total
}

/** Physical copper envelopes, including wire radii and via pads. Per-lane
 * envelopes expose wasted tuning space even when another lane sets the board's
 * outer bounds. Fixed fanouts count in electrical lengths, not movable area. */
export function scoreAnytimeRoutes(
  input: SimpleRouteJson,
  traces: Trace[],
  weights: AnytimeScoreWeights = defaultAnytimeScoreWeights,
) {
  const bounds = emptyBounds(),
    layers = new Map<string, Bounds>()
  let laneEnvelopeAreaMm2 = 0
  for (const trace of traces) {
    const lane = emptyBounds()
    for (const p of trace.route) {
      const radius =
        p.route_type === "wire"
          ? p.width / 2
          : (p.via_diameter ?? input.minViaPadDiameter ?? 0.3) / 2
      include(bounds, p.x, p.y, radius)
      include(lane, p.x, p.y, radius)
      for (const layer of p.route_type === "wire"
        ? [p.layer]
        : (p.layers ?? [p.from_layer, p.to_layer])) {
        if (!layers.has(layer)) layers.set(layer, emptyBounds())
        include(layers.get(layer)!, p.x, p.y, radius)
      }
    }
    laneEnvelopeAreaMm2 += area(lane)
  }
  const terminalBounds = emptyBounds()
  let shortestLengthMm = 0
  for (const c of input.connections) {
    for (const p of c.pointsToConnect)
      include(terminalBounds, p.x, p.y, input.minTraceWidth / 2)
    shortestLengthMm +=
      length(c.pointsToConnect) + fixedRouteLength(input, c.name)
  }
  const areaScale = Math.max(
    area(terminalBounds),
    input.minTraceWidth ** 2,
    1e-9,
  )
  const envelopeAreaMm2 = area(bounds)
  const layerEnvelopeAreaMm2 = [...layers.values()].reduce(
    (s, b) => s + area(b),
    0,
  )
  const busLengths = busLengthReports(input, traces),
    pairLengths = pairLengthReports(input, traces)
  const constrained = [...busLengths, ...pairLengths].filter(
    (r) => r.toleranceMm !== null && r.skewMm !== null,
  )
  const skewPenalty =
    constrained.reduce(
      (sum, r) =>
        sum +
        (r.skewMm! / Math.max(r.toleranceMm!, input.minTraceWidth, 1e-9)) ** 2,
      0,
    ) / Math.max(1, constrained.length)
  const totalLengthMm = traces.reduce(
    (sum, t) =>
      sum + length(t.route) + fixedRouteLength(input, t.connection_name ?? ""),
    0,
  )
  const tuningEnvelopeAreaMm2 = tuningArea(traces)
  const normalizedArea =
    (0.7 * layerEnvelopeAreaMm2 +
      (0.3 * laneEnvelopeAreaMm2) / Math.max(1, input.connections.length)) /
      areaScale +
    (0.2 * tuningEnvelopeAreaMm2) /
      Math.max(input.minTraceWidth * shortestLengthMm, 1e-9)
  const normalizedLength =
    totalLengthMm / Math.max(shortestLengthMm, input.minTraceWidth, 1e-9)
  return {
    objective:
      weights.area * normalizedArea +
      weights.skew * skewPenalty +
      weights.length * normalizedLength,
    envelopeAreaMm2,
    layerEnvelopeAreaMm2,
    laneEnvelopeAreaMm2,
    tuningEnvelopeAreaMm2,
    skewPenalty,
    totalLengthMm,
    normalizedArea,
    normalizedLength,
    busLengths,
    pairLengths,
  }
}
export type AnytimeScore = ReturnType<typeof scoreAnytimeRoutes>
