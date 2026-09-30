import { GridVisibilitySearch } from "./grid-visibility"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import { segmentDistance, length } from "./geometry"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import type { SimpleRouteJson, Connection, Trace, Wire } from "./types"

/** Rip up only generated conflicting lanes; supplied copper and coupled rails
 * remain hard obstacles. Coordinates are board-world mm (+X right, +Y up). */
export function* negotiateLanes(
  input: SimpleRouteJson,
  connections: Connection[],
  fixed: Copper[],
  paired: Trace[],
  widths: Map<string, number>,
): Generator<Trace[], Trace[] | null> {
  const queue = connections.toSorted(
    (a, b) => length(a.pointsToConnect) - length(b.pointsToConnect),
  )
  const routed = new Map<string, Trace>()
  const histories = new Map<string, Float32Array>()
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  for (let attempt = 0; queue.length && attempt < 3000; attempt++) {
    const connection = queue.shift()!,
      width = widths.get(connection.name)!
    routed.delete(connection.name)
    const scene = new VectorScene(input, connection, width, [
      ...fixed,
      ...paired.flatMap(routeCopper),
    ])
    let history = histories.get(connection.pointsToConnect[0].layer)
    const search = new GridVisibilitySearch(
      scene,
      connection.pointsToConnect[0],
      connection.pointsToConnect[1],
      [...routed.values()].flatMap(routeCopper),
      8 + attempt / 8,
      history,
    )
    history ??= new Float32Array(search.cellCount)
    histories.set(connection.pointsToConnect[0].layer, history)
    while (!search.solved && !search.failed && search.expanded < 800000) {
      search.step()
      yield [...paired, ...routed.values()]
    }
    if (!search.solved)
      throw Error(
        `Lane ${connection.name} could not route after ${search.expanded} expansions (negotiation ${attempt}, ${routed.size} lanes retained)`,
      )
    const trace: Trace = {
      type: "pcb_trace",
      pcb_trace_id: `bus_lane_${connection.name}`,
      connection_name: connection.name,
      source_trace_id: connection.source_trace_id ?? connection.name,
      route: search.result.map((p) => ({
        ...p,
        route_type: "wire",
        layer: connection.pointsToConnect[0].layer,
        width,
      })),
    }
    for (const [name, previous] of routed) {
      if (
        (previous.route[0] as Wire).layer !==
        connection.pointsToConnect[0].layer
      )
        continue
      const required =
        (width + (previous.route[0] as Wire).width) / 2 + clearance
      let collides = false
      for (let i = 1; i < trace.route.length; i++)
        for (let j = 1; j < previous.route.length; j++) {
          if (
            segmentDistance(
              [trace.route[i - 1], trace.route[i]],
              [previous.route[j - 1], previous.route[j]],
            ) >=
            required - 1e-8
          )
            continue
          collides = true
          search.penalizeIntersection(
            history,
            trace.route[i - 1],
            trace.route[i],
            previous.route[j - 1],
            previous.route[j],
            required,
          )
        }
      if (collides) {
        routed.delete(name)
        if (!queue.some((c) => c.name === name))
          queue.push(connections.find((c) => c.name === name)!)
      }
    }
    routed.set(connection.name, trace)
    yield [...paired, ...routed.values()]
  }
  if (queue.length) return null
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
