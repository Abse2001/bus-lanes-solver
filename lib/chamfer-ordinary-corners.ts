import { distance } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { fixedCopper, VectorScene, type Copper } from "./vector-scene"
import type { SimpleRouteJson, Trace } from "./types"

/** Bevel ordinary 90-degree lane corners before length matching. Endpoints,
 * curve chords and shared pair interiors stay fixed. Each largest candidate
 * starts at 1.5 trace widths, bounded by its neighboring runs, and is halved
 * only when continuous copper clearance rejects it. A caller may retry with
 * a smaller starting trim when subsequent length matching rejects a candidate.
 * Coordinates are mm. */
export function chamferOrdinaryCorners(
  input: SimpleRouteJson,
  traces: Trace[],
  fixed: Copper[] = fixedCopper(input),
  maxTrimInTraceWidths = 1.5,
): Trace[] {
  if (!Number.isFinite(maxTrimInTraceWidths) || maxTrimInTraceWidths <= 0)
    throw Error("Corner trim must be a positive finite number of trace widths")
  const result = traces.map((t) => ({ ...t, route: [...t.route] }))
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  for (const [traceIndex, trace] of result.entries()) {
    // This stage operates on the carrier before composing terminal dogbones.
    // Existing multilayer traces are never reinterpreted as one planar path.
    if (trace.route.some((p) => p.route_type !== "wire")) continue
    const connection = input.connections.find(
      (c) => c.name === trace.connection_name,
    )
    if (!connection) continue
    const otherCopper = fixedCopper({
      ...input,
      obstacles: [],
      traces: result.filter((_, i) => i !== traceIndex),
    })
    const scenes = new Map<string, VectorScene>()
    for (let i = 1; i < trace.route.length - 1; i++) {
      const [a, b, c] = trace.route.slice(i - 1, i + 2)
      if (
        a.route_type !== "wire" ||
        b.route_type !== "wire" ||
        c.route_type !== "wire" ||
        a.layer !== b.layer ||
        b.layer !== c.layer ||
        trace.curvedSegments?.some((index) => index === i || index === i + 1) ||
        (trace.coupledSection &&
          i > trace.coupledSection[0] &&
          i < trace.coupledSection[1])
      )
        continue
      const before = distance(a, b),
        after = distance(b, c)
      if (before < 1e-8 || after < 1e-8) continue
      const u = { x: (b.x - a.x) / before, y: (b.y - a.y) / before },
        v = { x: (c.x - b.x) / after, y: (c.y - b.y) / after }
      const octilinear = (p: typeof u) =>
        Math.min(Math.abs(p.x), Math.abs(p.y)) < 1e-8 ||
        Math.abs(Math.abs(p.x) - Math.abs(p.y)) < 1e-8
      const dot = u.x * v.x + u.y * v.y
      const acute = Math.abs(dot + Math.SQRT1_2) < 1e-8
      if (!octilinear(u) || !octilinear(v) || (Math.abs(dot) > 1e-8 && !acute))
        continue
      const key = `${b.layer}/${b.width}`
      let scene = scenes.get(key)
      if (!scene) {
        scene = new VectorScene(
          input,
          {
            ...connection,
            pointsToConnect: connection.pointsToConnect.map((p) => ({
              ...p,
              layer: b.layer,
            })),
          },
          b.width,
          [...fixed, ...otherCopper],
        )
        scenes.set(key, scene)
      }
      const maximumTrim = Math.min(
        maxTrimInTraceWidths * b.width,
        before / 2,
        after / 2,
      )
      for (let attempt = 0; attempt < 8; attempt++) {
        const trim = maximumTrim / 2 ** attempt
        if (trim < 1e-6) break
        const start = { ...b, x: b.x - u.x * trim, y: b.y - u.y * trim }
        const end = { ...b, x: b.x + v.x * trim, y: b.y + v.y * trim }
        const turn = Math.sign(u.x * v.y - u.y * v.x)
        const bevel = (Math.SQRT2 - 1) * trim
        const middle = {
          ...b,
          x: start.x + (u.x - turn * u.y) * Math.SQRT1_2 * bevel,
          y: start.y + (u.y + turn * u.x) * Math.SQRT1_2 * bevel,
        }
        const inserted = acute ? [start, middle, end] : [start, end]
        const added = inserted.length - 1
        const route = [
          ...trace.route.slice(0, i),
          ...inserted,
          ...trace.route.slice(i + 1),
        ]
        if (
          !scene.pathVisible(route) ||
          (!tuningPathIsSelfClear(route, b.width + clearance) &&
            tuningPathIsSelfClear(trace.route, b.width + clearance))
        )
          continue
        trace.route = route
        trace.curvedSegments = trace.curvedSegments?.map((index) =>
          index > i ? index + added : index,
        )
        trace.coupledSection = trace.coupledSection?.map((index, boundary) =>
          index > i || (index === i && boundary === 0) ? index + added : index,
        ) as [number, number] | undefined
        i += added
        break
      }
    }
  }
  return result
}
