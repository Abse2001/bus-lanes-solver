import { GridVisibilitySearch } from "./grid-visibility"
import { tuningPathIsSelfClear } from "./length-tuning"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Refine raster returning jogs before allocating tuning space. The finer
 * search is bounded around the existing route and checks continuous copper. */
export function* repairGridJogs(
  input: SimpleRouteJson,
  traces: Trace[],
  fixed: Copper[],
): Generator<void, boolean> {
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  for (const trace of traces) {
    const width = (trace.route[0] as Wire).width
    if (tuningPathIsSelfClear(trace.route, width + clearance)) continue
    if (trace.coupledSection) return false
    const connection = input.connections.find(
      (c) => c.name === trace.connection_name,
    )!
    const scene = new VectorScene(input, connection, width, [
      ...fixed,
      ...traces.flatMap(routeCopper),
    ])
    const margin = width * 10
    const bounds = {
      minX: Math.max(
        input.bounds.minX,
        Math.min(...trace.route.map((p) => p.x)) - margin,
      ),
      maxX: Math.min(
        input.bounds.maxX,
        Math.max(...trace.route.map((p) => p.x)) + margin,
      ),
      minY: Math.max(
        input.bounds.minY,
        Math.min(...trace.route.map((p) => p.y)) - margin,
      ),
      maxY: Math.min(
        input.bounds.maxY,
        Math.max(...trace.route.map((p) => p.y)) + margin,
      ),
    }
    let repaired = false
    for (const step of [width / 4, width / 5]) {
      for (const reverse of [false, true]) {
        const ends = reverse
          ? connection.pointsToConnect.toReversed()
          : connection.pointsToConnect
        const search = new GridVisibilitySearch(
          scene,
          ends[0],
          ends[1],
          [],
          0,
          undefined,
          { step, bounds },
        )
        try {
          while (!search.failed && !search.solved) {
            search.step()
            yield
          }
          if (!search.solved) continue
          const path = reduceOrdinaryTurns(
            reverse ? search.result.toReversed() : search.result,
            scene,
          )
          if (!tuningPathIsSelfClear(path, width + clearance)) continue
          trace.route = path.map((p) => ({
            ...p,
            route_type: "wire",
            layer: connection.pointsToConnect[0].layer,
            width,
          }))
          repaired = true
          break
        } finally {
          search.cancel()
        }
      }
      if (repaired) break
    }
    if (!repaired) return false
  }
  return true
}
