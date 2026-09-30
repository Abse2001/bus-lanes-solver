import { GridVisibilitySearch } from "./grid-visibility"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { length } from "./geometry"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { tuningPathIsSelfClear } from "./length-tuning"
import type { Connection, SimpleRouteJson, Trace } from "./types"

/** Assign unconstrained signals after atomic buses. Each interconnect stays on
 * one reachable layer; only existing local terminal vias provide layer access.
 * Points use board-world mm (+X right, +Y up). Supplied copper is immutable. */
export function* routeFlexibleLanes(
  input: SimpleRouteJson,
  connections: Connection[],
  locked: Trace[],
  reachable: Map<string, string[]>,
): Generator<void, Trace[]> {
  const fixed = [...fixedCopper(input), ...locked.flatMap(routeCopper)]
  const order = connections.toSorted(
    (a, b) => length(a.pointsToConnect) - length(b.pointsToConnect),
  )
  for (let attempt = 0; attempt < 24; attempt++) {
    const routed: Trace[] = []
    let failed: Connection | undefined
    for (const connection of order) {
      let best: Trace | undefined,
        bestLength = Infinity
      const width =
        connection.nominalTraceWidth ?? connection.width ?? input.minTraceWidth
      for (const layer of reachable.get(connection.name) ?? []) {
        const candidate = {
          ...connection,
          pointsToConnect: connection.pointsToConnect.map((p) => ({
            ...p,
            layer,
          })),
        }
        const scene = new VectorScene(input, candidate, width, [
          ...fixed,
          ...routed.flatMap(routeCopper),
        ])
        const search = new GridVisibilitySearch(
          scene,
          candidate.pointsToConnect[0],
          candidate.pointsToConnect[1],
        )
        while (!search.solved && !search.failed && search.expanded < 500000) {
          search.step()
          yield
        }
        if (!search.solved) continue
        const points = reduceOrdinaryTurns(search.result, scene)
        if (!tuningPathIsSelfClear(points, width + scene.margin - width / 2))
          continue
        const distance = length(points)
        if (distance >= bestLength) continue
        bestLength = distance
        best = {
          type: "pcb_trace",
          pcb_trace_id: `bus_lane_${connection.name}`,
          connection_name: connection.name,
          source_trace_id: connection.source_trace_id ?? connection.name,
          route: points.map((p) => ({
            ...p,
            route_type: "wire",
            width,
            layer,
          })),
        }
      }
      if (!best) {
        failed = connection
        break
      }
      routed.push(best)
      yield
    }
    if (!failed) return [...locked, ...routed]
    const index = order.indexOf(failed)
    order.splice(index, 1)
    order.splice(Math.max(0, index - 1 - Math.floor(attempt / 3)), 0, failed)
  }
  throw Error("No complete fixed-layer assignment for remaining signals")
}
