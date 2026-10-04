import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { spreadCoupledTuningLanes } from "./spread-coupled-tuning-lanes"
import { tuneCoupledLengths } from "./tune-coupled-lengths"
import { TuningClearanceError } from "./smooth-length-tuning"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { alignCoupledSectionBoundaries } from "./align-coupled-section-boundaries"
import { fixedCopper } from "./vector-scene"
import { busLengthReports, pairLengthReports } from "./route-lengths"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Signal copper bounding box, including track/via radii. */
export function routeEnvelopeArea(traces: Trace[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const trace of traces)
    for (const p of trace.route) {
      const radius =
        (p.route_type === "wire" ? p.width : (p.via_diameter ?? 0)) / 2
      minX = Math.min(minX, p.x - radius)
      maxX = Math.max(maxX, p.x + radius)
      minY = Math.min(minY, p.y - radius)
      maxY = Math.max(maxY, p.y + radius)
    }
  return traces.length ? (maxX - minX) * (maxY - minY) : 0
}

/** Spend extra bank width only on lanes that exhaust their tuning pockets. */
export function* optimizeTuningEnvelope(
  input: SimpleRouteJson,
  seed: Trace[],
  maxAttempts: number,
): Generator<Trace[] | null> {
  const fixed = fixedCopper(input)
  let attempts = 0
  for (const multiplier of [19, 16]) {
    const pitch = input.minTraceWidth * multiplier
    const pitches = new Map<string, number>()
    for (let local = 0; local < 4 && attempts < maxAttempts; local++) {
      attempts++
      const spread = spreadCoupledTuningLanes(
        input,
        seed,
        pitch,
        "interior",
        false,
        pitches,
      )
      if (!spread) {
        yield null
        break
      }
      try {
        const candidate = alignCoupledSectionBoundaries(
          input,
          chamferOrdinaryCorners(input, spread, fixed, 1.5),
        )
        yield tuneCoupledLengths(input, candidate, {
          maxCandidates: 16384,
          packMeanders: true,
        })
        break
      } catch (error) {
        yield null
        if (!(error instanceof TuningClearanceError)) break
        for (const name of error.connectionNames)
          pitches.set(
            name,
            (pitches.get(name) ?? pitch) + input.minTraceWidth * 2,
          )
      }
    }
  }
}

/** Independent gate before replacing accepted native pad-to-pad copper. */
export function validateNativeEnvelopeCandidate(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  if (
    traces.length !== input.connections.length ||
    new Set(traces.map((t) => t.connection_name)).size !== traces.length
  )
    return false
  const same = (a: Wire, b: Wire) =>
    a.layer === b.layer && Math.hypot(a.x - b.x, a.y - b.y) < 1e-8
  for (const c of input.connections) {
    const trace = traces.find((t) => t.connection_name === c.name)
    if (!trace || trace.route.length < 2) return false
    const a = trace.route[0],
      b = trace.route.at(-1)!
    if (
      a.route_type !== "wire" ||
      b.route_type !== "wire" ||
      c.pointsToConnect.length !== 2
    )
      return false
    const [s, e] = c.pointsToConnect as Wire[]
    if (!((same(a, s) && same(b, e)) || (same(a, e) && same(b, s))))
      return false
  }
  if (
    [
      ...busLengthReports(input, traces),
      ...pairLengthReports(input, traces),
    ].some((r) => r.toleranceMm !== null && !r.matched) ||
    exteriorPairSpacingReports(input, traces).some((r) => !r.matched)
  )
    return false
  const names = new Set(input.connections.map((c) => c.name))
  const fixedConnections = (input.traces ?? []).flatMap((t) => {
    const name = t.connection_name ?? t.source_trace_id
    if (!name || names.has(name)) return []
    names.add(name)
    return [{ name, pointsToConnect: [t.route[0] as Wire] }]
  })
  const native = {
    ...input,
    connections: [...input.connections, ...fixedConnections],
  }
  return validateRoutedCopperDrc({
    inputSrj: native,
    routedSrj: { ...native, traces: [...(input.traces ?? []), ...traces] },
    clearance:
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    allowBlindAndBuriedVias: input.allowBlindAndBuriedVias ?? false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).valid
}
