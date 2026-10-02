import { distance, length } from "./geometry"
import { GridVisibilitySearch } from "./grid-visibility"
import { tuningPathIsSelfClear } from "./length-tuning"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { RouteCandidatePool } from "./select-route-candidates"
import { routeViaWaypoint } from "./route-via-waypoint"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import type { Connection, Point, SimpleRouteJson, Trace, Wire } from "./types"

export interface RepairLaneClosuresOptions {
  /** Defer existing raster hooks only when the caller guarantees final cleanup. */
  deferRetainedSelfClearance?: boolean
  maxSubsetSize?: number
  maxSearches?: number
  maxSearchSteps?: number
  maxSearchStepsPerAttempt?: number
  maxCandidatesPerLane?: number
  maxConditionalPasses?: number
  maxLengths?: ReadonlyMap<string, number>
  onProgress?: (progress: {
    searches: number
    searchSteps: number
    subset: string[]
    candidates: number
  }) => void
}

function* permutations(names: string[]): Generator<string[]> {
  if (!names.length) yield []
  else
    for (let i = 0; i < names.length; i++)
      for (const rest of permutations(names.filter((_, j) => i !== j)))
        yield [names[i], ...rest]
}

/** A bounded prefix of lexicographic permutations always starts with the same
 * lane. Rotate each order first so a five-lane repair explores every anchor. */
export function* repairOrders(names: string[]): Generator<string[]> {
  if (names.length <= 4) {
    yield* permutations(names)
    return
  }
  const seen = new Set<string>()
  for (const order of permutations(names))
    for (let start = 0; start < order.length; start++) {
      const rotated = [...order.slice(start), ...order.slice(0, start)]
      const key = JSON.stringify(rotated)
      if (seen.has(key)) continue
      seen.add(key)
      yield rotated
      if (seen.size === 24) return
    }
}

interface RepairBudget {
  searches: number
  searchSteps: number
  candidates: number
}

/** Repair a small ordinary-lane closure before length matching. Removing one
 * existing route supplies a reachability witness; conditional hard searches
 * then generate fresh corridor alternatives. Paired copper remains indivisible
 * and fixed. No supplied route is accepted without continuous clearance. */
