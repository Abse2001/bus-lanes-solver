import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { GridVisibilitySearch } from "./grid-visibility"
import { tuningPathIsSelfClear } from "./length-tuning"
import { routeCopper, VectorScene, type Copper } from "./vector-scene"
import type { Connection, SimpleRouteJson, Trace } from "./types"

/** Complete nearly routed networks with bounded displacement chains. A lane is
 * displaced only after a replacement path for the missing connection exists.
 * Fixed copper and coupled rails are never displaced. */
export function* ejectBlockingLanes(
  input: SimpleRouteJson,
  initial: Trace[],
  fixed: Copper[],
  widths: ReadonlyMap<string, number>,
  layers: ReadonlyMap<string, string[]> = new Map(),
  options: {
    maxSearches?: number
    maxDepth?: number
    requireSelfClear?: boolean
  } = {},
): Generator<void, Trace[] | null> {
  let searches = 0
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  function* route(
    connection: Connection,
    retained: Trace[],
    layer: string,
  ): Generator<void, Trace | null> {
    if (++searches > (options.maxSearches ?? 200)) return null
    const local = {
      ...connection,
      pointsToConnect: connection.pointsToConnect.map((p) => ({ ...p, layer })),
    }
    const width = widths.get(connection.name) ?? input.minTraceWidth
    const scene = new VectorScene(input, local, width, [
      ...fixed,
      ...retained.flatMap(routeCopper),
    ])
    const search = new GridVisibilitySearch(
      scene,
      local.pointsToConnect[0],
      local.pointsToConnect[1],
    )
    try {
      let steps = 0
      while (!search.solved && !search.failed && steps++ < 1000) {
        search.step()
        yield
      }
      if (!search.solved) return null
      const path = options.requireSelfClear
        ? reduceOrdinaryTurns(search.result, scene)
        : search.result
      if (
        options.requireSelfClear &&
        !tuningPathIsSelfClear(path, width + clearance)
      )
        return null
      return {
        type: "pcb_trace",
        pcb_trace_id: connection.name,
        connection_name: connection.name,
        source_trace_id: connection.source_trace_id,
        route: path.map((p) => ({ ...p, route_type: "wire", layer, width })),
      }
    } finally {
      search.cancel()
    }
  }
  function* fill(
    pending: Connection[],
    traces: Trace[],
    depth = 0,
    visited = new Set<string>(),
  ): Generator<void, Trace[] | null> {
    if (!pending.length) return traces
    if (searches >= (options.maxSearches ?? 200)) return null
    const connection = pending[0]
    const available = layers.get(connection.name) ?? [
      connection.pointsToConnect[0].layer,
    ]
    for (const layer of available) {
      const path = yield* route(connection, traces, layer)
      if (!path) continue
      const result = yield* fill(
        pending.slice(1),
        [...traces, path],
        depth,
        new Set([...visited, connection.name]),
      )
      if (result) return result
    }
    if (depth >= (options.maxDepth ?? 5)) return null
    for (const trace of traces) {
      if (
        trace.coupledSection ||
        !trace.connection_name ||
        visited.has(trace.connection_name) ||
        !available.includes((trace.route[0] as { layer: string }).layer)
      )
        continue
      const displaced = input.connections.find(
        (c) => c.name === trace.connection_name,
      )
      if (!displaced) continue
      for (const layer of available) {
        const retained = traces.filter((t) => t !== trace)
        const path = yield* route(connection, retained, layer)
        if (!path) continue
        const result = yield* fill(
          [...pending.slice(1), displaced],
          [...retained, path],
          depth + 1,
          new Set([...visited, connection.name]),
        )
        if (result) return result
      }
    }
    return null
  }
  return yield* fill(
    input.connections.filter(
      (c) => !initial.some((t) => t.connection_name === c.name),
    ),
    initial,
  )
}
