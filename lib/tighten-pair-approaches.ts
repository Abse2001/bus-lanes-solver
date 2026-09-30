import { distance } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { routeCopper, VectorScene, type Copper } from "./vector-scene"
import type { Connection, Point, SimpleRouteJson, Trace } from "./types"

/** Bring long parallel approach segments onto the pair pitch when clearance
 * permits. Intersections with adjacent headings preserve octilinear corners;
 * terminals and the shared trunk remain fixed. */
export function tightenPairApproaches(
  input: SimpleRouteJson,
  members: Connection[],
  traces: Trace[],
  fixed: Copper[],
  width: number,
  gap: number,
  clearance: number,
): Trace[] {
  const result = traces.map((t) => ({
    ...t,
    route: t.route.map((p) => ({ ...p })),
  }))
  const pitch = width + gap
  const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x
  const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y })
  for (let rail = 0; rail < 2; rail++) {
    const trace = result[rail]
    for (let k = 1; k + 2 < trace.route.length; k++) {
      if (
        trace.coupledSection &&
        k + 1 >= trace.coupledSection[0] &&
        k <= trace.coupledSection[1]
      )
        continue
      const [before, a, b, after] = trace.route.slice(k - 1, k + 3)
      const span = distance(a, b)
      if (span < 4 * pitch) continue
      const u = { x: (b.x - a.x) / span, y: (b.y - a.y) / span }
      const other = result[1 - rail].route
      for (let j = 0; j + 1 < other.length; j++) {
        const c = other[j],
          d = other[j + 1],
          delta = sub(d, c)
        if (Math.abs(cross(u, delta)) > 1e-7) continue
        const offset = cross(u, sub(c, a))
        if (Math.abs(offset) <= pitch + 1e-7 || Math.abs(offset) > 2 * pitch)
          continue
        const projections = [c, d].map(
          (p) => (p.x - a.x) * u.x + (p.y - a.y) * u.y,
        )
        if (
          Math.min(span, Math.max(...projections)) -
            Math.max(0, Math.min(...projections)) <
          4 * pitch
        )
          continue
        const move = offset - Math.sign(offset) * pitch
        const shifted = { x: a.x - u.y * move, y: a.y + u.x * move }
        const intersect = (origin: Point, heading: Point) => {
          const denominator = cross(heading, u)
          if (Math.abs(denominator) < 1e-8) return null
          const t = cross(sub(shifted, origin), u) / denominator
          return { x: origin.x + t * heading.x, y: origin.y + t * heading.y }
        }
        const start = intersect(before, sub(a, before)),
          end = intersect(after, sub(b, after))
        if (
          !start ||
          !end ||
          distance(start, a) > 2 * pitch ||
          distance(end, b) > 2 * pitch
        )
          continue
        const shiftedEnd = {
          ...b,
          x: b.x - u.x * (2 * pitch + Math.abs(move)) - u.y * move,
          y: b.y - u.y * (2 * pitch + Math.abs(move)) + u.x * move,
        }
        const returnEnd = {
          ...b,
          x: b.x - u.x * 2 * pitch,
          y: b.y - u.y * 2 * pitch,
        }
        for (const replacement of [
          [
            { ...a, ...start },
            { ...b, ...end },
          ],
          [{ ...a, ...start }, shiftedEnd, returnEnd, b],
        ]) {
          const forward = (from: Point, to: Point, heading: Point) =>
            (to.x - from.x) * heading.x + (to.y - from.y) * heading.y > 1e-10
          if (
            !forward(before, replacement[0], sub(a, before)) ||
            !forward(replacement.at(-1)!, after, sub(after, b)) ||
            !forward(replacement[0], replacement.at(-1)!, u)
          )
            continue
          const route = [
            ...trace.route.slice(0, k),
            ...replacement,
            ...trace.route.slice(k + 2),
          ]
          if (!tuningPathIsSelfClear(route, width + clearance)) continue
          if (
            !new VectorScene(input, members[rail], width, [
              ...fixed,
              ...routeCopper(result[1 - rail]),
            ]).pathVisible(route)
          )
            continue
          trace.route = route
          if (trace.coupledSection)
            trace.coupledSection = trace.coupledSection.map((index) =>
              index > k ? index + replacement.length - 2 : index,
            ) as [number, number]
          k += replacement.length - 2
          break
        }
        if (trace.route[k] !== a) break
      }
    }
  }
  return result
}