export function* repairLaneClosures(
  input: SimpleRouteJson,
  connections: Connection[],
  fixed: Copper[],
  current: Trace[],
  widths: ReadonlyMap<string, number>,
  options: RepairLaneClosuresOptions = {},
): Generator<void, Trace[] | null> {
  const byName = new Map(connections.map((c) => [c.name, c]))
  const width = (name: string) =>
    widths.get(name) ??
    byName.get(name)?.width ??
    byName.get(name)?.nominalTraceWidth ??
    input.minTraceWidth
  const valid = (trace: Trace) => {
    const c = byName.get(trace.connection_name ?? "")
    return (
      !!c &&
      c.pointsToConnect.length === 2 &&
      trace.route.length >= 2 &&
      trace.route.every(
        (p) =>
          p.route_type === "wire" &&
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          p.layer === c.pointsToConnect[0].layer &&
          Number.isFinite(p.width) &&
          p.width > 0 &&
          Math.abs(p.width - width(c.name)) < 1e-12,
      ) &&
      distance(trace.route[0], c.pointsToConnect[0]) <= 1e-8 &&
      distance(trace.route.at(-1)!, c.pointsToConnect[1]) <= 1e-8
    )
  }
  if (current.some((t) => !valid(t))) return null
  const paired = new Set(
    (input.differentialPairs ?? []).flatMap((p) => p.connectionNames),
  )
  const missing = connections.filter(
    (c) => !current.some((t) => t.connection_name === c.name),
  )
  if (
    !missing.length ||
    missing.some(
      (c) =>
        paired.has(c.name) ||
        c.pointsToConnect.length !== 2 ||
        c.pointsToConnect[0].layer !== c.pointsToConnect[1].layer,
    )
  )
    return null
  const groups = new Map<string, Connection[]>()
  for (const c of missing) {
    const layer = c.pointsToConnect[0].layer
    const group = groups.get(layer) ?? []
    group.push(c)
    groups.set(layer, group)
  }
  if ([...groups.values()].some((group) => group.length > 2)) return null
  let working = current.slice()
  // Preserve existing corridors until the whole layer is connected. A shortcut
  // can close an unrouted terminal even when it clears committed copper.
  const budget: RepairBudget = { searches: 0, searchSteps: 0, candidates: 0 }
  for (const layer of groups.keys()) {
    const group = connections.filter(
      (c) => c.pointsToConnect[0].layer === layer,
    )
    const names = new Set(group.map((c) => c.name))
    const other = working.filter((t) => !names.has(t.connection_name!))
    const repaired = yield* repairLayer(
      input,
      group,
      [...fixed, ...other.flatMap(routeCopper)],
      working.filter((t) => names.has(t.connection_name!)),
      widths,
      options,
      budget,
    )
    if (!repaired) return null
    working = [...other, ...repaired]
  }
  if (
    working.length !== connections.length ||
    new Set(working.map((t) => t.connection_name)).size !== connections.length
  )
    return null
  for (const trace of working) {
    if (!valid(trace)) return null
    const c = byName.get(trace.connection_name!)!
    const scene = new VectorScene(input, c, width(c.name), [
      ...fixed,
      ...working.filter((t) => t !== trace).flatMap(routeCopper),
    ])
    if (
      !scene.pathVisible(trace.route) ||
      (!(
        options.deferRetainedSelfClearance &&
        current.some((t) => t.route === trace.route)
      ) &&
        !tuningPathIsSelfClear(
          trace.route,
          width(c.name) +
            (input.minTraceToPadEdgeClearance ??
              input.defaultObstacleMargin ??
              0.075),
        ))
    )
      return null
  }
  return working
}

