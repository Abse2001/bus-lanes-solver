import { distance, simplify } from "./geometry"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

/** Spread only the free span between component fields, retaining the routed
 * package approaches. This geometry proposal requires copper validation by the
 * caller, after virtual pair envelopes have been expanded into real rails.
 * All coordinates are board-world millimetres. */
export function buildHypergraphCorridorGeometry(
  input: SimpleRouteJson,
  traces: Trace[],
  pitch: number,
  stagger = 0.1,
  inset = 0.5,
  shift = 0,
): Trace[] | null {
  const dx = traces.reduce((s, t) => s + t.route.at(-1)!.x - t.route[0].x, 0)
  const dy = traces.reduce((s, t) => s + t.route.at(-1)!.y - t.route[0].y, 0)
  const vertical = Math.abs(dy) >= Math.abs(dx)
  const sign = Math.sign(vertical ? dy : dx) || 1
  const uv = (p: Point) => ({
    u: (vertical ? p.y : p.x) * sign,
    v: vertical ? p.x : p.y,
  })
  const xy = (u: number, v: number): Point =>
    vertical ? { x: v, y: u * sign } : { x: u * sign, y: v }
  const ends = [0, 1].map((end) => {
    const ids = new Set(
      traces.map((t) => {
        const p = end ? t.route.at(-1)! : t.route[0]
        return input.obstacles
          .filter(
            (o) => o.componentId && o.connectedTo.includes(t.connection_name!),
          )
          .sort((a, b) => distance(a.center, p) - distance(b.center, p))[0]
          ?.componentId
      }),
    )
    return input.obstacles
      .filter((o) => o.componentId && ids.has(o.componentId))
      .map((o) => ({
        lo: uv(o.center).u - (vertical ? o.height : o.width) / 2,
        hi: uv(o.center).u + (vertical ? o.height : o.width) / 2,
      }))
  })
  if (ends.some((e) => !e.length)) return null
  const lo = Math.max(...ends[0].map((p) => p.hi)) + inset,
    hi = Math.min(...ends[1].map((p) => p.lo)) - inset
  if (hi - lo < 2) return null
  const cuts = (trace: Trace, u: number) => {
    for (let i = 1; i < trace.route.length; i++) {
      const a = uv(trace.route[i - 1]),
        b = uv(trace.route[i])
      if (a.u <= u && b.u >= u && b.u - a.u > 1e-8)
        return { i, v: a.v + ((b.v - a.v) * (u - a.u)) / (b.u - a.u) }
    }
    return null
  }
  const result: Trace[] = []
  for (const layer of new Set(traces.map((t) => (t.route[0] as Wire).layer))) {
    const group = traces
      .filter((t) => (t.route[0] as Wire).layer === layer)
      .map((t) => ({ t, a: cuts(t, lo), b: cuts(t, hi) }))
    if (group.some((g) => !g.a || !g.b)) return null
    group.sort((a, b) => a.a!.v - b.a!.v)
    if (group.some((g, i) => i && g.b!.v < group[i - 1].b!.v)) return null
    if (
      !group.some((g) =>
        input.buses?.some((b) =>
          b.connectionNames.includes(g.t.connection_name!),
        ),
      )
    ) {
      result.push(...group.map((g) => g.t))
      continue
    }
    const center =
      shift +
      group.reduce((s, g) => s + (g.a!.v + g.b!.v) / 2, 0) / group.length
    for (const [index, g] of group.entries()) {
      const a = g.a!,
        b = g.b!,
        v = center + (index - (group.length - 1) / 2) * pitch
      const start = lo + (v > a.v ? group.length - 1 - index : index) * stagger,
        end = hi - (v > b.v ? group.length - 1 - index : index) * stagger
      const lead = Math.abs(v - a.v),
        tail = Math.abs(v - b.v)
      if (lead + tail >= end - start - 0.4) return null
      const path = simplify([
        ...g.t.route.slice(0, a.i),
        xy(lo, a.v),
        xy(start, a.v),
        xy(start + lead, v),
        xy(end - tail, v),
        xy(end, b.v),
        xy(hi, b.v),
        ...g.t.route.slice(b.i),
      ])
      result.push({
        ...g.t,
        route: path.map((p) => ({
          ...p,
          route_type: "wire",
          layer,
          width: (g.t.route[0] as Wire).width,
        })),
      })
    }
  }
  return result
}

/** Validate proposed channels against the actual copper before accepting them. */
export function spreadHypergraphCorridors(
  input: SimpleRouteJson,
  traces: Trace[],
  pitch: number,
  stagger = 0.1,
  inset = 0.5,
  shift = 0,
): Trace[] | null {
  const result = buildHypergraphCorridorGeometry(
    input,
    traces,
    pitch,
    stagger,
    inset,
    shift,
  )
  if (!result) return null
  const copper = [...fixedCopper(input), ...result.flatMap(routeCopper)]
  if (
    result.some(
      (t) =>
        !new VectorScene(
          input,
          input.connections.find((c) => c.name === t.connection_name)!,
          (t.route[0] as Wire).width,
          copper,
        ).pathVisible(t.route),
    )
  )
    return null
  return result
}
