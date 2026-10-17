import { CopperConflictIndex } from "./copper-conflict-index"
import { criticalSurfaceGridOrigins } from "./critical-surface-grid-origins"
import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import type { FlexibleSignalState } from "./flexible-signal-state"
import { GridHistoryProjector } from "./grid-visibility"
import { VectorScene } from "./vector-scene"
import { distance, segmentDistance } from "./geometry"
import { joinSignalEscapes } from "./join-signal-escapes"
import { minimizeSignalCandidateConflicts } from "./minimize-signal-candidate-conflicts"
import { improveSignalCandidateConflicts } from "./improve-signal-candidate-conflicts"
import { rankSignalConflictPairs } from "./select-signal-conflict-pair"
import {
  routeSurfaceBridge,
  surfaceBridgeEligible,
  type SurfaceBridgeOptions,
  type SurfaceBridgeRoute,
} from "./route-surface-bridge"
import { routeSurfaceViaAttachments } from "./route-surface-via-attachments"
import { solveSignalCandidatePool } from "./solve-signal-candidate-pool"
import type { Connection, SimpleRouteJson, Trace, Wire } from "./types"
import { fixedCopper, type Copper } from "./vector-scene"

export interface SurfaceNegotiationOptions {
  onProgress?: (progress: SurfaceNegotiationProgress) => void
  /** Diagnostic-only complete assignments may still contain physical
   * conflicts. They are not accepted routing output or benchmark fixtures. */
  onProvisionalCheckpoint?: (
    state: FlexibleSignalState,
    conflictCount: number,
  ) => void
  onCandidatePoolGraph?: (graph: SurfaceCandidatePoolGraph) => void
  /** Search envelope policy only; original board bounds and outline remain hard. */
  minimumSearchPadding?: number
  surfaceGridStep?: number
  nonPreferredLayerCost?: number
  /** Retain the board lattice first, then try bounded phases for a failed
   * search through narrow channels in hard copper. */
  criticalGridOrigins?: boolean
  /** Supplement whole-pad paths with independently placed native via sites;
   * the two endpoint barrels and body transitions still total at most four. */
  endpointViaAttachments?: boolean
  /** Retain the cost of previously contested corridors across reroutes. */
  congestionHistory?: boolean
  /** Weighted A* is a candidate-search heuristic; hard physical and length
   * validation remains unchanged. One retains the shortest-path heuristic. */
  heuristicWeight?: number
  /** Generate domain alternatives against one temporarily hard ordinary
   * neighbor, while all supplied and paired copper remains hard throughout. */
  hardNeighborRouting?: boolean
  maxHardNeighbors?: number
  /** When an exploratory route hits a currently clear signal, generate its
   * replacement against that proposal before minimizing the candidate pool. */
  rerouteNearbyClearSignals?: boolean
  maxRounds?: number
  maxExpansions?: number
  /** First candidates can use a cheaper provisional soft-copper search;
   * later reroutes retain the full negotiated expansion budget. */
  maxInitialSoftExpansions?: number
  maxInitialExpansions?: number
  maxClosureExpansions?: number
  maxDomainCandidates?: number
  maxCandidateSearchNodes?: number
  maxSupportChecks?: number
  maxClosureSize?: number
  maxClosureNeighbors?: number
  maxClosureFragments?: number
  maxUntimedVias?: number
  /** Timing checks include every owned approach; permit additional surface
   * transitions when a bus lane cannot fit through a single carrier segment. */
  maxTimedVias?: 2 | 4
  frozenConnectionNames?: ReadonlySet<string>
}

export interface SurfaceNegotiationProgress {
  stage: "initial" | "negotiate" | "closure" | "complete"
  connectionName: string
  hardNeighbor?: string
  hardNeighbors?: string[]
  routedSignals: number
  requestedSignals: number
  candidates: number
  mutuallyClearSignals: number
  conflicts: number
  round: number
}

export interface SurfaceCandidatePoolGraph {
  routingAccepted: false
  conflicts: number
  connectionNames: string[]
  domains: number[][]
  current: number[]
  incompatiblePairs: Array<[number, number]>
}

interface Candidate extends SurfaceBridgeRoute {
  id: number
  joined: Trace
  copper: Copper[]
}

/** Negotiate complete owned surface approaches and carriers together. Supplied
 * copper and every paired rail stay hard; only ordinary signals enter the
 * candidate pool. A result connects every native signal with mutually clear
 * copper and manufactured drills. Length matching remains the caller's final
 * refinement step. */