function* repairLayer(
  input: SimpleRouteJson,
  connections: Connection[],
  fixed: Copper[],
  current: Trace[],
  widths: ReadonlyMap<string, number>,
  options: RepairLaneClosuresOptions,
  budget: RepairBudget,
): Generator<void, Trace[] | null> {
  const maxSubset = Math.min(5, options.maxSubsetSize ?? 4)
  const maxSearches = options.maxSearches ?? 1200
  const maxSteps = options.maxSearchSteps ?? 180000
  const domainLimit = options.maxCandidatesPerLane ?? 80
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const byName = new Map(connections.map((c) => [c.name, c]))
  const pairedNames = new Set(
    (input.differentialPairs ?? []).flatMap((p) => p.connectionNames),
  )
  const ordinary = (c: Connection) =>
    !pairedNames.has(c.name) &&
    c.pointsToConnect.length === 2 &&
    c.pointsToConnect[0].layer === c.pointsToConnect[1].layer
  const width = (name: string) =>
    widths.get(name) ??
    byName.get(name)?.width ??
    byName.get(name)?.nominalTraceWidth ??
    input.minTraceWidth
  const validCarrier = (trace: Trace) => {
    const c = byName.get(trace.connection_name ?? "")
    return (
      !!c &&
      c.pointsToConnect.length === 2 &&
      trace.route.length >= 2 &&
      trace.route.every(
        (p) =>
          p.route_type === "wire" &&
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          p.layer === c.pointsToConnect[0].layer &&
          Number.isFinite(p.width) &&
          p.width > 0 &&
          Math.abs(p.width - width(c.name)) < 1e-12,
      ) &&
      distance(trace.route[0], c.pointsToConnect[0]) <= 1e-8 &&
      distance(trace.route.at(-1)!, c.pointsToConnect[1]) <= 1e-8
    )
  }
  if (current.some((trace) => !validCarrier(trace))) return null
  const existingNames = new Set(current.map((t) => t.connection_name))
  const missing = connections.filter((c) => !existingNames.has(c.name))
  if (
    !missing.length ||
    missing.length > 2 ||
    missing.length > maxSubset ||
    missing.some((c) => !ordinary(c))
  )
    return null

  const copperCache = new WeakMap<Trace, Copper[]>()
  const copper = (t: Trace) => {
    let result = copperCache.get(t)
    if (!result) {
      result = routeCopper(t)
      copperCache.set(t, result)
    }
    return result
  }
  const makeTrace = (name: string, path: Point[]): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `lane_closure_repair_${name}`,
    connection_name: name,
    source_trace_id: byName.get(name)!.source_trace_id,
    route: path.map((p) => ({
      ...p,
      route_type: "wire",
      layer: byName.get(name)!.pointsToConnect[0].layer,
      width: width(name),
    })),
  })
  const replaceable = (trace: Trace) => {
    const c = byName.get(trace.connection_name ?? "")
    return (
      !!c &&
      ordinary(c) &&
      !trace.coupledSection &&
      !trace.curvedSegments?.length &&
      trace.route.every((p) => p.route_type === "wire")
    )
  }
  const normalized = current
  const subset = missing.map((c) => c.name)
  let additions = 0
  const exhausted = () =>
    budget.searches >= maxSearches || budget.searchSteps >= maxSteps
  const report = () =>
    options.onProgress?.({
      searches: budget.searches,
      searchSteps: budget.searchSteps,
      subset: [...subset],
      candidates: budget.candidates,
    })
  const globalLengthLimit =
    2 *
    Math.max(
      ...connections.map((c) =>
        distance(c.pointsToConnect[0], c.pointsToConnect[1]),
      ),
    )
  // Conditional assignments often repeat exactly the same hard scene. This
  // cache lives only for this repair request and never supplies saved geometry.
  const searchResults = new Map<string, Trace | null>()
  function* search(
    name: string,
    hard: Trace[],
    reverse = false,
  ): Generator<void, Trace | null> {
    if (exhausted()) return null
    const key = JSON.stringify([
      name,
      reverse,
      byName.get(name)!.pointsToConnect,
      width(name),
      hard.map((t) => [t.connection_name, t.route]),
    ])
    if (searchResults.has(key)) return searchResults.get(key)!
    const remember = (result: Trace | null) => {
      if (searchResults.size >= 256)
        searchResults.delete(searchResults.keys().next().value!)
      searchResults.set(key, result)
      return result
    }
    budget.searches++
    report()
    const connection = byName.get(name)!
    const scene = new VectorScene(input, connection, width(name), [
      ...fixed,
      ...hard.flatMap(copper),
    ])
    const solver = new GridVisibilitySearch(
      scene,
      connection.pointsToConnect[reverse ? 1 : 0],
      connection.pointsToConnect[reverse ? 0 : 1],
      [],
      0,
      undefined,
      { maxLength: options.maxLengths?.get(name) ?? globalLengthLimit },
    )
    let attemptSteps = 0
    try {
      while (
        attemptSteps < (options.maxSearchStepsPerAttempt ?? 500) &&
        !solver.solved &&
        !solver.failed &&
        budget.searchSteps < maxSteps
      ) {
        solver.step()
        attemptSteps++
        budget.searchSteps++
        yield
      }
      if (!solver.solved) return remember(null)
      const raw = reverse ? solver.result.toReversed() : solver.result
      const path = reduceOrdinaryTurns(raw, scene)
      if (
        !scene.pathVisible(path) ||
        !tuningPathIsSelfClear(path, width(name) + clearance)
      )
        return remember(null)
      return remember(makeTrace(name, path))
    } finally {
      solver.cancel()
      report()
    }
  }
  const initialWitnesses = new Map<string, Trace[]>()
  const witnesses = new Map<string, number>()
  for (const c of missing) {
    const direct = yield* search(c.name, normalized)
    if (direct) initialWitnesses.set(c.name, [direct])
    else
      for (const trace of normalized) {
        if (
          !replaceable(trace) ||
          (trace.route[0] as Wire).layer !== c.pointsToConnect[0].layer
        )
          continue
        const opened = yield* search(
          c.name,
          normalized.filter((t) => t !== trace),
        )
        if (!opened) continue
        witnesses.set(
          trace.connection_name!,
          (witnesses.get(trace.connection_name!) ?? 0) + 1,
        )
        initialWitnesses.set(c.name, [
          ...(initialWitnesses.get(c.name) ?? []),
          opened,
        ])
      }
  }
  function* combinations<T>(
    items: T[],
    count: number,
    start = 0,
    prefix: T[] = [],
  ): Generator<T[]> {
    if (!count) {
      yield prefix
      return
    }
    for (let i = start; i <= items.length - count; i++)
      yield* combinations(items, count - 1, i + 1, [...prefix, items[i]])
  }
  for (const connection of missing) {
    if (initialWitnesses.has(connection.name)) continue
    const donors = normalized.filter(
      (t) =>
        replaceable(t) &&
        (t.route[0] as Wire).layer === connection.pointsToConnect[0].layer,
    )
    let found = false
    for (let count = 2; count <= maxSubset - missing.length && !found; count++)
      for (const removed of combinations(donors, count)) {
        if (exhausted()) break
        const opened = yield* search(
          connection.name,
          normalized.filter((t) => !removed.includes(t)),
        )
        if (!opened) continue
        for (const trace of removed)
          witnesses.set(
            trace.connection_name!,
            (witnesses.get(trace.connection_name!) ?? 0) + 1,
          )
        initialWitnesses.set(connection.name, [opened])
        found = true
        break
      }
  }
  for (const [name] of [...witnesses].sort((a, b) => b[1] - a[1])) {
    // Preserve the cheap four-lane attempt even when a fifth witness exists.
    // The fifth lane is withdrawn only if conditional repair actually fails.
    if (subset.length >= Math.min(4, maxSubset)) break
    subset.push(name)
  }
  if (exhausted()) return null

  // Expand only after the current finite-domain repair fails. A shortest
  // anchor can close a neighbor even when another candidate solves the same
  // smaller subset; eagerly withdrawing that neighbor wastes bounded work.
  function* expandSubset(): Generator<void, string | null> {
    const remaining = normalized.filter(
      (t) => !subset.includes(t.connection_name!),
    )
    const scores = new Map<string, Set<string>>()
    for (const anchor of missing.map((c) => c.name)) {
      const baseline = yield* search(anchor, remaining)
      if (!baseline) continue
      for (const target of subset.filter((n) => n !== anchor)) {
        if (yield* search(target, [...remaining, baseline])) continue
        for (const trace of remaining) {
          if (
            !replaceable(trace) ||
            (trace.route[0] as Wire).layer !==
              byName.get(target)!.pointsToConnect[0].layer
          )
            continue
          if (
            !(yield* search(target, [
              ...remaining.filter((t) => t !== trace),
              baseline,
            ]))
          )
            continue
          const targets =
            scores.get(trace.connection_name!) ?? new Set<string>()
          targets.add(target)
          scores.set(trace.connection_name!, targets)
        }
      }
    }
    const witness = [...scores].sort((a, b) => b[1].size - a[1].size)[0]?.[0]
    if (witness) return witness
    // Several lanes can jointly close a corridor without any single-removal
    // witness. Withdraw a blocker of a freshly computed relaxed path next.
    for (const anchor of missing) {
      const relaxed = yield* search(
        anchor.name,
        normalized.filter((t) => !replaceable(t)),
      )
      if (!relaxed) continue
      const blocker = remaining.find(
        (trace) =>
          replaceable(trace) &&
          !new VectorScene(input, anchor, width(anchor.name), [
            ...fixed,
            ...copper(trace),
          ]).pathVisible(relaxed.route),
      )
      if (blocker) return blocker.connection_name!
    }
    return null
  }
  const seeds = [...normalized, ...[...initialWitnesses.values()].flat()]
  for (;;) {
    const remaining = normalized.filter(
      (t) => !subset.includes(t.connection_name!),
    )
    const hardBase = [...fixed, ...remaining.flatMap(copper)]
    const pool = new RouteCandidatePool(clearance, domainLimit)
    const candidateMap = new Map<string, Trace[]>()
    const signatures = new Map<string, Set<string>>()
    const add = (trace: Trace) => {
      const name = trace.connection_name!
      if (!validCarrier(trace)) return false
      const scene = new VectorScene(
        input,
        byName.get(name)!,
        width(name),
        hardBase,
      )
      if (
        !scene.pathVisible(trace.route) ||
        (!(
          options.deferRetainedSelfClearance &&
          current.some((t) => t.route === trace.route)
        ) &&
          !tuningPathIsSelfClear(trace.route, width(name) + clearance))
      )
        return false
      const key = JSON.stringify(trace.route),
        seen = signatures.get(name) ?? new Set<string>()
      if (seen.has(key)) return false
      const domain = candidateMap.get(name) ?? []
      domain.push(trace)
      seen.add(key)
      if (domain.length > domainLimit)
        seen.delete(JSON.stringify(domain.shift()!.route))
      candidateMap.set(name, domain)
      signatures.set(name, seen)
      pool.add(name, [trace])
      additions++
      budget.candidates++
      return true
    }
    const complete = (): Trace[] | null => {
      const selected = pool.select(subset, [subset])
      if (!selected) return null
      const all = [...remaining, ...selected]
      if (
        all.length !== connections.length ||
        new Set(all.map((t) => t.connection_name)).size !== connections.length
      )
        return null
      for (const trace of all) {
        const c = byName.get(trace.connection_name!)
        if (!c || !validCarrier(trace)) return null
        const scene = new VectorScene(input, c, width(c.name), [
          ...fixed,
          ...all.filter((t) => t !== trace).flatMap(copper),
        ])
        if (
          !scene.pathVisible(trace.route) ||
          (!(
            options.deferRetainedSelfClearance &&
            current.some((t) => t.route === trace.route)
          ) &&
            !tuningPathIsSelfClear(trace.route, width(c.name) + clearance))
        )
          return null
      }
      return all
    }
    for (const trace of seeds)
      if (subset.includes(trace.connection_name!)) add(trace)
    for (const name of subset) {
      const baseline = yield* search(name, remaining)
      if (baseline) add(baseline)
    }
    let selected = complete()
    if (selected) return selected
    for (const order of repairOrders(subset)) {
      const prefix: Trace[] = []
      for (const name of order) {
        const trace = yield* search(name, [...remaining, ...prefix])
        if (!trace) break
        prefix.push(trace)
        add(trace)
        selected = complete()
        if (selected) return selected
      }
      if (exhausted()) return null
    }
    const domainFor = (name: string, limit: number) => {
      const domain = candidateMap.get(name) ?? []
      const shortest = [...domain].sort(
        (a, b) => length(a.route) - length(b.route),
      )
      // Keep both compact and newly computed topologies in bounded lookahead.
      // Sorting exclusively by length can hide every new waypoint candidate.
      return domain.length <= limit
        ? shortest
        : [
            ...new Set([
              domain[0],
              ...shortest.slice(0, limit / 2 - 1),
              ...domain.slice(-limit / 2),
            ]),
          ]
    }
    function* conditionals(
      cheap = false,
      jointOnly = false,
    ): Generator<void, Trace[] | null> {
      const limit = cheap ? Math.min(8, domainLimit) : domainLimit
      for (
        let pass = 0;
        pass <
        (jointOnly ? 0 : cheap ? 1 : (options.maxConditionalPasses ?? 4));
        pass++
      ) {
        const before = additions
        const snapshot = new Map(
          subset.map((name) => [name, domainFor(name, limit)]),
        )
        for (const pending of subset)
          for (const remote of subset.filter((n) => n !== pending))
            for (const partner of snapshot.get(remote)!) {
              const trace = yield* search(pending, [...remaining, partner])
              if (trace) add(trace)
              const result = complete()
              if (result) return result
              if (exhausted()) return null
            }
        if (additions === before) break
      }
      // Hold a compatible assignment of the other two to four lanes hard, then
      // compute the missing conditional path. This produces alternatives that
      // cannot be generated by single-partner occupancy costs alone.
      for (const pending of subset) {
        const remotes = subset.filter((name) => name !== pending)
        const snapshot = new Map(
          remotes.map((name) => [name, domainFor(name, limit)]),
        )
        for (const forced of remotes)
          for (const option of snapshot.get(forced)!) {
            const conditional = new RouteCandidatePool(clearance, domainLimit)
            for (const remote of remotes)
              for (const candidate of remote === forced
                ? [option]
                : snapshot.get(remote)!)
                conditional.add(remote, [candidate])
            const partners = conditional.select(remotes, [remotes])
            if (!partners) continue
            const trace = yield* search(pending, [...remaining, ...partners])
            if (trace) add(trace)
            const result = complete()
            if (result) return result
            if (exhausted()) return null
          }
      }
      return null
    }
    selected = yield* conditionals(true)
    if (selected || exhausted()) return selected
    if (subset.length < maxSubset) {
      const next = yield* expandSubset()
      if (exhausted()) return null
      if (next) {
        seeds.push(...[...candidateMap.values()].flat())
        subset.push(next)
        continue
      }
    }
    // Seed a different homotopy only after the cheaper hard conditionals fail.
    // Channels derive from terminals and physical pad fields, never net names.
    const points = connections.flatMap((c) => c.pointsToConnect)
    const halo = (width(missing[0].name) + clearance) * 2
    const pads = input.obstacles.filter((o) => o.componentId)
    let seededAt = additions
    for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9])
      for (let channelIndex = 0; channelIndex < 11; channelIndex++)
        for (const name of subset) {
          if (exhausted()) return null
          budget.searches++
          const c = byName.get(name)!,
            [start, end] = c.pointsToConnect
          const localVertical =
            Math.abs(end.y - start.y) >= Math.abs(end.x - start.x)
          const localCross = (point: Point) =>
            localVertical ? point.x : point.y
          const localLow = Math.min(...points.map(localCross)) - halo
          const localHigh = Math.max(...points.map(localCross)) + halo
          const localChannels = Array.from(
            { length: 9 },
            (_, i) => localLow + ((localHigh - localLow) * i) / 8,
          )
          if (pads.length)
            localChannels.push(
              Math.min(
                ...pads.map(
                  (p) =>
                    localCross(p.center) -
                    (localVertical ? p.width : p.height) / 2,
                ),
              ) - halo,
              Math.max(
                ...pads.map(
                  (p) =>
                    localCross(p.center) +
                    (localVertical ? p.width : p.height) / 2,
                ),
              ) + halo,
            )
          const channel = localChannels[channelIndex % localChannels.length]
          const waypoint = localVertical
            ? { x: channel, y: start.y + (end.y - start.y) * fraction }
            : { x: start.x + (end.x - start.x) * fraction, y: channel }
          const scene = new VectorScene(input, c, width(name), hardBase)
          const generator = routeViaWaypoint(
            scene,
            waypoint,
            [],
            0,
            undefined,
            options.maxLengths?.get(name) ?? globalLengthLimit,
          )
          let next = generator.next()
          try {
            while (!next.done && budget.searchSteps < maxSteps) {
              budget.searchSteps++
              yield
              next = generator.next()
            }
          } finally {
            if (!next.done) generator.return(null)
          }
          if (next.done && next.value) add(makeTrace(name, next.value))
          selected = complete()
          if (selected) return selected
          if (additions - seededAt >= 12) {
            selected = yield* conditionals(true, true)
            if (selected || exhausted()) return selected
            seededAt = additions
          }
        }
    return yield* conditionals()
  }
}
