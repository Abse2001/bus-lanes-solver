import { refineRouteCandidates } from "./refine-route-candidates"
import { routeViaWaypoint } from "./route-via-waypoint"
import { pendingLaneCertificates } from "./pending-lane-certificates"
import { RouteCandidatePool } from "./select-route-candidates"
import { routeCoupledPair } from "./coupled-pair-routing"
import { GridHistoryProjector, GridVisibilitySearch } from "./grid-visibility"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import { length } from "./geometry"
import { RouteConflictIndex } from "./route-conflict-index"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { repairLaneClosures } from "./repair-lane-closures"
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
  enableTerminalReservations: () => boolean = () => true,
  deferRetainedSelfClearance = false,
  checkReachability = false,
): Generator<Trace[], Trace[] | null> {
  const flexibleTerminals = connections.some(
    (connection) => (terminalLayers.get(connection.name)?.length ?? 1) > 1,
  )
  const routed = new Map<string, Trace>()
  const histories = new Map<string, Float32Array>()
  const searches = new Map<string, GridHistoryProjector>()
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const pairs = (input.differentialPairs ?? []).filter(
    (p) =>
      (p.traceGap !== undefined || p.maxUncoupledLength !== undefined) &&
      p.connectionNames.every((n) => connections.some((c) => c.name === n)),
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
      // Reserve one percent of the compact search envelope for length tuning.
      1.5 * 0.99 * Math.max(...members.map((c) => length(c.pointsToConnect)))
    for (const member of members) {
      limits.set(member.name, limit)
      ceilings.set(member.name, (limit * 4) / 3)
    }
  }
  const candidates = new RouteCandidatePool(clearance, 240)
  const conflicts = new RouteConflictIndex()
  const unitNames = units.map((unit) => unit.connections[0].name)
  const matchingGroups = [
    ...(input.buses ?? []).map((bus) =>
      units
        .filter((unit) =>
          unit.connections.some((c) => bus.connectionNames.includes(c.name)),
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
  ]
  const copperCache = new WeakMap<Trace, Copper[]>()
  const getCopper = (trace: Trace) => {
    let copper = copperCache.get(trace)
    if (!copper) {
      copper = routeCopper(trace)
      copperCache.set(trace, copper)
    }
    return copper
  }
  const pairedCopper = paired.flatMap(getCopper)
  const visits = new Map<string, number>()
  const queue = [...units]
  let bestCount = 0,
    lastProgress = 0,
    pairRefresh = 0,
    closureAttempts = 0,
    refinementAttempts = 0,
    lastClosureRepair = -Infinity
  routing: for (
    let iteration = 0;
    iteration < 12000 && queue.length;
    iteration++
  ) {
    const pass = Math.floor(iteration / Math.max(1, connections.length / 4))
    const congestionPenalty = 10 + pass * 4
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
          const hit = projected.some((trace) =>
            conflicts.firstConflict(
              trace.route,
              other.route,
              (widths.get(trace.connection_name!)! +
                (other.route[0] as Wire).width) /
                2 +
                clearance -
                1e-8,
            ),
          )
          if (hit) cost++
        }
        return cost
      }
      if (available.length > 1) {
        const layerCosts = new Map(
          available.map((layer) => [layer, layerCost(layer)]),
        )
        available.sort((a, b) => layerCosts.get(a)! - layerCosts.get(b)!)
      }
      const chosenLayer = available[0]
      for (const c of unit.connections)
        for (const point of c.pointsToConnect) point.layer = chosenLayer
      const width = widths.get(connection.name)!,
        layer = connection.pointsToConnect[0].layer
      routed.delete(connection.name)
      const routedLanes = [...routed.values()]
      const progressRoutes = [...paired, ...routedLanes]
      const routedCopper = routedLanes.flatMap(getCopper)
      const sceneCopper = [
        ...fixed,
        ...pairedCopper,
        ...(!unit.pair
          ? routedLanes
              .filter((t) => pairedNames.has(t.connection_name!))
              .flatMap(getCopper)
          : []),
      ]
      const scene = new VectorScene(input, connection, width, sceneCopper)
      if (unit.pair) {
        // Paired alternatives use their own coupled search. They only need
        // the shared grid coordinates for accumulated intersection history.
        const projector = new GridHistoryProjector(scene)
        if (!histories.has(layer))
          histories.set(layer, new Float32Array(projector.cellCount))
        searches.set(layer, projector)
        // Generate rigid paired alternatives independently of provisional
        // lanes; compatibility selection can then move those lanes around the
        // new corridor instead of forcing every retry back to the old topology.
        const generator = routeCoupledPair(input, unit.pair, fixed, {
          copper: [],
          penalty: 0,
          variant: visit - 1,
        })
        let step = generator.next()
        try {
          // The enclosing solver owns the work budget. Fine package searches
          // may need more steps before yielding a feasible coupled corridor.
          while (!step.done) {
            yield routedLanes
            step = generator.next()
          }
        } finally {
          if (!step.done) step = generator.return(null)
        }
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
      let pendingCopper: Copper[] = []
      let certificatePaths: Trace[] = []
      if (
        input.buses?.length &&
        iteration >= units.length * 4 &&
        enableTerminalReservations()
      ) {
        const generator = pendingLaneCertificates(
          input,
          connections.filter((c) => !pairedNames.has(c.name)),
          sceneCopper,
          widths,
        )
        let step = generator.next()
        try {
          while (!step.done) {
            yield progressRoutes
            step = generator.next()
          }
        } finally {
          if (!step.done) generator.return([])
        }
        const paths = step.value!
        certificatePaths = paths
        pendingCopper = paths
          .filter(
            (t) =>
              t.connection_name !== connection.name &&
              !routed.has(t.connection_name!),
          )
          .flatMap(getCopper)
      }
      const search = new GridVisibilitySearch(
        scene,
        connection.pointsToConnect[0],
        connection.pointsToConnect[1],
        [...routedCopper, ...pendingCopper],
        congestionPenalty,
        histories.get(layer),
        { maxLength: limits.get(connection.name), checkReachability },
      )
      if (!histories.has(layer))
        histories.set(layer, new Float32Array(search.cellCount))
      searches.set(layer, search)
      // Port of compact-bays/route-controls.ts: search every reachable signal
      // layer and compare actual routes, rather than projecting a guessed path.
      let bestChoice: { trace: Trace; score: number } | undefined
      for (const candidateLayer of available) {
        for (const point of connection.pointsToConnect)
          point.layer = candidateLayer
        const candidateScene =
          candidateLayer === layer
            ? scene
            : new VectorScene(input, connection, width, sceneCopper)
        let candidateSearch =
          candidateLayer === layer
            ? search
            : new GridVisibilitySearch(
                candidateScene,
                connection.pointsToConnect[0],
                connection.pointsToConnect[1],
                [...routedCopper, ...pendingCopper],
                congestionPenalty,
                histories.get(candidateLayer),
                { maxLength: limits.get(connection.name), checkReachability },
              )
        if (!histories.has(candidateLayer))
          histories.set(
            candidateLayer,
            new Float32Array(candidateSearch.cellCount),
          )
        searches.set(candidateLayer, candidateSearch)
        try {
          while (!candidateSearch.solved && !candidateSearch.failed) {
            candidateSearch.step()
            yield progressRoutes
          }
        } finally {
          if (!candidateSearch.solved && !candidateSearch.failed)
            candidateSearch.cancel()
        }
        if (!candidateSearch.solved && limits.has(connection.name)) {
          // A soft-cost length-constrained search can exhaust its current
          // ordering even though a hard-clear path exists. Keep that shortest
          // hard-clear alternative and negotiate the displaced lanes again.
          candidateSearch = new GridVisibilitySearch(
            candidateScene,
            connection.pointsToConnect[0],
            connection.pointsToConnect[1],
            [],
            0,
            undefined,
            { checkReachability },
          )
          try {
            while (!candidateSearch.solved && !candidateSearch.failed) {
              candidateSearch.step()
              yield progressRoutes
            }
          } finally {
            if (!candidateSearch.solved && !candidateSearch.failed)
              candidateSearch.cancel()
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
            ...input.obstacles
              .filter((o) => o.componentId)
              .flatMap((o) => [
                {
                  x: o.center.x - o.width / 2 - 0.6,
                  y: o.center.y - o.height / 2 - 0.6,
                },
                {
                  x: o.center.x + o.width / 2 + 0.6,
                  y: o.center.y + o.height / 2 + 0.6,
                },
              ]),
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
          const along = [-0.15, 0.2, 0.5, 0.8, 1.15, 0.35, 0.65, 0.1, 0.9][
            trial % 9
          ]
          let waypoint = vertical
            ? { x: cross, y: a.y + (b.y - a.y) * along }
            : { x: a.x + (b.x - a.x) * along, y: cross }
          const generator = routeViaWaypoint(
            candidateScene,
            waypoint,
            routedCopper,
            congestionPenalty,
            histories.get(candidateLayer),
            limits.get(connection.name)!,
          )
          let step = generator.next()
          try {
            while (!step.done) {
              yield progressRoutes
              step = generator.next()
            }
          } finally {
            if (!step.done) generator.return(null)
          }
          if (step.value) paths.push(step.value)
        }
        for (const path of paths) {
          let hits = 0
          for (const other of routed.values()) {
            if ((other.route[0] as Wire).layer !== candidateLayer) continue
            const hit = conflicts.firstConflict(
              path,
              other.route,
              (width + (other.route[0] as Wire).width) / 2 + clearance - 1e-8,
            )
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
      if (!bestChoice) {
        if (!certificatePaths.length) return null
        // No candidate in this visit preserves the other terminals. Keep
        // exploring new waypoint/paired alternatives instead of committing a
        // route that closes a neighbor's only exit.
        for (const trace of previous) {
          routed.set(trace.connection_name!, trace)
          const restored = unit.connections.find(
            (c) => c.name === trace.connection_name,
          )!
          for (const point of restored.pointsToConnect)
            point.layer = (trace.route[0] as Wire).layer
        }
        queue.push(unit)
        reportProgress?.(iteration + 1, connections.length - routed.size)
        yield [...paired, ...routed.values()]
        continue routing
      }
      for (const point of connection.pointsToConnect)
        point.layer = (bestChoice.trace.route[0] as Wire).layer
      candidates.add(connection.name, [bestChoice.trace])
      routed.set(connection.name, bestChoice.trace)
    }
    const selected = candidates.select(unitNames, matchingGroups)
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
        const conflict = conflicts.firstConflict(
          first.route,
          second.route,
          required - 1e-8,
        )
        if (conflict) {
          const [i, j] = conflict
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
    let missing = connections.length - routed.size
    // Fixed-layer repairs cannot explore the alternate planes of flexible
    // handoffs. Keep negotiating those layer choices instead of repeatedly
    // spending the bounded search budget on their current assignment.
    // A nearly complete bus can have a small pocket sealed by otherwise legal
    // lanes. Repair the local hard-constraint assignment instead of repeating
    // whole-board soft-cost sweeps. The parent still owns the shared budget.
    if (
      missing > 0 &&
      missing <= 3 &&
      !flexibleTerminals &&
      closureAttempts < 6 &&
      iteration >= units.length * 2 &&
      iteration - lastClosureRepair >= units.length * 4 &&
      connections.every((c) => routed.has(c.name) || !pairedNames.has(c.name))
    ) {
      closureAttempts++
      lastClosureRepair = iteration
      const generator = repairLaneClosures(
        input,
        connections,
        [...fixed, ...pairedCopper],
        [...routed.values()],
        widths,
        {
          deferRetainedSelfClearance,
          maxSubsetSize: 5,
          maxSearches: 64,
          maxSearchSteps: 6000,
          maxLengths: ceilings,
        },
      )
      let step = generator.next()
      try {
        while (!step.done) {
          yield [...paired, ...routed.values()]
          step = generator.next()
        }
      } finally {
        if (!step.done) generator.return(null)
      }
      if (step.value) {
        routed.clear()
        for (const trace of step.value)
          routed.set(trace.connection_name!, trace)
        missing = 0
      }
    }
    if (
      missing > 0 &&
      missing <= 3 &&
      !flexibleTerminals &&
      refinementAttempts < 2 &&
      iteration >=
        units.length *
          (input.buses?.length
            ? 8 + refinementAttempts * 4
            : 2 + refinementAttempts * 2) &&
      candidates.hasEveryUnit(unitNames)
    ) {
      refinementAttempts++
      const generator = refineRouteCandidates(
        input,
        [...fixed, ...pairedCopper],
        widths,
        candidates,
        unitNames,
        matchingGroups,
        terminalLayers,
      )
      let step = generator.next()
      try {
        while (!step.done) {
          yield [...paired, ...routed.values()]
          step = generator.next()
        }
      } finally {
        if (!step.done) generator.return(null)
      }
      if (step.value) {
        routed.clear()
        for (const trace of step.value) {
          routed.set(trace.connection_name!, trace)
          for (const point of connections.find(
            (c) => c.name === trace.connection_name,
          )!.pointsToConnect)
            point.layer = (trace.route[0] as Wire).layer
        }
        missing = 0
      }
    }
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
