import { tuningPathIsSelfClear } from "./length-tuning"
import { smoothTuningLobes, roundedTuningLobes } from "./smooth-tuning"
import { fixedRouteLength } from "./route-lengths"
import { distance, length, simplify, segmentDistance } from "./geometry"
import { VectorScene, fixedCopper, routeCopper } from "./vector-scene"
import type { SimpleRouteJson, Trace, Point, Wire } from "./types"

/** Generate continuous octilinear tuning patterns while preserving every other
 * lane as hard copper. Revisit blocked lanes after neighboring tuning frees space. */
export function tuneSmoothLengths(
  input: SimpleRouteJson,
  traces: Trace[],
  targets: Map<string, number>,
  distribute = false,
) {
  const fixed = fixedCopper(input)
  function* candidates(
    t: Trace,
    scene: VectorScene,
    maximumDelta = Infinity,
  ): Generator<Trace> {
    const connection = input.connections.find(
      (c) => c.name === t.connection_name,
    )!
    const width = (t.route[0] as Wire).width
    const fixedLength = fixedRouteLength(input, connection.name)
    const delta = Math.min(
      maximumDelta,
      targets.get(connection.name)! - length(t.route) - fixedLength,
    )
    const target = length(t.route) + fixedLength + Math.max(0, delta)
    if (delta < 1e-8) {
      yield t
      return
    }
    const clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
    const returnSpacing = width + clearance
    const pitch = 4 * Math.max(width * 1.2, clearance)
    // Tune the long interior runs before considering short terminal approaches.
    const segments = t.route
      .slice(1)
      .map((p, i) => ({ i, span: distance(t.route[i], p) }))
      .sort((a, b) => b.span - a.span)
    for (const { i } of segments) {
      if (
        t.coupledSection &&
        i >= t.coupledSection[0] &&
        i < t.coupledSection[1]
      )
        continue
      const a = t.route[i],
        b = t.route[i + 1],
        span = distance(a, b)
      if (span < 0.01) continue
      const ux = (b.x - a.x) / span,
        uy = (b.y - a.y) / span
      // Spread substantial deficits over several lobes without turning small
      // corrections into dozens of microscopic teeth.
      const maximumTeeth = Math.floor((span * 0.9) / pitch)
      const preferredTeeth = Math.min(
        maximumTeeth,
        Math.max(2, Math.ceil(delta / (12 * width))),
      )
      const counts = Array.from({ length: maximumTeeth }, (_, i) => i + 1).sort(
        (a, b) =>
          Math.abs(a - preferredTeeth) - Math.abs(b - preferredTeeth) || b - a,
      )
      for (const teeth of counts) {
        for (const fraction of [0.9, 0.65, 0.4]) {
          const w = (span * fraction) / teeth
          if (w < pitch) continue
          for (const phase of [0.5, 0, 1])
            for (const side of [1, -1])
              for (const createLobes of [
                roundedTuningLobes,
                smoothTuningLobes,
              ]) {
                const offset = span * (1 - fraction) * (0.05 + 0.9 * phase)
                const start = { x: a.x + ux * offset, y: a.y + uy * offset }
                const end = {
                  x: start.x + ux * span * fraction,
                  y: start.y + uy * span * fraction,
                }
                const lobes = createLobes(
                  start,
                  end,
                  delta,
                  teeth,
                  side,
                  Math.max(width * 1.2, clearance),
                )
                if (!lobes) continue
                const bump: Point[] = [a, ...lobes, b]
                if (!scene.pathVisible(bump)) continue
                const next = (
                  t.coupledSection ? (points: Point[]) => points : simplify
                )([...t.route.slice(0, i), ...bump, ...t.route.slice(i + 2)])
                if (Math.abs(length(next) + fixedLength - target) > 1e-6)
                  continue
                if (!tuningPathIsSelfClear(next, returnSpacing)) continue
                yield {
                  ...t,
                  coupledSection: t.coupledSection
                    ? (t.coupledSection.map((v) =>
                        v > i ? v + next.length - t.route.length : v,
                      ) as [number, number])
                    : undefined,
                  curvedSegments: next.slice(1).flatMap((p, i) => {
                    const dx = Math.abs(p.x - next[i].x),
                      dy = Math.abs(p.y - next[i].y)
                    return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8
                      ? [i + 1]
                      : []
                  }),
                  route: next.map((p) => ({
                    ...p,
                    route_type: "wire",
                    layer: connection.pointsToConnect[0].layer,
                    width,
                  })),
                }
              }
        }
      }
    }
  }
  const result = [...traces]
  const pending = new Set(traces.map((_, i) => i))
  let changed = true
  let passes = 0
  while (
    pending.size &&
    changed &&
    passes++ < (distribute ? 32 : traces.length + 1)
  ) {
    changed = false
    for (const index of pending) {
      const connection = input.connections.find(
        (c) => c.name === traces[index].connection_name,
      )!
      const scene = new VectorScene(
        input,
        connection,
        (traces[index].route[0] as Wire).width,
        [...fixed, ...result.flatMap(routeCopper)],
      )
      const trace = result[index]
      const missing =
        targets.get(connection.name)! -
        length(trace.route) -
        fixedRouteLength(input, connection.name)
      let next = candidates(trace, scene).next().value
      if (!next && distribute) {
        for (const fraction of [0.5, 0.25, 0.125, 0.0625]) {
          if (missing * fraction < 0.01) break
          next = candidates(trace, scene, missing * fraction).next().value
          if (next) break
        }
      }
      if (!next) continue
      result[index] = next
      if (
        length(next.route) + fixedRouteLength(input, connection.name) >=
        targets.get(connection.name)! - 1e-6
      )
        pending.delete(index)
      changed = true
    }
  }
  if (pending.size)
    throw Error(
      `Insufficient tuning clearance for ${[...pending].map((i) => `${traces[i].connection_name}${distribute ? ` (${(targets.get(traces[i].connection_name!)! - length(result[i].route) - fixedRouteLength(input, traces[i].connection_name!)).toFixed(3)} mm)` : ""}`).join(", ")}`,
    )
  return result
}