export function* negotiateSurfaceRoutes(
  native: SimpleRouteJson,
  previous: FlexibleSignalState,
  options: SurfaceNegotiationOptions = {},
): Generator<void, FlexibleSignalState | null> {
  const paired = new Set(
      native.differentialPairs?.flatMap((pair) => pair.connectionNames) ?? [],
    ),
    timed = new Set(native.buses?.flatMap((bus) => bus.connectionNames) ?? []),
    frozen = new Set([...paired, ...(options.frozenConnectionNames ?? [])]),
    original = [...previous.retained, ...previous.traces],
    frozenTraces = original.filter((trace) =>
      frozen.has(trace.connection_name!),
    ),
    frozenEscapes = previous.escapes.filter((trace) =>
      frozen.has(trace.connection_name!),
    ),
    targets = native.connections.filter(
      (connection) => !frozen.has(connection.name),
    )
  if (
    frozenTraces.length !== frozen.size ||
    targets.some((connection) => !surfaceBridgeEligible(native, connection))
  )
    return null
  const hard: SimpleRouteJson = {
      ...native,
      traces: [
        ...(native.traces ?? []),
        ...frozenTraces.map((trace) =>
          joinSignalEscapes(
            trace,
            frozenEscapes.filter(
              (escape) => escape.connection_name === trace.connection_name,
            ),
          ),
        ),
      ],
    },
    domains = targets.map(() => [] as Candidate[]),
    current: Array<Candidate | null> = targets.map(() => null),
    hardCopper = fixedCopper({ ...hard, obstacles: [] }),
    conflicts = new CopperConflictIndex(),
    checked = new Map<string, boolean>(),
    searches = new Map<string, Candidate | null>(),
    traceIds = new WeakMap<Trace, number>(),
    clearance =
      native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  let nextId = 0
  let nextTraceId = 0
  const traceId = (trace: Trace) => {
    let id = traceIds.get(trace)
    if (id === undefined) {
      id = nextTraceId++
      traceIds.set(trace, id)
    }
    return id
  }
  const candidate = (route: SurfaceBridgeRoute): Candidate => {
    const joined = joinSignalEscapes(route.carrier, route.escapes)
    return {
      ...route,
      id: nextId++,
      joined,
      copper: fixedCopper({ ...native, obstacles: [], traces: [joined] }),
    }
  }
  const clearOfHard = (index: number, value: Candidate) => {
    const connection = targets[index],
      owners = [connection.name, connection.source_trace_id ?? connection.name],
      foreign = hard.traces!.filter(
        (trace) =>
          !owners.includes(trace.connection_name ?? "") &&
          !owners.includes(trace.source_trace_id ?? ""),
      )
    return (
      !value.joined.route.some(
        (point) =>
          point.route_type === "via" &&
          native.connections.some((connection) =>
            connection.pointsToConnect.some(
              (terminal) => distance(point, terminal) <= 1e-6,
            ),
          ),
      ) &&
      !conflicts.firstConflict(
        value.copper,
        hardCopper.filter(
          (copper) => !copper.owners.some((owner) => owners.includes(owner)),
        ),
        clearance - 1e-8,
      ) &&
      !generatedEscapeHolesConflict(native, [value.joined], foreign)
    )
  }
  const compatible = (first: Candidate, second: Candidate) => {
    const key =
      first.id < second.id
        ? `${first.id}:${second.id}`
        : `${second.id}:${first.id}`
    const cached = checked.get(key)
    if (cached !== undefined) return cached
    const clear =
      !conflicts.firstConflict(first.copper, second.copper, clearance - 1e-8) &&
      !generatedEscapeHolesConflict(native, [first.joined], [second.joined])
    checked.set(key, clear)
    return clear
  }
  const remember = (index: number, value: Candidate) => {
    if (
      !domains[index].some(
        (old) =>
          old.joined.route.length === value.joined.route.length &&
          old.joined.route.every((point, index) => {
            const other = value.joined.route[index]
            return (
              point.route_type === other.route_type &&
              point.x === other.x &&
              point.y === other.y &&
              (point.route_type === "wire" && other.route_type === "wire"
                ? point.layer === other.layer
                : point.route_type === "via" && other.route_type === "via"
                  ? point.from_layer === other.from_layer &&
                    point.to_layer === other.to_layer
                  : false)
            )
          }),
      )
    )
      domains[index].push(value)
    if (domains[index].length > (options.maxDomainCandidates ?? 24))
      domains[index].splice(1, 1)
  }
  const innerOnly =
    targets.length > 0 &&
    native.allowedLayers?.length === 1 &&
    /^inner\d+$/.test(native.allowedLayers[0])
  const sharedNativeSurface =
    targets.length > 0 &&
    targets.every((target) =>
      target.pointsToConnect.every(
        (point) => point.layer === targets[0].pointsToConnect[0].layer,
      ),
    )
  const useHistory =
    sharedNativeSurface && (innerOnly || options.congestionHistory === true)
  const fineGridStep = Math.min(0.05, native.minTraceWidth),
    fullSearchPadding = Math.max(
      native.bounds.maxX - native.bounds.minX,
      native.bounds.maxY - native.bounds.minY,
    ),
    searchPaddings = [
      ...new Set(
        [4, 8, 16, Math.max(16, fullSearchPadding)].map((padding) =>
          Math.max(padding, options.minimumSearchPadding ?? 4),
        ),
      ),
    ],
    windowRounds = Math.max(1, Math.ceil(targets.length / 3)),
    searchWindow = (round: number): SurfaceBridgeOptions =>
      innerOnly
        ? {}
        : {
            gridStep:
              options.surfaceGridStep ??
              (targets.length > 24 ? 0.1 : undefined),
            searchPadding:
              searchPaddings[
                Math.min(
                  searchPaddings.length - 1,
                  Math.floor(round / windowRounds),
                )
              ],
            maxGridCells: 4000000,
          }
  const historyLayers = targets.length
    ? [
        targets[0].pointsToConnect[0].layer,
        native.allowedLayers?.find(
          (layer) => layer !== targets[0].pointsToConnect[0].layer,
        ),
      ]
    : []
  const historyProjector = useHistory
    ? new GridHistoryProjector(
        new VectorScene(native, targets[0], native.minTraceWidth, hardCopper),
        { bounds: native.bounds, step: 0.1 },
      )
    : undefined
  const history = historyProjector
    ? {
        bounds: native.bounds,
        step: 0.1,
        values: [
          new Float32Array(historyProjector.cellCount),
          new Float32Array(historyProjector.cellCount),
        ],
      }
    : undefined
  let historyEpoch = 0
  const select = () =>
    solveSignalCandidatePool(
      domains,
      compatible,
      options.maxCandidateSearchNodes ?? 50000,
      options.maxSupportChecks ?? 500000,
    )
  const report = (
    stage: SurfaceNegotiationProgress["stage"],
    index: number,
    round: number,
    conflicts = 0,
    hardNeighbors: number[] = [],
  ) => {
    if (!options.onProgress) return
    const remaining = current.flatMap((value, index) => (value ? [index] : [])),
      degrees = new Uint16Array(current.length)
    let currentConflicts = 0
    for (const [at, first] of remaining.entries())
      for (const second of remaining.slice(at + 1))
        if (!compatible(current[first]!, current[second]!)) {
          currentConflicts++
          degrees[first]++
          degrees[second]++
        }
    const independent: number[] = []
    for (const index of remaining.sort((a, b) => degrees[a] - degrees[b]))
      if (
        independent.every((other) =>
          compatible(current[index]!, current[other]!),
        )
      )
        independent.push(index)
    options.onProgress({
      stage,
      connectionName: targets[index]?.name ?? "",
      hardNeighbor: hardNeighbors.length
        ? targets[hardNeighbors[0]].name
        : undefined,
      hardNeighbors: hardNeighbors.length
        ? hardNeighbors.map((at) => targets[at].name)
        : undefined,
      routedSignals: current.filter(Boolean).length,
      requestedSignals: targets.length,
      candidates: domains.reduce((sum, domain) => sum + domain.length, 0),
      mutuallyClearSignals: independent.length,
      conflicts: Math.max(conflicts, currentConflicts),
      round,
    })
  }
  const preferredVias = (index: number): 2 | 4 =>
    (timed.has(targets[index].name) && (options.maxTimedVias ?? 2) >= 4) ||
    (frozen.size > paired.size &&
      !timed.has(targets[index].name) &&
      (options.maxUntimedVias ?? 4) >= 4)
      ? 4
      : 2
  const compose = (selected: Candidate[]): FlexibleSignalState => {
    const traces = selected.map((value) => value.carrier),
      escapes = [
        ...frozenEscapes,
        ...selected.flatMap((value) => value.escapes),
      ],
      all = [...frozenTraces, ...traces],
      byName = new Map(all.map((trace) => [trace.connection_name, trace]))
    return {
      native,
      escapes,
      retained: frozenTraces,
      traces,
      pending: {
        ...native,
        traces: [...(native.traces ?? []), ...escapes, ...frozenTraces],
        connections: native.connections.map((connection) => {
          const trace = byName.get(connection.name)!
          return {
            ...connection,
            pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
          }
        }),
      },
    }
  }
  const checkpoint = (selected: Candidate[], conflictCount: number) => {
    options.onProvisionalCheckpoint?.(compose(selected), conflictCount)
    if (!options.onCandidatePoolGraph) return
    const choices = domains.map((domain, index) =>
      domain.includes(selected[index]) ? domain : [...domain, selected[index]],
    )
    const incompatiblePairs: Array<[number, number]> = []
    for (let first = 0; first < choices.length; first++)
      for (let second = first + 1; second < choices.length; second++)
        for (const a of choices[first])
          for (const b of choices[second])
            if (!compatible(a, b)) incompatiblePairs.push([a.id, b.id])
    options.onCandidatePoolGraph({
      routingAccepted: false,
      conflicts: conflictCount,
      connectionNames: targets.map((target) => target.name),
      domains: choices.map((domain) => domain.map((value) => value.id)),
      current: selected.map((value) => value.id),
      incompatiblePairs,
    })
  }
  function* search(
    index: number,
    input: SimpleRouteJson,
    soft: Trace[],
    settings: SurfaceBridgeOptions,
    reverse = false,
    endpointFirst = false,
    attachmentBudget: "early" | "closure" = "early",
  ): Generator<void, Candidate | null> {
    const key = JSON.stringify([
      index,
      input.traces?.map(traceId),
      soft.map(traceId),
      settings,
      reverse,
      endpointFirst,
      attachmentBudget,
      historyEpoch,
      options.heuristicWeight,
      options.nonPreferredLayerCost,
      options.criticalGridOrigins,
      options.endpointViaAttachments,
      domains[index].map((value) => value.id),
    ])
    if (searches.has(key)) return searches.get(key)!
    const connection = targets[index],
      reversed: Connection = reverse
        ? {
            ...connection,
            pointsToConnect: [...connection.pointsToConnect].reverse(),
          }
        : connection
    const bridgeSettings: SurfaceBridgeOptions = {
      gridStep: innerOnly ? 0.1 : undefined,
      heuristicWeight: options.heuristicWeight,
      nonPreferredLayerCost: options.nonPreferredLayerCost,
      ...settings,
      history,
      softTraces: soft,
    }
    const allowAttachments =
        !innerOnly &&
        settings.maxVias === 4 &&
        options.endpointViaAttachments !== false &&
        (settings.maxExpansions ?? 1) > 0,
      attachmentSettings = {
        ...bridgeSettings,
        candidateEscapes: [
          // A newly frozen obstacle can invalidate the old body while one of
          // its generated native approaches remains a useful legal domain.
          ...previous.escapes.filter(
            (escape) => escape.connection_name === connection.name,
          ),
          ...domains[index].flatMap((value) => value.escapes),
          ...(current[index] && !domains[index].includes(current[index]!)
            ? current[index]!.escapes
            : []),
        ],
        heuristicWeight: 1,
        maxAttachmentPairs: attachmentBudget === "early" ? 8 : 16,
        maxExpansions: Math.min(
          settings.maxExpansions ?? 200000,
          attachmentBudget === "early" ? 25000 : 200000,
        ),
      }
    let result =
      endpointFirst && allowAttachments
        ? yield* routeSurfaceViaAttachments(input, reversed, attachmentSettings)
        : null
    if (!result)
      result = yield* routeSurfaceBridge(input, reversed, bridgeSettings)
    if (!result && allowAttachments && !endpointFirst)
      result = yield* routeSurfaceViaAttachments(
        input,
        reversed,
        attachmentSettings,
      )
    if (
      !result &&
      !innerOnly &&
      !settings.gridOrigin &&
      options.criticalGridOrigins !== false &&
      (settings.maxExpansions ?? 1) > 0
    )
      for (const gridOrigin of criticalSurfaceGridOrigins(
        input,
        reversed,
        settings.gridStep ?? fineGridStep,
      )) {
        result = yield* routeSurfaceBridge(input, reversed, {
          ...bridgeSettings,
          gridOrigin,
          maxExpansions: Math.min(settings.maxExpansions ?? 200000, 200000),
        })
        if (result) break
        yield
      }
    if (!result) {
      searches.set(key, null)
      return null
    }
    const value = candidate(
      reverse
        ? {
            carrier: {
              ...result.carrier,
              route: [...result.carrier.route].reverse(),
            },
            escapes: [...result.escapes].reverse(),
          }
        : result,
    )
    remember(index, value)
    searches.set(key, value)
    return value
  }
  for (let index = 0; index < targets.length; index++) {
    const trace = original.find(
      (trace) => trace.connection_name === targets[index].name,
    )
    if (trace) {
      const value = candidate({
        carrier: trace,
        escapes: previous.escapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      })
      if (!clearOfHard(index, value)) continue
      remember(index, value)
      current[index] = value
    }
  }
  for (let index = 0; index < targets.length; index++) {
    if (current[index]) continue
    report("initial", index, 0)
    const soft = current.flatMap((value, other) =>
      value && other !== index ? [value.joined] : [],
    )
    current[index] =
      (yield* search(index, hard, soft, {
        ...searchWindow(0),
        heuristicWeight: 1,
        maxVias: preferredVias(index),
        softPenalty: 2,
        viaPenalty: 2,
        maxExpansions:
          options.maxInitialSoftExpansions ?? options.maxExpansions ?? 900000,
      })) ??
      (yield* search(index, hard, [], {
        ...searchWindow(0),
        ...(innerOnly ? {} : { gridStep: fineGridStep }),
        heuristicWeight: 1,
        maxVias: preferredVias(index),
        viaPenalty: 2,
        maxExpansions: options.maxInitialExpansions ?? 1500000,
      }))
    if (
      !current[index] &&
      (timed.has(targets[index].name)
        ? (options.maxTimedVias ?? 2)
        : (options.maxUntimedVias ?? 4)) >= 4
    )
      current[index] = yield* search(index, hard, [], {
        ...searchWindow(0),
        ...(innerOnly ? {} : { gridStep: fineGridStep }),
        heuristicWeight: 1,
        maxVias: 4,
        viaPenalty: 2,
        maxExpansions: options.maxInitialExpansions ?? 1500000,
      })
    // A local package envelope is a first search, not a routing boundary.
    // Preserve the board-wide escape when an obstacle fences both surfaces.
    if (!current[index] && !innerOnly)
      for (const searchPadding of searchPaddings.slice(1)) {
        current[index] = yield* search(index, hard, [], {
          heuristicWeight: 1,
          searchPadding,
          maxGridCells: 4000000,
          maxVias:
            (timed.has(targets[index].name)
              ? (options.maxTimedVias ?? 2)
              : (options.maxUntimedVias ?? 4)) >= 4
              ? 4
              : 2,
          viaPenalty: 2,
          maxExpansions: options.maxInitialExpansions ?? 1500000,
        })
        if (current[index]) break
        yield
      }
    if (!current[index]) return null
    report("initial", index, 0)
    yield
  }
  let selected = select()
  if (selected) {
    current.splice(0, current.length, ...selected)
    report("complete", -1, 0)
    checkpoint(selected, 0)
    return compose(selected)
  }
  const edges = (values: Array<Candidate | null>) => {
    const result: Array<[number, number]> = []
    for (let first = 0; first < values.length; first++)
      for (let second = first + 1; second < values.length; second++)
        if (
          values[first] &&
          values[second] &&
          !compatible(values[first]!, values[second]!)
        )
          result.push([first, second])
    return result
  }
  let best = current.slice(),
    bestCount = edges(current).length,
    lastImprovement = 0
  checkpoint(best as Candidate[], bestCount)
  const lastAttempt = new Int32Array(targets.length),
    lastFailure = new Int32Array(targets.length),
    lastClearAttempt = new Int32Array(targets.length),
    rerouteAttempts = new Uint16Array(targets.length),
    pairAttempts = new Map<string, number>()
  lastAttempt.fill(-100)
  lastFailure.fill(-100)
  lastClearAttempt.fill(-100)
  for (let round = 0; round < (options.maxRounds ?? 120); round++) {
    const active = edges(current),
      counts = new Uint16Array(targets.length)
    if (!active.length) {
      report("complete", -1, round)
      checkpoint(current as Candidate[], 0)
      return compose(current as Candidate[])
    }
    if (active.length < bestCount) {
      best = current.slice()
      bestCount = active.length
      lastImprovement = round
      checkpoint(best as Candidate[], bestCount)
    }
    if (round - lastImprovement > (useHistory ? 1000 : 35)) break
    for (const [first, second] of active) {
      if (history && historyProjector) {
        const hit = conflicts.firstConflict(
          current[first]!.copper,
          current[second]!.copper,
          clearance - 1e-8,
        )
        if (hit) {
          const plane = historyLayers.indexOf(hit[0].layer)
          if (plane >= 0)
            historyProjector.penalizeIntersection(
              history.values[plane],
              hit[0].a,
              hit[0].b,
              hit[1].a,
              hit[1].b,
              hit[0].radius + hit[1].radius + clearance,
              true,
              innerOnly ? 2 : 0.3 / Math.max(1, targets.length),
            )
        }
      }
      counts[first]++
      counts[second]++
    }
    if (history) historyEpoch++
    let choices = [...targets.keys()]
      .filter((index) => counts[index] && round - lastFailure[index] >= 15)
      .sort((first, second) => {
        const score = (index: number) =>
          counts[index] / (1 + Math.max(0, 3 - (round - lastAttempt[index])))
        return (
          score(second) - score(first) ||
          lastAttempt[first] - lastAttempt[second]
        )
      })
    if (!choices.length)
      choices = [...targets.keys()]
        .filter((index) => counts[index])
        .sort((first, second) => lastFailure[first] - lastFailure[second])
    let index = choices[0],
      hardNeighbor: number | undefined,
      hardNeighbors: number[] = []
    if (options.hardNeighborRouting && round % 3 === 2) {
      const proposal = rankSignalConflictPairs(
        domains,
        current as Candidate[],
        compatible,
        options.maxSupportChecks ?? 10000,
      )
        .sort(
          (a, b) =>
            Number(b.unsupported) - Number(a.unsupported) ||
            Math.max(...b.indices.map((at) => counts[at])) -
              Math.max(...a.indices.map((at) => counts[at])),
        )
        .find(
          (pair) =>
            (pair.unsupported ||
              round - lastImprovement >= Math.max(2, windowRounds / 2)) &&
            pair.indices.some((at) => round - lastFailure[at] >= 15),
        )
      if (proposal) {
        const key = proposal.indices.join(":"),
          attempt = pairAttempts.get(key) ?? 0,
          ordered = [...proposal.indices].sort(
            (a, b) =>
              counts[b] - counts[a] ||
              domains[a].length - domains[b].length ||
              lastAttempt[a] - lastAttempt[b],
          ),
          preferred = ordered[attempt % 2],
          chosen =
            round - lastFailure[preferred] >= 15
              ? preferred
              : ordered[1 - (attempt % 2)]
        index = chosen
        hardNeighbor = proposal.indices.find((at) => at !== chosen)!
        pairAttempts.set(key, attempt + 1)
        const neighbors = [...targets.keys()]
            .filter(
              (at) =>
                at !== index && !compatible(current[index]!, current[at]!),
            )
            .sort((a, b) => counts[b] - counts[a]),
          limits = [
            2,
            Math.max(2, Math.ceil(neighbors.length / 2)),
            neighbors.length,
          ],
          limit = Math.min(
            options.maxHardNeighbors ?? 1,
            limits[Math.floor(rerouteAttempts[index] / 2) % limits.length],
          ),
          others = neighbors.filter((at) => at !== hardNeighbor),
          offset = others.length ? attempt % others.length : 0
        hardNeighbors = [
          hardNeighbor,
          ...others.slice(offset),
          ...others.slice(0, offset),
        ].slice(0, Math.max(1, limit))
      }
    }
    report("negotiate", index, round, active.length, hardNeighbors)
    lastAttempt[index] = round
    // Reversing the search explores a different native attachment first and
    // breaks the persistent preference for one package's manufactured sites.
    const attempt = rerouteAttempts[index]++,
      reverse = attempt % 2 === 0,
      endpointFirst =
        !innerOnly &&
        options.endpointViaAttachments !== false &&
        preferredVias(index) === 4 &&
        round - lastImprovement >= Math.max(4, windowRounds / 2) &&
        attempt % 3 === 2
    const routingInput = !hardNeighbors.length
        ? hard
        : {
            ...hard,
            traces: [
              ...hard.traces!,
              ...hardNeighbors.map((at) => current[at]!.joined),
            ],
          },
      soft = current.flatMap((value, other) =>
        value && other !== index && !hardNeighbors.includes(other)
          ? [value.joined]
          : [],
      ),
      searchSettings: SurfaceBridgeOptions = {
        ...searchWindow(round + (hardNeighbors.length ? windowRounds : 0)),
        maxVias: preferredVias(index),
        softPenalty: Math.min(300, 5 + round * 2),
        viaPenalty: 2,
        maxExpansions: options.maxExpansions ?? 900000,
      }
    let value = yield* search(
      index,
      routingInput,
      soft,
      searchSettings,
      reverse,
      endpointFirst,
    )
    if (
      !value &&
      !innerOnly &&
      (searchSettings.gridStep ?? fineGridStep) > fineGridStep
    )
      value = yield* search(
        index,
        routingInput,
        soft,
        { ...searchSettings, gridStep: fineGridStep },
        reverse,
        endpointFirst,
      )
    if (value && hardNeighbors.every((at) => compatible(value, current[at]!))) {
      const after = current.filter(
        (other, otherIndex) =>
          other && otherIndex !== index && !compatible(value, other),
      ).length
      if (after >= counts[index]) lastFailure[index] = round
      current[index] = value
      // A useful new escape can trade an existing crossing for a clear
      // neighbor's landing. Generate the neighbor's corresponding replacement
      // before coordinate minimization restores the old target route. The
      // proposal is hard only for this candidate search; supplied copper and
      // paired rails remain hard in every search.
      const blocker = options.rerouteNearbyClearSignals
        ? [...targets.keys()]
            .filter(
              (at) =>
                at !== index &&
                !counts[at] &&
                round - lastClearAttempt[at] >= 14 &&
                !compatible(value!, current[at]!),
            )
            .sort((a, b) => lastClearAttempt[a] - lastClearAttempt[b])[0]
        : undefined
      if (blocker !== undefined) {
        lastClearAttempt[blocker] = round
        report("negotiate", blocker, round, edges(current).length, [index])
        const replacementInput: SimpleRouteJson = {
            ...hard,
            traces: [...hard.traces!, value.joined],
          },
          replacementSoft = current.flatMap((other, at) =>
            other && at !== index && at !== blocker ? [other.joined] : [],
          ),
          replacementSettings: SurfaceBridgeOptions = {
            ...searchWindow(round + windowRounds),
            maxVias: preferredVias(blocker),
            viaPenalty: 2,
            softPenalty: searchSettings.softPenalty,
            maxExpansions: Math.min(options.maxExpansions ?? 900000, 200000),
          },
          replacementReverse = rerouteAttempts[blocker]++ % 2 === 0
        let replacement = yield* search(
          blocker,
          replacementInput,
          replacementSoft,
          replacementSettings,
          replacementReverse,
          endpointFirst,
        )
        if (
          !replacement &&
          !innerOnly &&
          (replacementSettings.gridStep ?? fineGridStep) > fineGridStep
        )
          replacement = yield* search(
            blocker,
            replacementInput,
            replacementSoft,
            { ...replacementSettings, gridStep: fineGridStep },
            replacementReverse,
            endpointFirst,
          )
        if (replacement && compatible(value, replacement))
          current[blocker] = replacement
      }
    } else lastFailure[index] = round
    if (round % 3 === 0) {
      selected = select()
      if (selected) {
        current.splice(0, current.length, ...selected)
        report("complete", -1, round)
        checkpoint(selected, 0)
        return compose(selected)
      }
      const single = minimizeSignalCandidateConflicts(
        domains,
        current as Candidate[],
        compatible,
      )
      current.splice(
        0,
        current.length,
        ...improveSignalCandidateConflicts(domains, single, compatible),
      )
    }
    yield
  }
  const finalConflicts = edges(current).length
  if (!finalConflicts) {
    report("complete", -1, options.maxRounds ?? 120)
    checkpoint(current as Candidate[], 0)
    return compose(current as Candidate[])
  }
  if (finalConflicts < bestCount) {
    best = current.slice()
    bestCount = finalConflicts
    checkpoint(best as Candidate[], finalConflicts)
  }
  current.splice(0, current.length, ...best)
  const maximumClosure = Math.min(4, options.maxClosureSize ?? 3)
  while (edges(current).length) {
    const active = edges(current)
    if (active.length < bestCount) {
      bestCount = active.length
      checkpoint(current as Candidate[], bestCount)
    }
    let progress = false
    // An unroutable component must not hide independent repairs elsewhere.
    // Restart only after a strict global reduction, so each successful sweep
    // is finite and can unlock an earlier blocked component.
    const internalConflicts = (component: number[]) =>
        active.filter(
          ([a, b]) => component.includes(a) && component.includes(b),
        ).length,
      components = conflictComponents(active).sort(
        (a, b) =>
          internalConflicts(b) - internalConflicts(a) || b.length - a.length,
      ),
      proposals: number[][] = [],
      seenProposals = new Set<string>(),
      addProposal = (component: number[]) => {
        const key = [...component].sort((a, b) => a - b).join(":")
        if (!seenProposals.has(key)) {
          seenProposals.add(key)
          proposals.push(component)
        }
      }
    for (const component of components)
      if (component.length <= maximumClosure) addProposal(component)
      else {
        let attempts = 0
        for (const fragment of closureFragments(
          component,
          active,
          maximumClosure,
        )) {
          if (++attempts > (options.maxClosureFragments ?? 12)) break
          addProposal(fragment)
        }
      }
    // Release nearby blockers as atomic members before refining the same
    // unsuccessful smaller closure. A four-member attempt can release two
    // otherwise clear neighbors together, with bounded combination count.
    for (let added = 1; added <= Math.min(2, maximumClosure - 1); added++)
      for (const component of components) {
        if (component.length + added > maximumClosure) continue
        const neighbors = closureNeighbors(
          component,
          maximumClosure >= 4,
        ).slice(0, options.maxClosureNeighbors ?? 4)
        let attempts = 0
        for (const group of combinations(neighbors, added)) {
          if (++attempts > (options.maxClosureFragments ?? 12)) break
          addProposal([...component, ...group])
        }
      }
    proposals.sort(
      (a, b) =>
        internalConflicts(b) - internalConflicts(a) || a.length - b.length,
    )
    closureSweep: for (const gridStep of [0.1, 0.05, 0.025])
      for (const maxVias of [4, 2] as const)
        for (let orientation = 0; orientation < 4; orientation++)
          for (const { originVariant, softPenalty } of closurePolicies(maxVias))
            for (const proposal of proposals) {
              report("closure", proposal[0], 0, active.length)
              if (
                (yield* repairClosure(proposal, {
                  gridStep,
                  maxVias,
                  softPenalty,
                  orientation,
                  originVariant,
                })) &&
                edges(current).length < active.length
              ) {
                progress = true
                break closureSweep
              }
            }
    if (!progress) return null
  }
  if (edges(current).length) return null
  report("complete", -1, 0)
  checkpoint(current as Candidate[], 0)
  return compose(current as Candidate[])

  function closurePolicies(maxVias: 2 | 4) {
    const endpoint =
        !innerOnly && maxVias === 4 && options.endpointViaAttachments !== false,
      result = [{ originVariant: 0, softPenalty: 20 }]
    // Atomic members have all been released. Their old bodies should not cage
    // independently placed endpoint vias before any new body has been built.
    if (endpoint) result.push({ originVariant: -1, softPenalty: 0 })
    for (const softPenalty of [0, 2, 200])
      result.push({ originVariant: 0, softPenalty })
    if (endpoint)
      for (const softPenalty of [20, 2, 200])
        result.push({ originVariant: -1, softPenalty })
    if (!innerOnly && options.criticalGridOrigins !== false)
      for (const originVariant of [1, 2, 3, 4])
        for (const softPenalty of [0, 20])
          result.push({ originVariant, softPenalty })
    return result
  }

  function closureNeighbors(component: number[], preferNative = false) {
    const blocked = component.flatMap((first, at) =>
        component.slice(at + 1).flatMap((second) => {
          const hit = conflicts.firstConflict(
            current[first]!.copper,
            current[second]!.copper,
            clearance - 1e-8,
          )
          return hit ?? []
        }),
      ),
      copperDistance = (index: number) =>
        Math.min(
          ...current[index]!.copper.flatMap((copper) =>
            blocked
              .filter((other) => other.layer === copper.layer)
              .map(
                (other) =>
                  segmentDistance([other.a, other.b], [copper.a, copper.b]) -
                  copper.radius -
                  other.radius,
              ),
          ),
        ),
      padDistance = (index: number) =>
        Math.min(
          ...targets[index].pointsToConnect.flatMap((point) =>
            component.flatMap((other) =>
              targets[other].pointsToConnect.map((terminal) =>
                distance(point, terminal),
              ),
            ),
          ),
        ),
      score = (index: number) =>
        preferNative
          ? Math.min(copperDistance(index), padDistance(index))
          : copperDistance(index)
    return [...targets.keys()]
      .filter((index) => !component.includes(index))
      .sort((first, second) => score(first) - score(second))
  }

  function* repairClosure(
    component: number[],
    settings: {
      gridStep: number
      maxVias: 2 | 4
      softPenalty: number
      orientation: number
      originVariant: number
    },
  ): Generator<void, boolean> {
    const stable = current.flatMap((value, index) =>
        value && !component.includes(index) ? [value] : [],
      ),
      input = {
        ...hard,
        traces: [...hard.traces!, ...stable.map((value) => value.joined)],
      }
    const permitsFour = component.some(
      (index) =>
        (timed.has(targets[index].name)
          ? (options.maxTimedVias ?? 2)
          : (options.maxUntimedVias ?? 4)) >= 4,
    )
    if (settings.maxVias === 4 && !permitsFour) return false
    const { gridStep, maxVias, softPenalty } = settings,
      orientation = [...orientations(component.length, maxVias > 2)][
        settings.orientation
      ]
    if (!orientation) return false
    for (const order of closureOrders(component)) {
      const gridOrigin =
          settings.originVariant > 0
            ? criticalSurfaceGridOrigins(input, targets[order[0]], gridStep)[
                settings.originVariant - 1
              ]
            : undefined,
        built: Candidate[] = []
      if (settings.originVariant > 0 && !gridOrigin) continue
      let failed = false
      for (const [at, index] of order.entries()) {
        const value = yield* search(
          index,
          {
            ...input,
            traces: [...input.traces, ...built.map((value) => value.joined)],
          },
          order.slice(at + 1).map((other) => current[other]!.joined),
          {
            gridStep,
            gridOrigin: at ? undefined : gridOrigin,
            searchPadding: innerOnly ? undefined : fullSearchPadding,
            maxGridCells: 4000000,
            maxVias: timed.has(targets[index].name)
              ? Math.min(options.maxTimedVias ?? 2, maxVias)
              : maxVias,
            softPenalty: at ? 0 : softPenalty,
            viaPenalty: 2,
            maxExpansions:
              gridStep >= 0.1
                ? Math.min(options.maxClosureExpansions ?? 2000000, 200000)
                : (options.maxClosureExpansions ?? 2000000),
          },
          orientation[at],
          settings.originVariant === -1,
          "closure",
        )
        if (
          !value ||
          [...stable, ...built].some((other) => !compatible(value, other))
        ) {
          failed = true
          break
        }
        built.push(value)
      }
      if (!failed) {
        for (const [at, index] of order.entries()) current[index] = built[at]
        return true
      }
      selected = select()
      if (selected) {
        current.splice(0, current.length, ...selected)
        return true
      }
      // An independent component may remain blocked while candidates from
      // this failed atomic order already remove crossings elsewhere. Preserve
      // that strict global improvement instead of requiring the entire graph
      // to become clear in a single closure attempt.
      const single = minimizeSignalCandidateConflicts(
          domains,
          current as Candidate[],
          compatible,
        ),
        improved = improveSignalCandidateConflicts(domains, single, compatible)
      if (edges(improved).length < edges(current).length) {
        current.splice(0, current.length, ...improved)
        return true
      }
      yield
    }
    return false
  }
}

