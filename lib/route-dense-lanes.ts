import { GridVisibilitySearch } from "./grid-visibility"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { windingOrders } from "./winding-orders"
import type { SimpleRouteJson, Connection, Trace } from "./types"

/** Independent planar layers use bounded deterministic order backtracking.
 * Committed layers and supplied copper never move. Board-world coordinates in mm. */
export function* routeDenseLanes(
  input: SimpleRouteJson,
  connections: Connection[],
  fixed: Copper[],
  paired: Trace[],
  widths: Map<string, number>,
): Generator<Trace[], Trace[] | null> {
  const committed = [...paired]
  for (const layer of [
    ...new Set(connections.map((c) => c.pointsToConnect[0].layer)),
  ]) {
    const members = connections.filter(
      (c) => c.pointsToConnect[0].layer === layer,
    )
    const orders = windingOrders(members)
    let order = orders[0],
      accepted = false
    let seed = 12345
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let attempt = 0; attempt < 240; attempt++) {
      const routed: Trace[] = []
      let failed: Connection | undefined
      for (const c of order) {
        const width = widths.get(c.name)!,
          scene = new VectorScene(input, c, width, [
            ...fixed,
            ...committed.flatMap(routeCopper),
            ...routed.flatMap(routeCopper),
          ])
        const search = new GridVisibilitySearch(
          scene,
          c.pointsToConnect[0],
          c.pointsToConnect[1],
        )
        while (!search.solved && !search.failed && search.expanded < 500000) {
          search.step()
          yield [...committed, ...routed]
        }
        if (!search.solved) {
          failed = c
          break
        }
        routed.push({
          type: "pcb_trace",
          pcb_trace_id: `bus_lane_${c.name}`,
          connection_name: c.name,
          source_trace_id: c.source_trace_id ?? c.name,
          route: reduceOrdinaryTurns(search.result, scene).map((p) => ({
            ...p,
            route_type: "wire",
            layer,
            width,
          })),
        })
      }
      if (!failed) {
        committed.push(...routed)
        accepted = true
        break
      }
      const index = order.indexOf(failed)
      order = [...order]
      order.splice(index, 1)
      order.splice(Math.max(0, index - 1 - Math.floor(attempt / 8)), 0, failed)
      if (attempt % 12 === 11) {
        order = [...orders[Math.floor(attempt / 12) % orders.length]]
        if (attempt % 24 === 23)
          for (let j = order.length - 1; j > 0; j--) {
            const k = Math.floor(random() * (j + 1))
            ;[order[j], order[k]] = [order[k], order[j]]
          }
      }
    }
    if (!accepted) return null
  }
  return committed
}
