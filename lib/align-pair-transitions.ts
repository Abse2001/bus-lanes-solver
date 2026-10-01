import { distance, pointSegmentDistance } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import type { Connection, Point, SimpleRouteJson, Trace } from "./types"

type Jog = { index: number; direction: Point; handedness: number }
const along = (p: Point, u: Point) => p.x * u.x + p.y * u.y

const firstApproachJog = (trace: Trace): Jog | undefined => {
  if (!trace.coupledSection) return
  const end = trace.coupledSection[1]
  if (end < 1 || end + 2 >= trace.route.length) return
  const a = trace.route[end - 1],
    b = trace.route[end],
    span = distance(a, b)
  if (span < 1e-8) return
  const u = { x: (b.x - a.x) / span, y: (b.y - a.y) / span }
  for (let i = end; i + 2 < trace.route.length; i++) {
    const [p, q, r] = trace.route.slice(i, i + 3)
    const size = distance(p, q)
    if (size < 1e-8) return
    const v = { x: (q.x - p.x) / size, y: (q.y - p.y) / size }
    if (distance(v, u) < 1e-7) continue
    const tail = distance(q, r)
    if (tail < 1e-8) return
    const w = { x: (r.x - q.x) / tail, y: (r.y - q.y) / tail }
    if (
      Math.abs(u.x * v.x + u.y * v.y - Math.SQRT1_2) > 1e-7 ||
      distance(w, u) > 1e-7 ||
      trace.curvedSegments?.some(
        (index) => index === i || index === i + 1 || index === i + 2,
      )
    )
      return
    return {
      index: i,
      direction: u,
      handedness: Math.sign(u.x * v.y - u.y * v.x),
    }
  }
}

/** Slide a staggered 45-degree package-approach jog along its two parallel
 * neighbors. This aligns paired transitions without changing trace lengths,
 * headings, terminals, or existing shared copper. Board-world mm (+X right,
 * +Y up); coupling is measured locally and every move passes continuous DRC. */
export function alignPairTransitions(
  input: SimpleRouteJson,
  members: Connection[],
  traces: Trace[],
  fixed: Copper[],
  width: number,
  gap: number,
  clearance: number,
  offsetPath: (path: Point[], offset: number) => Point[],
): Trace[] {
  const jogs = traces.map(firstApproachJog)
  if (
    !jogs[0] ||
    !jogs[1] ||
    jogs[0].handedness !== jogs[1].handedness ||
    distance(jogs[0].direction, jogs[1].direction) > 1e-7
  )
    return traces
  const u = jogs[0].direction,
    pitch = width + gap
  const proposals = traces.map((trace, side) => {
    const jog = jogs[side]!,
      mateJog = jogs[1 - side]!,
      k = jog.index
    // The shared trunk is immutable. A rail whose bend starts at its shared
    // endpoint provides the reference; only the other approach slides.
    if (k <= trace.coupledSection![1]) return
    const mate = traces[1 - side],
      matePoint = mate.route[mateJog.index]
    const offset =
      -(trace.route[k].x - matePoint.x) * u.y +
      (trace.route[k].y - matePoint.y) * u.x
    let reference: Point[]
    try {
      reference = offsetPath(
        mate.route.slice(mateJog.index - 1, mateJog.index + 3),
        Math.sign(offset) * pitch,
      )
    } catch {
      return
    }
    const move =
      (along(reference[1], u) -
        along(trace.route[k], u) +
        (along(reference[2], u) - along(trace.route[k + 1], u))) /
      2
    if (
      Math.abs(move) < 1e-8 ||
      distance(trace.route[k - 1], trace.route[k]) + move <= 1e-8 ||
      distance(trace.route[k + 1], trace.route[k + 2]) - move <= 1e-8
    )
      return
    const route = trace.route.map((p, i) =>
      i === k || i === k + 1
        ? { ...p, x: p.x + u.x * move, y: p.y + u.y * move }
        : p,
    )
    if (
      !tuningPathIsSelfClear(route, width + clearance) ||
      !new VectorScene(input, members[side], width, [
        ...fixed,
        ...routeCopper(mate),
      ]).pathVisible(route)
    )
      return
    return { ...trace, route }
  })
  if (proposals.every((trace) => !trace)) return traces
  const bounds = [
    traces,
    ...proposals.flatMap((trace, side) =>
      trace ? [traces.map((old, i) => (i === side ? trace : old))] : [],
    ),
  ].flatMap((pair) =>
    pair
      .flatMap((trace, side) => [
        trace.route[jogs[side]!.index],
        trace.route[jogs[side]!.index + 1],
      ])
      .map((p) => along(p, u)),
  )
  const lo = Math.min(...bounds) - pitch,
    hi = Math.max(...bounds) + pitch
  const score = (pair: Trace[]) => {
    let maximum = 0
    for (let side = 0; side < 2; side++) {
      const route = pair[side].route,
        mate = pair[1 - side].route,
        k = jogs[side]!.index
      for (let i = k - 1; i <= k + 1; i++) {
        const a = route[i],
          b = route[i + 1],
          start = along(a, u),
          span = along(b, u) - start
        if (span <= 0 || start > hi || start + span < lo) continue
        const from = Math.max(0, (lo - start) / span),
          to = Math.min(1, (hi - start) / span)
        const count = Math.max(
          1,
          Math.ceil((distance(a, b) * (to - from) * 16) / pitch),
        )
        for (let n = 0; n <= count; n++) {
          const t = from + ((to - from) * n) / count
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
          let closest = Infinity
          for (let j = 1; j < mate.length; j++)
            closest = Math.min(
              closest,
              pointSegmentDistance(p, [mate[j - 1], mate[j]]),
            )
          maximum = Math.max(maximum, closest - width)
        }
      }
    }
    return maximum
  }
  let result = traces,
    best = score(traces)
  for (let side = 0; side < 2; side++) {
    if (!proposals[side]) continue
    const pair = traces.map((trace, i) =>
        i === side ? proposals[side]! : trace,
      ),
      next = score(pair)
    if (next < best - 1e-7) {
      result = pair
      best = next
    }
  }
  return result
}
