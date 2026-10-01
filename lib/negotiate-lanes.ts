import { routeViaWaypoint } from "./route-via-waypoint"
import { RouteCandidatePool } from "./select-route-candidates"
import { routeCoupledPair } from "./coupled-pair-routing"
import { GridVisibilitySearch } from "./grid-visibility"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import { segmentsTooClose, length } from "./geometry"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import type { SimpleRouteJson, Connection, Trace, Wire } from "./types"

/** Queue-based rip-up routing adapted from the reference's negotiate-fine.ts.
 * Supplied copper and generated paired corridors remain fixed. Runtime candidate
 * selection can combine earlier compatible alternatives; only complete,
 * nonoverlapping solutions are returned. Board-world mm. */
export function* negotiateLanes(
  input: SimpleRouteJson,
  connections: Connection[],
  fixed: Copper[],
  paired: Trace[],
  widths: Map<string, number>,
  reportProgress?: (pass: number, conflictingLanes: number) => void,
  terminalLayers: ReadonlyMap<string, string[]> = new Map(),
): Generator<Trace[], Trace[] | null> {
  const routed = new Map<string, Trace>()
  const histories = new Map<string, Float32Array>()
  const searches = new Map<string, GridVisibilitySearch>()
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const pairs = (input.differentialPairs ?? []).filter(
    (p) => p.traceGap !== undefined || p.maxUncoupledLength !== undefined,
  )
  const pairedNames = new Set(pairs.flatMap((p) => p.connectionNames))
  const units = [
    ...pairs.map((pair) => ({
      pair,
      connections: pair.connectionNames.map(
        (n) => connections.find((c) => c.name === n)!,
      ),
    })),
    ...connections
      .filter((c) => !pairedNames.has(c.name))
      .map((c) => ({ pair: undefined, connections: [c] })),
  ].sort(
    (a, b) =>
      Number(!a.pair) - Number(!b.pair) ||
      length(a.connections[0].pointsToConnect) -
        length(b.connections[0].pointsToConnect),
  )
  const limits = new Map<string, number>()
  const ceilings = new Map<string, number>()
  for (const bus of input.buses ?? []) {
    const members = connections.filter((c) =>
      bus.connectionNames.includes(c.name),
    )
    const limit =
      1.5 * Math.max(...members.map((c) => length(c.pointsToConnect)))
    for (const member of members) {
      limits.set(member.name, limit)
      ceilings.set(member.name, (limit * 4) / 3)
    }
  }
  const candidates = new RouteCandidatePool(clearance)
  const visits = new Map<string, number>()
  const queue = [...units]
  let bestCount = 0,
    lastProgress = 0,
    pairRefresh = 0
  for (let iteration = 0; iteration < 12000 && queue.length; iteration++) {
    const pass = Math.floor(iteration / Math.max(1, connections.length / 4))
    // A locked pair corridor can impose a poor topology on the entire bus.
    // Recompute one coupled alternative after a full stagnant routing sweep;
    // candidate selection keeps each pair atomic and checks it against all lanes.
    if (iteration - lastProgress >= units.length * 8) {
      // The first compact budget is a search preference, not a proof of
      // impossibility. Widen it gradually; candidate selection still minimizes
      // each bus's longest carrier before length matching.
      for (const [name, limit] of limits) {
        const ceiling = ceilings.get(name)!
        if (limit < ceiling) limits.set(name, Math.min(ceiling, limit * 1.025))
      }
      const waitingLayers = new Set(
        queue.flatMap((unit) =>
          unit.connections.map((c) => c.pointsToConnect[0].layer),
        ),
      )
      const coupled = units.filter(
        (unit) =>
          unit.pair &&
          waitingLayers.has(unit.connections[0].pointsToConnect[0].layer),
      )
      if (coupled.length) {
        const unit = coupled[pairRefresh++ % coupled.length]
        const queued = queue.indexOf(unit)
        if (queued >= 0) queue.splice(queued, 1)
        queue.unshift(unit)
      }
      lastProgress = iteration
    }
    const currentUnit = queue.shift()!
    const sweep = [currentUnit]
    for (const unit of sweep) {
      const connection = unit.connections[0]
      const visit = (visits.get(connection.name) ?? 0) + 1
      visits.set(connection.name, visit)
      const previous = unit.connections.flatMap((c) =>
        routed.has(c.name) ? [routed.get(c.name)!] : [],
      )
      for (const c of unit.connections) routed.delete(c.name)
      const available = terminalLayers
        .get(connection.name)
        ?.filter((layer) =>
          unit.connections.every((c) =>
            terminalLayers.get(c.name)?.includes(layer),
          ),
        ) ?? [connection.pointsToConnect[0].layer]
      const projected = previous.length
        ? previous
        : unit.connections.map((c) => ({
            connection_name: c.name,
            route: c.pointsToConnect,
          }))
      const layerCost = (layer: string) => {
        let cost = layer === connection.pointsToConnect[0].layer ? 0 : 0.25
        for (const other of routed.values()) {
          if ((other.route[0] as Wire).layer !== layer) continue
          let hit = false
          for (const trace of projected)
            for (let i = 1; i < trace.route.length && !hit; i++)
              for (let j = 1; j < other.route.length && !hit; j++)
                if (
                  segmentsTooClose(
                    [trace.route[i - 1], trace.route[i]],
                    [other.route[j - 1], other.route[j]],
                    (widths.get(trace.connection_name!)! +
                      (other.route[0] as Wire).width) /
                      2 +
                      clearance -
                      1e-8,
                  )
                )
                  hit = true
          if (hit) cost++
        }
        return cost
      }
      available.sort((a, b) => layerCost(a) - layerCost(b))
      const chosenLayer = available[0]
      for (const c of unit.connections)
        for (const point of c.pointsToConnect) point.layer = chosenLayer
      const width = widths.get(connection.name)!,
        layer = connection.pointsToConnect[0].layer
      routed.delete(connection.name)
      const scene = new VectorScene(input, connection, width, [
        ...fixed,
        ...paired.flatMap(routeCopper),
        ...(!unit.pair
          ? [...routed.values()]
              .filter((t) => pairedNames.has(t.connection_name!))
              .flatMap(routeCopper)
          : []),
      ])
      const search = new GridVisibilitySearch(
        scene,
        connection.pointsToConnect[0],
        connection.pointsToConnect[1],
        [...routed.values()].flatMap(routeCopper),
        10 + pass,
        histories.get(layer),
        { maxLength: limits.get(connection.name) },
      )
      if (!histories.has(layer))
        histories.set(layer, new Float32Array(search.cellCount))
      searches.set(layer, search)
      if (unit.pair) {
        // Generate rigid paired alternatives independently of provisional
        // lanes; compatibility selection can then move those lanes around the
        // new corridor instead of forcing every retry back to the old topology.
        const generator = routeCoupledPair(input, unit.pair, fixed, {
          copper: [],
          penalty: 0,
          variant: visit - 1,
        })
        let step = generator.next(),
          iterations = 0
        while (!step.done && iterations++ < 8000) {
          yield [...routed.values()]
          step = generator.next()
        }
        if (!step.done) step = generator.return(null)
        if (!step.value) {
          if (previous.length !== unit.connections.length) return null
          for (const trace of previous) {
            routed.set(trace.connection_name!, trace)
            const c = unit.connections.find(
              (c) => c.name === trace.connection_name,
            )!
            for (const point of c.pointsToConnect)
              point.layer = (trace.route[0] as Wire).layer
          }
          continue
        }
        candidates.add(connection.name, step.value)
        for (const trace of step.value)
          routed.set(trace.connection_name!, trace)
        continue
      }
      // Port of compact-bays/route-controls.ts: search every reachable signal
      // layer and compare actual routes, rather than projecting a guessed path.
      let bestChoice: { trace: Trace; score: number } | undefined
      for (const candidateLayer of available) {
        for (const point of connection.pointsToConnect)
          point.layer = candidateLayer
        const candidateScene = new VectorScene(input, connection, width, [
          ...fixed,
          ...paired.flatMap(routeCopper),
          ...[...routed.values()]
            .filter((t) => pairedNames.has(t.connection_name!))
            .flatMap(routeCopper),
        ])
        let candidateSearch =
          candidateLayer === layer
            ? search
            : new GridVisibilitySearch(
                candidateScene,
                connection.pointsToConnect[0],
                connection.pointsToConnect[1],
                [...routed.values()].flatMap(routeCopper),
                10 + pass,
                histories.get(candidateLayer),
                { maxLength: limits.get(connection.name) },
              )
        if (!histories.has(candidateLayer))
          histories.set(
            candidateLayer,
            new Float32Array(candidateSearch.cellCount),
          )
        searches.set(candidateLayer, candidateSearch)
        while (
          !candidateSearch.solved &&
          !candidateSearch.failed &&
          candidateSearch.expanded < candidateSearch.cellCount
        ) {
          candidateSearch.step()
          yield [...paired, ...routed.values()]
        }
        if (!candidateSearch.solved && limits.has(connection.name)) {
          // A soft-cost length-constrained search can exhaust its current
          // ordering even though a hard-clear path exists. Keep that shortest
          // hard-clear alternative and negotiate the displaced lanes again.
          candidateSearch = new GridVisibilitySearch(
            candidateScene,
            connection.pointsToConnect[0],
            connection.pointsToConnect[1],
          )
          while (!candidateSearch.solved && !candidateSearch.failed) {
            candidateSearch.step()
            yield [...paired, ...routed.values()]
          }
          if (
            candidateSearch.solved &&
            length(candidateSearch.result) > limits.get(connection.name)!
          ) {
            const bus = input.buses!.find((b) =>
              b.connectionNames.includes(connection.name),
            )!
            for (const name of bus.connectionNames)
              limits.set(name, length(candidateSearch.result) * 1.05)
          }
        }
        if (!candidateSearch.solved) continue
        const paths = [candidateSearch.result]
        if (visit > 1 && visit % 2 === 0 && limits.has(connection.name)) {
          const [a, b] = connection.pointsToConnect
          const vertical = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x)
          const coordinates = [
            ...connections.flatMap((c) => c.pointsToConnect),
            ...[...routed.values()]
              .filter((t) => t.coupledSection)
              .flatMap((t) => t.route),
          ].map((p) => (vertical ? p.x : p.y))
          const low = Math.min(...coordinates) - (width + clearance) * 2
          const high = Math.max(...coordinates) + (width + clearance) * 2
          // Sweep interior corridors as well as the two outside channels.
          // A coprime traversal changes both axes on each retry without a
          // board-specific waypoint list or saved routing schedule.
          const trial = Math.floor(visit / 2) - 1
          const cross = low + ((high - low) * ((trial * 5) % 9)) / 8
          const along = [0.2, 0.5, 0.8, 0.35, 0.65, 0.1, 0.9][trial % 7]
          const waypoint = vertical
            ? { x: cross, y: a.y + (b.y - a.y) * along }
            : { x: a.x + (b.x - a.x) * along, y: cross }
          const generator = routeViaWaypoint(
            candidateScene,
            waypoint,
            [...routed.values()].flatMap(routeCopper),
            10 + pass,
            histories.get(candidateLayer),
            limits.get(connection.name)!,
          )
          let step = generator.next()
          while (!step.done) {
            yield [...paired, ...routed.values()]
            step = generator.next()
          }
          if (step.value) paths.push(step.value)
        }
        for (const path of paths) {
          let hits = 0
          for (const other of routed.values()) {
            if ((other.route[0] as Wire).layer !== candidateLayer) continue
            let hit = false
            for (let i = 1; i < path.length && !hit; i++)
              for (let j = 1; j < other.route.length && !hit; j++)
                if (
                  segmentsTooClose(
                    [path[i - 1], path[i]],
                    [other.route[j - 1], other.route[j]],
                    (width + (other.route[0] as Wire).width) / 2 +
                      clearance -
                      1e-8,
                  )
                )
                  hit = true
            if (hit) hits++
          }
          const score = length(path) + hits * length(connection.pointsToConnect)
          const choice: { score: number; trace: Trace } = {
            score,
            trace: {
              type: "pcb_trace",
              pcb_trace_id: `bus_lane_${connection.name}`,
              connection_name: connection.name,
              source_trace_id: connection.source_trace_id ?? connection.name,
              route: path.map((p) => ({
                ...p,
                route_type: "wire",
                layer: candidateLayer,
                width,
              })),
            },
          }
          candidates.add(connection.name, [choice.trace])
          if (!bestChoice || score < bestChoice.score) bestChoice = choice
        }
      }
      if (!bestChoice) return null
      for (const point of connection.pointsToConnect)
        point.layer = (bestChoice.trace.route[0] as Wire).layer
      candidates.add(connection.name, [bestChoice.trace])
      routed.set(connection.name, bestChoice.trace)
    }
    const selected = candidates.select(
      units.map((unit) => unit.connections[0].name),
      [
        ...(input.buses ?? []).map((bus) =>
          units
            .filter((unit) =>
              unit.connections.some((c) =>
                bus.connectionNames.includes(c.name),
              ),
            )
            .map((unit) => unit.connections[0].name),
        ),
        ...units
          .filter(
            (unit) =>
              !unit.connections.some((c) =>
                (input.buses ?? []).some((bus) =>
                  bus.connectionNames.includes(c.name),
                ),
              ),
          )
          .map((unit) => [unit.connections[0].name]),
      ],
    )
    if (selected) {
      routed.clear()
      for (const trace of selected) {
        routed.set(trace.connection_name!, trace)
        const connection = connections.find(
          (c) => c.name === trace.connection_name,
        )!
        for (const point of connection.pointsToConnect)
          point.layer = (trace.route[0] as Wire).layer
      }
    }
    const pending = new Set<string>()
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
        conflict: for (let i = 1; i < first.route.length; i++)
          for (let j = 1; j < second.route.length; j++) {
            if (
              !segmentsTooClose(
                [first.route[i - 1], first.route[i]],
                [second.route[j - 1], second.route[j]],
                required - 1e-8,
              )
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
                required * 1.25,
                true,
              )
            break conflict
          }
      }
    // Rip up only the conflicting older units; the new route remains in place.
    // All candidates remain available for conflict-constrained selection.
    if (pending.size) {
      for (const unit of units) {
        if (
          unit === currentUnit ||
          !unit.connections.some((c) => pending.has(c.name))
        )
          continue
        for (const c of unit.connections) routed.delete(c.name)
        if (!queue.includes(unit)) queue.push(unit)
      }
    }
    if (routed.size > bestCount) {
      bestCount = routed.size
      lastProgress = iteration
    }
    const missing = connections.length - routed.size
    reportProgress?.(iteration + 1, missing)
    yield [...paired, ...routed.values()]
    if (missing) continue
    const result = [...paired, ...routed.values()]
    for (const trace of routed.values()) {
      if (trace.coupledSection) continue
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
