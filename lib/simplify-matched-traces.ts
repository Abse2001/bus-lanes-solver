import { distance, length, simplify } from "./geometry"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { tuningPathIsSelfClear } from "./length-tuning"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

/** Port of the reference board's scripts/simplify-ordinary-turns.py. Generated
 * octilinear candidates preserve length; curves and coupled rails stay intact.
 * No saved coordinates, signal names, or board-specific dimensions are used. */
export function* ordinaryRunCandidates(
  a: Point,
  b: Point,
  original: Point[] = [],
) {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const x = Math.abs(dx),
    y = Math.abs(dy),
    sx = Math.sign(dx),
    sy = Math.sign(dy)
  const offsets = new Set(
    Array.from({ length: 9 }, (_, i) => (Math.abs(x - y) * i) / 8),
  )
  for (const p of original) {
    const offset =
      x >= y
        ? (p.x - a.x) * sx - (p.y - a.y) * sy
        : (p.y - a.y) * sy - (p.x - a.x) * sx
    if (offset >= 0 && offset <= Math.abs(x - y)) offsets.add(offset)
  }
  for (const k of offsets) {
    yield simplify(
      x >= y
        ? [a, { x: a.x + sx * k, y: a.y }, { x: a.x + sx * (k + y), y: b.y }, b]
        : [
            a,
            { x: a.x, y: a.y + sy * k },
            { x: b.x, y: a.y + sy * (k + x) },
            b,
          ],
    )
  }
}

const gentleTurns = (points: Point[]) =>
  points.slice(1, -1).every((p, i) => {
    const a = points[i],
      b = points[i + 2],
      scale = distance(a, p) * distance(p, b)
    return (
      scale < 1e-12 ||
      ((p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y)) / scale >=
        Math.SQRT1_2 - 1e-8
    )
  })

export function simplifyMatchedTraces(
  input: SimpleRouteJson,
  traces: Trace[],
): Trace[] {
  const result = structuredClone(traces)
  const fixed = fixedCopper(input)
  for (const trace of result) {
    if (trace.coupledSection) continue
    const connection = input.connections.find(
      (c) => c.name === trace.connection_name,
    )!
    const width = (trace.route[0] as Wire).width
    const scene = new VectorScene(input, connection, width, [
      ...fixed,
      ...result.flatMap(routeCopper),
    ])
    const indexCurves = () => {
      const prefix = new Uint32Array(trace.route.length)
      for (const index of new Set(trace.curvedSegments)) prefix[index] = 1
      for (let i = 1; i < prefix.length; i++) prefix[i] += prefix[i - 1]
      return prefix
    }
    let curvedPrefix = indexCurves()
    for (let pass = 0; pass < 3; pass++) {
      let changed = false
      for (let i = 0; i < trace.route.length - 3; i++) {
        for (
          let j = Math.min(trace.route.length - 1, i + 70);
          j >= i + 3;
          j--
        ) {
          if (curvedPrefix[j] !== curvedPrefix[i]) continue
          const originalLength = length(trace.route.slice(i, j + 1))
          let accepted = false
          for (const replacement of ordinaryRunCandidates(
            trace.route[i],
            trace.route[j],
            trace.route.slice(i, j + 1),
          )) {
            if (
              replacement.length >= j - i + 1 ||
              Math.abs(length(replacement) - originalLength) > 1e-8 ||
              !scene.pathVisible(replacement)
            )
              continue
            if (
              !gentleTurns([
                ...trace.route.slice(Math.max(0, i - 1), i),
                ...replacement,
                ...trace.route.slice(j + 1, j + 2),
              ])
            )
              continue
            const wire = trace.route[i] as Wire
            const candidate = [
              ...trace.route.slice(0, i),
              ...replacement.map((p) => ({
                ...p,
                route_type: "wire" as const,
                layer: wire.layer,
                width,
              })),
              ...trace.route.slice(j + 1),
            ]
            if (!tuningPathIsSelfClear(candidate, width / 2 + scene.margin))
              continue
            const delta = replacement.length - (j - i + 1)
            trace.route = candidate
            trace.curvedSegments = trace.curvedSegments?.map((index) =>
              index > j ? index + delta : index,
            )
            curvedPrefix = indexCurves()
            changed = accepted = true
            break
          }
          if (accepted) break
        }
      }
      if (!changed) break
    }
  }
  return result
}
