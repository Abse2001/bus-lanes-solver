import { distance, length } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x
const vector = (a: Point, b: Point) => ({ x: b.x - a.x, y: b.y - a.y })
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
function intersection(a: Point, u: Point, b: Point, v: Point) {
  const denominator = cross(u, v)
  if (Math.abs(denominator) < 1e-8) return null
  const t = cross(vector(a, b), v) / denominator
  return { x: a.x + t * u.x, y: a.y + t * u.y }
}

/** Slide straight control-lane segments toward the terminal corridor. Keep the
 * adjacent supporting lines, so every ordinary direction and turn is retained.
 * Buses, paired rails, curves and fixed fanouts are never shortened or moved. */
export function compactUnconstrainedLanes(
  input: SimpleRouteJson,
  traces: Trace[],
): Trace[] {
  if (!traces.length) return traces
  const locked = new Set([
    ...(input.buses?.flatMap((b) => b.connectionNames) ?? []),
    ...(input.differentialPairs?.flatMap((p) => p.connectionNames) ?? []),
  ])
  const result = structuredClone(traces)
  const free = result.filter(
    (t) =>
      !locked.has(t.connection_name!) &&
      !t.coupledSection &&
      !t.curvedSegments?.length &&
      t.route.every(
        (p) =>
          p.route_type === "wire" && p.layer === (t.route[0] as Wire).layer,
      ),
  )
  if (!free.length) return traces
  const terminals = result.flatMap((t) => [t.route[0], t.route.at(-1)!])
  const span = result.reduce(
    (s, t) => ({
      x: s.x + Math.abs(t.route[0].x - t.route.at(-1)!.x),
      y: s.y + Math.abs(t.route[0].y - t.route.at(-1)!.y),
    }),
    { x: 0, y: 0 },
  )
  const axis = span.x > span.y ? "y" : "x"
  const center = terminals.reduce((s, p) => s + p[axis], 0) / terminals.length
  const cost = (path: Point[]) =>
    path
      .slice(1)
      .reduce(
        (s, b, i) =>
          s +
          (distance(path[i], b) *
            (Math.abs(path[i][axis] - center) + Math.abs(b[axis] - center))) /
            2,
        0,
      )
  const fixed = fixedCopper(input)
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    // Compact inner lanes first, leaving space for the next outer lane.
    free.sort((a, b) => cost(a.route) - cost(b.route))
    for (const trace of free) {
      const connection = input.connections.find(
        (c) => c.name === trace.connection_name,
      )
      if (!connection) continue
      const width = (trace.route[0] as Wire).width
      const scene = new VectorScene(input, connection, width, [
        ...fixed,
        ...result.flatMap(routeCopper),
      ])
      let path = trace.route as Wire[],
        score = cost(path),
        span = length(path)
      for (let i = 1; i < path.length - 2; i++) {
        const a = path[i - 1],
          b = path[i],
          c = path[i + 1],
          e = path[i + 2]
        const v = vector(b, c),
          size = distance(b, c)
        if (size < width * 2) continue
        const normal = { x: -v.y / size, y: v.x / size }
        let best = path
        for (const factor of [
          20, 10, 5, 2.5, 1, 0.5, -20, -10, -5, -2.5, -1, -0.5,
        ]) {
          const q = {
            x: b.x + factor * width * normal.x,
            y: b.y + factor * width * normal.y,
          }
          const p = intersection(a, vector(a, b), q, v),
            r = intersection(e, vector(e, c), q, v)
          if (
            !p ||
            !r ||
            dot(vector(a, p), vector(a, b)) <= 1e-8 ||
            dot(vector(e, r), vector(e, c)) <= 1e-8 ||
            dot(vector(p, r), v) <= 1e-8
          )
            continue
          // Moving a diagonal can affect either bound. Never trade a smaller
          // transverse envelope for a longer longitudinal excursion.
          if (
            (["x", "y"] as const).some((dimension) => {
              const lo = Math.min(...path.map((p) => p[dimension]))
              const hi = Math.max(...path.map((p) => p[dimension]))
              return [p, r].some(
                (point) =>
                  point[dimension] < lo - 1e-8 || point[dimension] > hi + 1e-8,
              )
            })
          )
            continue
          const candidate = [
            ...path.slice(0, i),
            { ...b, ...p },
            { ...c, ...r },
            ...path.slice(i + 2),
          ]
          const nextScore = cost(candidate),
            nextSpan = length(candidate)
          if (
            nextScore >= score - 1e-6 ||
            nextSpan > span + 1e-8 ||
            !scene.pathVisible([a, p, r, e]) ||
            !tuningPathIsSelfClear(candidate, width / 2 + scene.margin)
          )
            continue
          best = candidate
          score = nextScore
          span = nextSpan
        }
        if (best !== path) {
          path = best
          changed = true
        }
      }
      trace.route = path
    }
    if (!changed) break
  }
  return result
}
