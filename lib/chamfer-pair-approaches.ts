import { distance } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import type { Connection, SimpleRouteJson, Trace } from "./types"

/** Replace acute octilinear approach corners with three 45-degree turns before
 * length matching. Board-world points in mm, +X right and +Y up. Shared trunk
 * interiors and terminals stay fixed; every bevel is clearance checked. */
export function chamferPairApproaches(
  input: SimpleRouteJson,
  members: Connection[],
  traces: Trace[],
  fixed: Copper[],
  width: number,
  clearance: number,
  maxTrimInTraceWidths = 6,
): Trace[] {
  if (!Number.isFinite(maxTrimInTraceWidths) || maxTrimInTraceWidths <= 0)
    throw Error(
      "Pair corner trim must be a positive finite number of trace widths",
    )
  const result = traces.map((t) => ({ ...t, route: [...t.route] }))
  for (let rail = 0; rail < 2; rail++) {
    const trace = result[rail]
    for (let i = 1; i < trace.route.length - 1; i++) {
      if (
        trace.curvedSegments?.includes(i) ||
        trace.curvedSegments?.includes(i + 1)
      )
        continue
      if (
        trace.coupledSection &&
        i > trace.coupledSection[0] &&
        i < trace.coupledSection[1]
      )
        continue
      const [a, b, c] = trace.route.slice(i - 1, i + 2),
        before = distance(a, b),
        after = distance(b, c)
      if (before < 1e-8 || after < 1e-8) continue
      const u = { x: (b.x - a.x) / before, y: (b.y - a.y) / before },
        v = { x: (c.x - b.x) / after, y: (c.y - b.y) / after }
      if (Math.abs(u.x * v.x + u.y * v.y + Math.SQRT1_2) > 1e-6) continue
      const turn = Math.sign(u.x * v.y - u.y * v.x)
      const trim = Math.min(
        width * maxTrimInTraceWidths,
        before / 2,
        after * 0.8,
      )
      const start = { ...b, x: b.x - u.x * trim, y: b.y - u.y * trim }
      const bevel = (Math.SQRT2 - 1) * trim
      const middle = {
        ...b,
        x: start.x + (u.x - turn * u.y) * Math.SQRT1_2 * bevel,
        y: start.y + (u.y + turn * u.x) * Math.SQRT1_2 * bevel,
      }
      const end = { ...b, x: b.x + v.x * trim, y: b.y + v.y * trim }
      const route = [
        ...trace.route.slice(0, i),
        start,
        middle,
        end,
        ...trace.route.slice(i + 1),
      ]
      if (
        !tuningPathIsSelfClear(route, width + clearance) ||
        !new VectorScene(input, members[rail], width, [
          ...fixed,
          ...routeCopper(result[1 - rail]),
        ]).pathVisible(route)
      )
        continue
      trace.route = route
      if (trace.curvedSegments)
        trace.curvedSegments = trace.curvedSegments.map((index) =>
          index > i ? index + 2 : index,
        )
      if (trace.coupledSection)
        trace.coupledSection = trace.coupledSection.map((index, boundary) =>
          index > i
            ? index + 2
            : index === i && boundary === 0
              ? index + 2
              : index,
        ) as [number, number]
      i += 2
    }
  }
  return result
}
