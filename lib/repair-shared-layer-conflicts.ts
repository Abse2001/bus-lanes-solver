import { tuneSmoothLengths } from "./smooth-length-tuning"
import { GridVisibilitySearch } from "./grid-visibility"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { maximumCarrierLength } from "./route-lengths"
import { RouteConflictIndex } from "./route-conflict-index"
import { length } from "./geometry"
import { signalWidth } from "./repair-bus-dogbones"
import type { Connection, SimpleRouteJson, Trace, Wire } from "./types"

interface Node {
  routes: Trace[]
  constraints: Map<string, Trace[]>
  collisions: [number, number][]
  cost: number
  depth: number
}
/** Branch on conflicting routes rather than permanently freezing a partially
 * routed bus. Each branch reroutes one signal on either allowed carrier plane.
 * Supplied copper and pairs remain fixed; every search observes its own copper
 * length budget. Only a complete conflict-free network can be returned. */
export function* repairSharedLayerConflicts(
  input: SimpleRouteJson,
  initial: Trace[],
  layers: ReadonlyMap<string, string[]>,
  options: {
    maxNodes?: number
    lengthTargets?: ReadonlyMap<string, number>
    onProgress?: (p: {
      nodes: number
      collisions: number
      queue: number
    }) => void
  } = {},
): Generator<void, Trace[] | null> {
  const connections = input.connections,
    fixed = fixedCopper(input),
    index = new RouteConflictIndex()
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const clashes = (routes: Trace[]) => {
    const collisions: [number, number][] = []
    for (let a = 0; a < routes.length; a++)
      for (let b = 0; b < a; b++)
        if (
          (routes[a].route[0] as Wire).layer ===
            (routes[b].route[0] as Wire).layer &&
          index.firstConflict(
            routes[a].route,
            routes[b].route,
            ((routes[a].route[0] as Wire).width +
              (routes[b].route[0] as Wire).width) /
              2 +
              clearance -
              1e-8,
          )
        )
          collisions.push([a, b])
    return collisions
  }
  function* route(
    c: Connection,
    blocked: Trace[],
    others: Trace[],
  ): Generator<void, Trace[]> {
    const choices: Trace[] = []
    for (const layer of layers.get(c.name) ?? [c.pointsToConnect[0].layer]) {
      const connection = {
        ...c,
        pointsToConnect: c.pointsToConnect.map((p) => ({ ...p, layer })),
      }
      const scene = new VectorScene(input, connection, signalWidth(input, c), [
        ...fixed,
        ...blocked.flatMap(routeCopper),
      ])
      const search = new GridVisibilitySearch(
        scene,
        ...(connection.pointsToConnect as [Wire, Wire]),
        others.flatMap(routeCopper),
        10,
        undefined,
        {
          maxLength: maximumCarrierLength(input, c.name),
          paretoLength: true,
          checkReachability: true,
        },
      )
      let steps = 0
      try {
        while (!search.solved && !search.failed && steps++ < 4000) {
          search.step()
          yield
        }
        if (search.solved) {
          const trace: Trace = {
            type: "pcb_trace",
            pcb_trace_id: `bus_lane_${c.name}`,
            connection_name: c.name,
            source_trace_id: c.source_trace_id ?? c.name,
            route: search.result.map((p) => ({
              ...p,
              route_type: "wire",
              layer,
              width: signalWidth(input, c),
            })),
          }
          const target = options.lengthTargets?.get(c.name)
          if (target === undefined) choices.push(trace)
          else
            try {
              choices.push(
                tuneSmoothLengths(
                  {
                    ...input,
                    connections: [connection],
                    traces: [...(input.traces ?? []), ...blocked],
                    buses: [],
                    differentialPairs: [],
                  },
                  [trace],
                  new Map([[c.name, target]]),
                  { maxCandidates: 65536, packMeanders: true },
                )[0],
              )
            } catch {}
        }
      } finally {
        search.cancel()
      }
    }
    return choices
  }
  const routes = initial.filter((t) => {
    const c = connections.find((c) => c.name === t.connection_name)
    if (!c) return false
    const layer = (t.route[0] as Wire).layer
    const projected = {
      ...c,
      pointsToConnect: c.pointsToConnect.map((p) => ({ ...p, layer })),
    }
    return new VectorScene(
      input,
      projected,
      signalWidth(input, c),
      fixed,
    ).pathVisible(t.route)
  })
  for (const c of connections.filter(
    (c) => !routes.some((t) => t.connection_name === c.name),
  )) {
    const choices = yield* route(c, [], routes)
    if (!choices.length) return null
    choices.sort(
      (a, b) =>
        clashes([...routes, a]).length - clashes([...routes, b]).length ||
        length(a.route) - length(b.route),
    )
    routes.push(choices[0])
  }
  const create = (
    routes: Trace[],
    constraints: Map<string, Trace[]>,
    depth: number,
  ): Node => ({
    routes,
    constraints,
    depth,
    collisions: clashes(routes),
    cost: routes.reduce((sum, t) => sum + length(t.route), 0),
  })
  const queue = [create(routes, new Map(), 0)],
    seen = new Set<string>()
  let best = Infinity
  const ids = new WeakMap<Trace, number>()
  let nextId = 0
  const id = (t: Trace) => {
    if (!ids.has(t)) ids.set(t, nextId++)
    return ids.get(t)!
  }
  for (
    let nodes = 0;
    queue.length && nodes < (options.maxNodes ?? 2000);
    nodes++
  ) {
    queue.sort(
      (a, b) =>
        a.collisions.length - b.collisions.length ||
        a.depth - b.depth ||
        a.cost - b.cost,
    )
    const node = queue.shift()!
    if (!node.collisions.length) return node.routes
    if (node.collisions.length < best || nodes % 20 === 0) {
      best = Math.min(best, node.collisions.length)
      options.onProgress?.({
        nodes,
        collisions: node.collisions.length,
        queue: queue.length,
      })
    }
    // Try the most constrained conflict first, while both branch directions and
    // both carrier layers remain available to the search.
    const degree = new Map<number, number>()
    for (const pair of node.collisions)
      for (const i of pair) degree.set(i, (degree.get(i) ?? 0) + 1)
    node.collisions.sort(
      (a, b) =>
        degree.get(a[0])! +
        degree.get(a[1])! -
        (degree.get(b[0])! + degree.get(b[1])!),
    )
    const pair = node.collisions[0]
    for (const [change, block] of [pair, [pair[1], pair[0]]]) {
      const name = node.routes[change].connection_name!,
        connection = connections.find((c) => c.name === name)!
      const constraints = new Map(node.constraints)
      constraints.set(name, [
        ...(constraints.get(name) ?? []),
        node.routes[block],
      ])
      const signature = connections
        .map(
          (c) =>
            `${c.name}:${(constraints.get(c.name) ?? [])
              .map(id)
              .sort((a, b) => a - b)
              .join(",")}`,
        )
        .join(";")
      if (seen.has(signature)) continue
      seen.add(signature)
      const others = node.routes.filter((_, i) => i !== change)
      for (const choice of yield* route(
        connection,
        constraints.get(name)!,
        others,
      )) {
        const result = node.routes.map((t, i) => (i === change ? choice : t))
        queue.push(create(result, constraints, node.depth + 1))
      }
    }
    if (queue.length > 256) {
      queue.sort(
        (a, b) =>
          a.collisions.length - b.collisions.length ||
          a.depth - b.depth ||
          a.cost - b.cost,
      )
      queue.length = 256
    }
    yield
  }
  return null
}