function conflictComponents(edges: Array<[number, number]>): number[][] {
  const remaining = new Set(edges.flat()),
    components: number[][] = []
  while (remaining.size) {
    const start = remaining.values().next().value!,
      component = [start]
    remaining.delete(start)
    for (const index of component)
      for (const [first, second] of edges) {
        const next = first === index ? second : second === index ? first : -1
        if (remaining.delete(next)) component.push(next)
      }
    components.push(component)
  }
  return components
}

/** Bound the number released together, rather than the total size of a
 * conflict component. Highest-degree hubs can clear several crossings while
 * the remaining members stay hard, so every successful fragment removes at
 * least one edge from the complete physical conflict graph. */
function* closureFragments(
  component: number[],
  edges: Array<[number, number]>,
  limit: number,
): Generator<number[]> {
  if (limit < 1) return
  const neighbors = new Map(
      component.map((index) => [
        index,
        edges.flatMap(([first, second]) =>
          first === index ? [second] : second === index ? [first] : [],
        ),
      ]),
    ),
    hubs = [...component].sort(
      (first, second) =>
        neighbors.get(second)!.length - neighbors.get(first)!.length,
    ),
    seen = new Set<string>()
  for (const hub of hubs) {
    const adjacent = neighbors
      .get(hub)!
      .sort(
        (first, second) =>
          neighbors.get(second)!.length - neighbors.get(first)!.length,
      )
    if (limit > 3)
      for (const group of combinations(adjacent, 3)) {
        const fragment = [hub, ...group],
          key = [...fragment].sort((a, b) => a - b).join(":")
        if (!seen.has(key)) {
          seen.add(key)
          yield fragment
        }
      }
    if (limit > 2)
      for (let first = 0; first < adjacent.length; first++)
        for (const second of adjacent.slice(first + 1)) {
          const fragment = [hub, adjacent[first], second],
            key = [...fragment].sort((a, b) => a - b).join(":")
          if (!seen.has(key)) {
            seen.add(key)
            yield fragment
          }
        }
    if (limit > 1)
      for (const neighbor of adjacent) {
        const fragment = [hub, neighbor],
          key = [...fragment].sort((a, b) => a - b).join(":")
        if (!seen.has(key)) {
          seen.add(key)
          yield fragment
        }
      }
    if (limit === 1) yield [hub]
  }
}

