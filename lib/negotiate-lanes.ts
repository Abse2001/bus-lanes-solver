import { GridVisibilitySearch } from "./grid-visibility"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import { segmentDistance, length } from "./geometry"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import type { SimpleRouteJson, Connection, Trace, Wire } from "./types"

/** Negotiated congestion keeps a provisional route for every lane while
 * resolving overlaps. Supplied copper and coupled rails remain hard obstacles.
 * Only a complete, nonoverlapping solution is returned. Board-world mm. */
export function* negotiateLanes(
  input: SimpleRouteJson,
  connections: Connection[],
  fixed: Copper[],
  paired: Trace[],
  widths: Map<string, number>,
): Generator<Trace[], Trace[] | null> {
  const routed = new Map<string, Trace>()
  const histories = new Map<string, Float32Array>()
  const searches = new Map<string, GridVisibilitySearch>()
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  let pending = new Set(connections.map((c) => c.name))
  const order = connections.toSorted(
    (a, b) => length(a.pointsToConnect) - length(b.pointsToConnect),
  )
  for (let pass = 0; pass < 100; pass++) {
    const sweep = pass % 2 ? order.toReversed() : order
    for (const connection of sweep) {
      if (!pending.has(connection.name)) continue
      const width = widths.get(connection.name)!,
        layer = connection.pointsToConnect[0].layer
      routed.delete(connection.name)
      const scene = new VectorScene(input, connection, width, [
        ...fixed,
        ...paired.flatMap(routeCopper),
      ])
      const search = new GridVisibilitySearch(
        scene,
        connection.pointsToConnect[0],
        connection.pointsToConnect[1],
        [...routed.values()].flatMap(routeCopper),
        4 + pass,
        histories.get(layer),
      )
      if (!histories.has(layer))
        histories.set(layer, new Float32Array(search.cellCount))
      searches.set(layer, search)
      while (!search.solved && !search.failed && search.expanded < 800000) {
        search.step()
        yield [...paired, ...routed.values()]
      }
      if (!search.solved) return null
      routed.set(connection.name, {
        type: "pcb_trace",
        pcb_trace_id: `bus_lane_${connection.name}`,
        connection_name: connection.name,
        source_trace_id: connection.source_trace_id ?? connection.name,
        route: search.result.map((p) => ({
          ...p,
          route_type: "wire",
          layer,
          width,
        })),
      })
    }
    pending = new Set()
    const lanes = [...routed.values()]
    for (let a = 0; a < lanes.length; a++)
      for (let b = 0; b < a; b++) {
        const first = lanes[a],
          second = lanes[b]
        const layer = (first.route[0] as Wire).layer
        if (layer !== (second.route[0] as Wire).layer) continue
        const required =
          ((first.route[0] as Wire).width + (second.route[0] as Wire).width) /
            2 +
          clearance
        for (let i = 1; i < first.route.length; i++)
          for (let j = 1; j < second.route.length; j++) {
            if (
              segmentDistance(
                [first.route[i - 1], first.route[i]],
                [second.route[j - 1], second.route[j]],
              ) >=
              required - 1e-8
            )
              continue
            pending.add(first.connection_name!)
            pending.add(second.connection_name!)
            searches
              .get(layer)!
              .penalizeIntersection(
                histories.get(layer)!,
                first.route[i - 1],
                first.route[i],
                second.route[j - 1],
                second.route[j],
                required,
              )
          }
      }
    yield [...paired, ...routed.values()]
    if (pending.size) continue
    const result = [...paired, ...routed.values()]
    for (const trace of routed.values()) {
      const connection = connections.find(
          (c) => c.name === trace.connection_name,
        )!,
        width = widths.get(connection.name)!
      const scene = new VectorScene(input, connection, width, [
        ...fixed,
        ...result.flatMap(routeCopper),
      ])
      trace.route = reduceOrdinaryTurns(trace.route, scene).map((p) => ({
        ...p,
        route_type: "wire",
        layer: connection.pointsToConnect[0].layer,
        width,
      }))
    }
    return result
  }
  return null
}
