import { GridVisibilitySearch } from "./grid-visibility"
import { VectorScene, type Copper } from "./vector-scene"
import type { Connection, SimpleRouteJson, Trace } from "./types"

const certificates = new WeakMap<SimpleRouteJson, Map<string, Trace[]>>()

/** Compute provisional paths for pending terminals. These are soft search
 * preferences, never output copper or saved route guides. A later route can
 * otherwise close a narrow package exit before its neighbor is considered. */
export function* pendingLaneCertificates(
  input: SimpleRouteJson,
  connections: Connection[],
  fixed: Copper[],
  widths: ReadonlyMap<string, number>,
): Generator<void, Trace[]> {
  const key = JSON.stringify([
    input.bounds,
    input.layerCount,
    input.minTraceWidth,
    input.obstacles,
    input.traces,
    input.connections.map((c) => c.pointsToConnect),
    input.minBoardEdgeClearance,
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    fixed,
    connections.map((c) => [
      c.name,
      c.source_trace_id,
      c.pointsToConnect,
      widths.get(c.name),
    ]),
  ])
  const cache = certificates.get(input) ?? new Map<string, Trace[]>()
  certificates.set(input, cache)
  const cached = cache.get(key)
  if (cached) return structuredClone(cached)
  const result: Trace[] = []
  for (const connection of connections) {
    const width = widths.get(connection.name)!
    const search = new GridVisibilitySearch(
      new VectorScene(input, connection, width, fixed),
      connection.pointsToConnect[0],
      connection.pointsToConnect[1],
    )
    try {
      while (!search.solved && !search.failed) {
        search.step()
        yield
      }
      if (search.solved)
        result.push({
          type: "pcb_trace",
          pcb_trace_id: `certificate_${connection.name}`,
          connection_name: connection.name,
          route: search.result.map((point) => ({
            ...point,
            route_type: "wire",
            layer: connection.pointsToConnect[0].layer,
            width,
          })),
        })
    } finally {
      if (!search.solved && !search.failed) search.cancel()
    }
  }
  if (cache.size >= 8) cache.delete(cache.keys().next().value!)
  cache.set(key, structuredClone(result))
  return result
}
