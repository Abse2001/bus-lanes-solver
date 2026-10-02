import { offsetPath } from "./coupled-pair-routing"
import { distance } from "./geometry"
import { buildHypergraphCorridorGeometry } from "./spread-hypergraph-corridors"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { tuningPathIsSelfClear } from "./length-tuning"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Allocate space to complete pair envelopes. Rebuild both rails from the same
 * centerline, leaving package approaches and their skew correction intact. */
export function spreadHypergraphCoupledCorridors(
  input: SimpleRouteJson,
  traces: Trace[],
  pitch: number,
  inset: number,
): Trace[] | null {
  const pairs = new Map<string, Trace[]>()
  const used = new Set<string>()
  const channels: Trace[] = []
  for (const trace of traces) {
    if (used.has(trace.connection_name!)) continue
    const pair = input.differentialPairs?.find((p) =>
      p.connectionNames.includes(trace.connection_name!),
    )
    const rails = pair?.connectionNames.map(
      (n) => traces.find((t) => t.connection_name === n)!,
    )
    if (!rails?.every((t) => t?.coupledSection)) {
      channels.push(trace)
      used.add(trace.connection_name!)
      continue
    }
    const paths = rails.map((t) =>
      t.route.slice(t.coupledSection![0], t.coupledSection![1] + 1),
    )
    if (paths[0].length !== paths[1].length) return null
    const width = (trace.route[0] as Wire).width
    const center: Trace = {
      ...rails[0],
      route: paths[0].map((p, i) => ({
        ...p,
        x: (p.x + paths[1][i].x) / 2,
        y: (p.y + paths[1][i].y) / 2,
        width:
          2 * width +
          (pair!.traceGap ?? input.minTraceToPadEdgeClearance ?? 0.075),
      })),
    }
    pairs.set(center.connection_name!, rails)
    channels.push(center)
    rails.forEach((t) => used.add(t.connection_name!))
  }
  const expanded = buildHypergraphCorridorGeometry(
    input,
    channels,
    pitch,
    0.1,
    inset,
    0,
  )
  if (!expanded) return null
  const result: Trace[] = []
  for (const channel of expanded) {
    const rails = pairs.get(channel.connection_name!)
    if (!rails) {
      result.push(channel)
      continue
    }
    const width = (rails[0].route[0] as Wire).width
    const spacing = (channel.route[0] as Wire).width - width
    const offsets = [spacing / 2, -spacing / 2].sort(
      (a, b) =>
        distance(
          offsetPath(channel.route, a)[0],
          rails[0].route[rails[0].coupledSection![0]],
        ) -
        distance(
          offsetPath(channel.route, b)[0],
          rails[0].route[rails[0].coupledSection![0]],
        ),
    )
    for (const [i, rail] of rails.entries()) {
      const [start, end] = rail.coupledSection!
      const path = offsetPath(channel.route, offsets[i])
      if (
        distance(path[0], rail.route[start]) > 1e-7 ||
        distance(path.at(-1)!, rail.route[end]) > 1e-7
      )
        return null
      const route = [
        ...rail.route.slice(0, start),
        ...path.map((p) => ({
          ...p,
          route_type: "wire" as const,
          layer: (rail.route[0] as Wire).layer,
          width,
        })),
        ...rail.route.slice(end + 1),
      ]
      result.push({
        ...rail,
        route,
        coupledSection: [start, start + path.length - 1],
        curvedSegments: route.slice(1).flatMap((p, i) => {
          const a = route[i],
            dx = Math.abs(p.x - a.x),
            dy = Math.abs(p.y - a.y)
          return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8
            ? [i + 1]
            : []
        }),
      })
    }
  }
  const copper = [...fixedCopper(input), ...result.flatMap(routeCopper)]
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  if (
    result.some(
      (t) =>
        !new VectorScene(
          input,
          input.connections.find((c) => c.name === t.connection_name)!,
          (t.route[0] as Wire).width,
          copper,
        ).pathVisible(t.route) ||
        !tuningPathIsSelfClear(t.route, (t.route[0] as Wire).width + clearance),
    )
  )
    return null
  return result
}
