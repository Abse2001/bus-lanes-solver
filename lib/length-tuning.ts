import { fixedRouteLength } from "./route-lengths"
import { distance, length, simplify, segmentDistance } from "./geometry"
import { VectorScene, fixedCopper, routeCopper } from "./vector-scene"
import type { SimpleRouteJson, Trace, Point, Wire } from "./types"

/** Generate continuous octilinear tuning patterns while preserving every other
 * lane as hard copper. Revisit blocked lanes after neighboring tuning frees space. */
export function tuneLengths(
  input: SimpleRouteJson,
  traces: Trace[],
  targets: Map<string, number>,
) {
  const fixed = fixedCopper(input)
  function* candidates(t: Trace, scene: VectorScene): Generator<Trace> {
    const connection = input.connections.find(
      (c) => c.name === t.connection_name,
    )!
    const width = (t.route[0] as Wire).width
    const fixedLength = fixedRouteLength(input, connection.name)
    const delta = targets.get(connection.name)! - length(t.route) - fixedLength
    if (delta < 1e-8) {
      yield t
      return
    }
    const clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
    const returnSpacing = Math.max(width + clearance, 3 * width)
    const pitch = 2 * (returnSpacing + 2 * width)
    // Tune the long interior runs before considering short terminal approaches.
    const segments = t.route
      .slice(1)
      .map((p, i) => ({ i, span: distance(t.route[i], p) }))
      .sort((a, b) => b.span - a.span)
    for (const { i } of segments) {
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
          // Size the 45° chamfers from the lobe, leaving a nonzero crown.
          const c = Math.min(
            delta / (2 * teeth),
            w / 10,
            (w / 2 - returnSpacing) / 2,
          )
          const h = delta / (2 * teeth) + 2 * c * (2 - Math.SQRT2)
          for (const phase of [0.5, 0, 1])
            for (const side of [1, -1]) {
              const at = (x: number, y: number) => ({
                x: a.x + ux * x - uy * y * side,
                y: a.y + uy * x + ux * y * side,
              })
              const bump: Point[] = [at(0, 0)]
              for (let tooth = 0; tooth < teeth; tooth++) {
                const offset =
                    span * (1 - fraction) * (0.05 + 0.9 * phase) + tooth * w,
                  gap = w * 0.5
                bump.push(
                  ...[
                    [offset, 0],
                    [offset + c, c],
                    [offset + c, h - c],
                    [offset + 2 * c, h],
                    [offset + gap - 2 * c, h],
                    [offset + gap - c, h - c],
                    [offset + gap - c, c],
                    [offset + gap, 0],
                  ].map(([x, y]) => at(x, y)),
                )
              }
              bump.push(at(span, 0))
              if (!scene.pathVisible(bump)) continue
              const next = simplify([
                ...t.route.slice(0, i),
                ...bump,
                ...t.route.slice(i + 2),
              ])
              if (
                Math.abs(
                  length(next) + fixedLength - targets.get(connection.name)!,
                ) > 1e-6
              )
                continue
              if (!tuningPathIsSelfClear(next, returnSpacing)) continue
              yield {
                ...t,
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
  while (pending.size && changed) {
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
      const next = candidates(traces[index], scene).next().value
      if (!next) continue
      result[index] = next
      pending.delete(index)
      changed = true
    }
  }
  if (pending.size)
    throw Error(
      `Insufficient tuning clearance for ${[...pending].map((i) => traces[i].connection_name).join(", ")}`,
    )
  return result
}

/** Returning arms must retain clearance; adjacent monotone corner geometry
 * belongs to the same uninterrupted copper body. */
export function tuningPathIsSelfClear(path: Point[], required: number) {
  const cumulative = [0]
  const turning = [0]
  const unsafeBends = [0]
  for (let i = 1; i < path.length - 1; i++) {
    const a = { x: path[i].x - path[i - 1].x, y: path[i].y - path[i - 1].y }
    const b = { x: path[i + 1].x - path[i].x, y: path[i + 1].y - path[i].y }
    const angle = Math.abs(
      Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y),
    )
    const cross = Math.abs(a.x * b.y - a.y * b.x)
    const radius =
      cross < 1e-12
        ? Infinity
        : (Math.hypot(a.x, a.y) *
            Math.hypot(b.x, b.y) *
            distance(path[i - 1], path[i + 1])) /
          (2 * cross)
    turning.push(turning[i - 1] + angle)
    unsafeBends.push(
      unsafeBends[i - 1] +
        Number(angle > Math.PI / 8 + 1e-8 || radius < required / 2 - 1e-8),
    )
  }
  for (let i = 1; i < path.length; i++)
    cumulative.push(cumulative[i - 1] + distance(path[i - 1], path[i]))
  for (let i = 0; i < path.length - 1; i++)
    for (let j = i + 2; j < path.length - 1; j++) {
      const a = path[i],
        b = path[i + 1],
        c = path[j],
        d = path[j + 1]
      // Far-apart segments cannot cross or violate copper spacing. Use a
      // conservative bound before either exact distance check, even on arcs.
      const padding = Math.max(required, 1e-9)
      if (
        Math.max(a.x, b.x) + padding < Math.min(c.x, d.x) ||
        Math.max(c.x, d.x) + padding < Math.min(a.x, b.x) ||
        Math.max(a.y, b.y) + padding < Math.min(c.y, d.y) ||
        Math.max(c.y, d.y) + padding < Math.min(a.y, b.y)
      )
        continue
      const separation = segmentDistance([a, b], [c, d])
      if (separation < 1e-9 && cumulative[j] - cumulative[i + 1] > 1e-8)
        return false
      // Chords on the same smooth bend can be closer than the clearance while
      // forming one uninterrupted copper body. Check returning arms outside a
      // half-circle neighborhood; intersections above are never exempted.
      if (
        cumulative[j] - cumulative[i + 1] <= Math.PI * required + 1e-8 &&
        (turning[j] - turning[i] <= Math.PI / 2 + 1e-8 ||
          (turning[j] - turning[i] <= Math.PI + 1e-8 &&
            unsafeBends[j] === unsafeBends[i]))
      )
        continue
      if (separation >= required - 1e-8) continue
      let sx = 0,
        sy = 0
      for (let k = i; k <= j; k++) {
        const dx = path[k + 1].x - path[k].x,
          dy = path[k + 1].y - path[k].y
        if (Math.abs(dx) > 1e-8) {
          if (sx && sx !== Math.sign(dx)) return false
          sx = Math.sign(dx)
        }
        if (Math.abs(dy) > 1e-8) {
          if (sy && sy !== Math.sign(dy)) return false
          sy = Math.sign(dy)
        }
      }
    }
  return true
}