function* permutations(values: number[]): Generator<number[]> {
  if (values.length < 2) {
    yield values
    return
  }
  for (let index = 0; index < values.length; index++)
    for (const tail of permutations(values.filter((_, at) => at !== index)))
      yield [values[index], ...tail]
}

/** Larger atomic releases use a fixed-size order portfolio instead of a
 * factorial search. Each member is tried first in both directions. */
function* closureOrders(values: number[]): Generator<number[]> {
  if (values.length <= 3) {
    yield* permutations(values)
    return
  }
  for (let offset = 0; offset < Math.min(values.length, 4); offset++) {
    const order = [...values.slice(offset), ...values.slice(0, offset)]
    yield order
    yield [...order].reverse()
  }
}

function* combinations(values: number[], count: number): Generator<number[]> {
  if (!count) {
    yield []
    return
  }
  for (let index = 0; index <= values.length - count; index++)
    for (const rest of combinations(values.slice(index + 1), count - 1))
      yield [values[index], ...rest]
}

function* orientations(
  size: number,
  preferNative = false,
): Generator<boolean[]> {
  const alternating = Array.from(
      { length: size },
      (_, index) => index % 2 === 1,
    ),
    preferred = preferNative
      ? [
          alternating.map(() => false),
          alternating,
          alternating.map((value) => !value),
          alternating.map(() => true),
        ]
      : [
          alternating,
          alternating.map((value) => !value),
          alternating.map(() => false),
          alternating.map(() => true),
        ],
    seen = new Set<number>()
  for (const value of preferred) {
    const mask = value.reduce(
      (mask, reverse, index) => mask | (Number(reverse) << index),
      0,
    )
    if (seen.has(mask)) continue
    seen.add(mask)
    yield value
  }
  for (let mask = 0; mask < 2 ** size; mask++) {
    if (seen.has(mask)) continue
    yield Array.from({ length: size }, (_, index) => !!(mask & (1 << index)))
  }
}
