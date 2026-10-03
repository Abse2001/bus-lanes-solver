import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { distance, length, simplify } from "./geometry"
import { GridVisibilitySearch } from "./grid-visibility"
import { interPackageTuningWindow } from "./inter-package-tuning-window"
import { tuningPathIsSelfClear } from "./length-tuning"
import { fixedRouteLength } from "./route-lengths"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"
import { connectors } from "./vector-visibility"
import {
  copperTooClose,
  fixedCopper,
  routeCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"

type Bounds = SimpleRouteJson["bounds"]
type RoutingWindow = { start: number; end: number }

export interface AnytimeTopologyProposal {
  traces: Trace[]
  /** Geometry changed in this transaction; pair rails remain atomic and fixed. */
  changedNames: string[]
  /** Transitive bus/pair cohort to rematch together before committing. */
  retuneNames: string[]
  envelope: Bounds
  stage: "shortcut" | "rip_up" | "contract"
}

export interface AnytimeTopologyOptions {
  maxTargets?: number
  maxTransactions?: number
  maxProposals?: number
  maxRipUp?: number
  beamWidth?: number
  maxSearchExpansions?: number
  gridStep?: number
  /** One grid step expands at most 500 vertices; every chunk yields control. */
  searchStepsPerYield?: number
  contractions?: number[]
  /** Rip up every ordinary unit together, preserving fixed pair corridors. */
  repackWholeCohort?: boolean
  /** Work chunks for the whole-cohort branch before each local search round. */
  repackChunksPerRound?: number
  /** Also try the exact full blocker set, beyond the local maxRipUp beam. */
  ripUpBlockerClosure?: boolean
  /** Blockers may temporarily grow while opening a shorter driver corridor. */
  blockerLengthAllowance?: number
  /** Alternate outside portals explore distinct channels near the same detour. */
  maxPortalVariants?: number
}

/** Electrical transactions close overlapping bus cohorts and paired members.
 * Geometry need only reroute the blocking units; tuning must use this closure. */
export function anytimeMatchingCohort(
  input: SimpleRouteJson,
  changedNames: Iterable<string>,
): string[] {
  const names = new Set(changedNames)
  const groups = [
    ...(input.buses ?? []).map((bus) => bus.connectionNames),
    ...(input.differentialPairs ?? []).map((pair) => pair.connectionNames),
  ]
  for (let changed = true; changed; ) {
    changed = false
    for (const group of groups) {
      if (!group.some((name) => names.has(name))) continue
      for (const name of group) {
        if (names.has(name)) continue
        names.add(name)
        changed = true
      }
    }
  }
  return input.connections.map((c) => c.name).filter((name) => names.has(name))
}

const boundsOf = (traces: Trace[]): Bounds => {
  const result = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  }
  for (const trace of traces)
    for (const p of trace.route) {
      const radius = p.route_type === "wire" ? p.width / 2 : 0
      result.minX = Math.min(result.minX, p.x - radius)
      result.maxX = Math.max(result.maxX, p.x + radius)
      result.minY = Math.min(result.minY, p.y - radius)
      result.maxY = Math.max(result.maxY, p.y + radius)
    }
  return result
}

function contractedEnvelope(
  input: SimpleRouteJson,
  traces: Trace[],
  fraction: number,
): Bounds {
  const current = boundsOf(traces)
  const terminals = boundsOf(
    input.connections.map((c) => ({
      type: "pcb_trace",
      pcb_trace_id: c.name,
      route: c.pointsToConnect.map((p) => ({
        ...p,
        route_type: "wire",
        width: Math.max(
          input.minTraceWidth,
          (traces.find((t) => t.connection_name === c.name)?.route[0] as Wire)
            ?.width ?? input.minTraceWidth,
        ),
      })),
    })),
  )
  const edge = input.minBoardEdgeClearance ?? 0
  // Keep exact terminal attachments legal while squeezing movable perimeter.
  return {
    minX: Math.max(
      input.bounds.minX,
      Math.min(
        current.minX + fraction * (current.maxX - current.minX),
        terminals.minX - edge - 1e-5,
      ),
    ),
    maxX: Math.min(
      input.bounds.maxX,
      Math.max(
        current.maxX - fraction * (current.maxX - current.minX),
        terminals.maxX + edge + 1e-5,
      ),
    ),
    minY: Math.max(
      input.bounds.minY,
      Math.min(
        current.minY + fraction * (current.maxY - current.minY),
        terminals.minY - edge - 1e-5,
      ),
    ),
    maxY: Math.min(
      input.bounds.maxY,
      Math.max(
        current.maxY - fraction * (current.maxY - current.minY),
        terminals.maxY + edge + 1e-5,
      ),
    ),
  }
}

const samePath = (a: Trace, b: Trace) =>
  a.route.length === b.route.length &&
  a.route.every((p, i) => distance(p, b.route[i]) < 1e-8)

function replacement(
  trace: Trace,
  points: Point[],
  start = 0,
  end = trace.route.length - 1,
): Trace {
  const first = trace.route[start] as Wire
  const middle = simplify(points).map((p) => ({
    ...p,
    route_type: "wire" as const,
    layer: first.layer,
    width: first.width,
  }))
  middle[0] = { ...first }
  middle[middle.length - 1] = { ...(trace.route[end] as Wire) }
  const delta = middle.length - (end - start + 1)
  const route = [
    ...trace.route.slice(0, start),
    ...middle,
    ...trace.route.slice(end + 1),
  ]
  return {
    ...trace,
    route,
    curvedSegments: trace.curvedSegments
      ?.filter((index) => index <= start || index > end)
      .map((index) => (index > end ? index + delta : index)),
    coupledSection: undefined,
  }
}

/** Scratch topology search, separate from the incumbent and the original lane
 * solver. A small deterministic beam branches on blocking copper and reroute
 * order. Every proposal is a complete geometric transaction; the caller jointly
 * retunes its electrical cohort and validates before replacing the incumbent. */
export function* searchAnytimeTopology(
  input: SimpleRouteJson,
  traces: Trace[],
  options: AnytimeTopologyOptions = {},
): Generator<AnytimeTopologyProposal | undefined> {
  if (!traces.length) return
  const original = structuredClone(traces)
  const maxTargets = options.maxTargets ?? 8,
    maxTransactions = options.maxTransactions ?? 64,
    maxProposals = options.maxProposals ?? 32,
    maxRipUp = options.maxRipUp ?? 2,
    beamWidth = options.beamWidth ?? 4,
    maxSearchExpansions = options.maxSearchExpansions ?? 8000,
    stepsPerYield = Math.max(1, options.searchStepsPerYield ?? 2)
  const pairs = new Set(
    (input.differentialPairs ?? []).flatMap((pair) => pair.connectionNames),
  )
  const eligible = original.filter((trace) => {
    const first = trace.route[0]
    return (
      trace.connection_name &&
      !pairs.has(trace.connection_name) &&
      !trace.coupledSection &&
      first?.route_type === "wire" &&
      trace.route.every(
        (p) =>
          p.route_type === "wire" &&
          p.layer === first.layer &&
          p.width === first.width,
      )
    )
  })
  const envelope = boundsOf(original)
  const span = Math.max(
    1e-6,
    envelope.maxX - envelope.minX,
    envelope.maxY - envelope.minY,
  )
  const priority = (trace: Trace) => {
    const lane = boundsOf([trace])
    const boundary = Math.max(
      envelope.maxX - envelope.minX - (envelope.maxX - lane.maxX),
      envelope.maxY - envelope.minY - (envelope.maxY - lane.maxY),
      envelope.maxX - envelope.minX - (lane.minX - envelope.minX),
      envelope.maxY - envelope.minY - (lane.minY - envelope.minY),
    )
    const detour =
      length(trace.route) - distance(trace.route[0], trace.route.at(-1)!)
    return (
      3 * detour +
      0.25 *
        (length(trace.route) +
          fixedRouteLength(input, trace.connection_name!)) +
      boundary / span
    )
  }
  eligible.sort(
    (a, b) =>
      priority(b) - priority(a) ||
      a.connection_name!.localeCompare(b.connection_name!),
  )
  const windows = new Map<string, RoutingWindow>()
  const portalVariants = new Map<string, RoutingWindow[]>()
  const direction = original.reduce(
    (sum, t) => ({
      x: sum.x + t.route.at(-1)!.x - t.route[0].x,
      y: sum.y + t.route.at(-1)!.y - t.route[0].y,
    }),
    { x: 0, y: 0 },
  )
  const directionLength = Math.hypot(direction.x, direction.y)
  if (directionLength > 1e-8 && input.obstacles.some((o) => o.componentId)) {
    const along = (p: Point) =>
      (p.x * direction.x + p.y * direction.y) / directionLength
    const open = interPackageTuningWindow(
      input,
      original,
      along,
      input.minTraceWidth,
    )
    const fields = new Map<string, Bounds>()
    for (const obstacle of input.obstacles) {
      if (!obstacle.componentId) continue
      if (!fields.has(obstacle.componentId))
        fields.set(obstacle.componentId, {
          minX: Infinity,
          maxX: -Infinity,
          minY: Infinity,
          maxY: -Infinity,
        })
      const field = fields.get(obstacle.componentId)!
      const angle = ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180
      const dx =
        (Math.abs(Math.cos(angle)) * obstacle.width +
          Math.abs(Math.sin(angle)) * obstacle.height) /
        2
      const dy =
        (Math.abs(Math.sin(angle)) * obstacle.width +
          Math.abs(Math.cos(angle)) * obstacle.height) /
        2
      field.minX = Math.min(field.minX, obstacle.center.x - dx)
      field.maxX = Math.max(field.maxX, obstacle.center.x + dx)
      field.minY = Math.min(field.minY, obstacle.center.y - dy)
      field.maxY = Math.max(field.maxY, obstacle.center.y + dy)
    }
    if (fields.size >= 2 || open.end > open.start) {
      for (const lane of eligible) {
        const margin =
          (lane.route[0] as Wire).width / 2 +
          (input.minTraceToPadEdgeClearance ??
            input.defaultObstacleMargin ??
            0.075)
        // A portal on a package's outside face is usable even when it is not
        // between the two longitudinal pad extents. This exposes long detours
        // that go around the opposite side of a package before heading inward.
        const indices = lane.route.flatMap((p, index) =>
          fields.size >= 2
            ? [...fields.values()].every(
                (field) =>
                  p.x < field.minX - margin ||
                  p.x > field.maxX + margin ||
                  p.y < field.minY - margin ||
                  p.y > field.maxY + margin,
              )
              ? [index]
              : []
            : along(p) >= open.start && along(p) <= open.end
              ? [index]
              : [],
        )
        let start = indices[0],
          end = indices.at(-1)
        // Prefer the most wasteful outside excursion over a broad splice that
        // also crosses a package. Unmarked routing U-turns are topology detours,
        // so their best bridge ports are often well inside the first/last exit.
        const prefixLengths = [0]
        for (let index = 1; index < lane.route.length; index++)
          prefixLengths.push(
            prefixLengths[index - 1] +
              distance(lane.route[index - 1], lane.route[index]),
          )
        let bestMerit = 0
        const ranked: (RoutingWindow & { merit: number })[] = []
        for (let first = 0; first < indices.length; first++) {
          for (let last = first + 1; last < indices.length; last++) {
            const si = indices[first],
              ei = indices[last]
            if (ei <= si + 1) continue
            const dx = Math.abs(lane.route[ei].x - lane.route[si].x)
            const dy = Math.abs(lane.route[ei].y - lane.route[si].y)
            const chord = Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
            const gain = prefixLengths[ei] - prefixLengths[si] - chord
            if (chord < margin || gain <= margin) continue
            const merit = (gain * gain) / chord
            ranked.push({ start: si, end: ei, merit })
            if (merit <= bestMerit + 1e-8) continue
            bestMerit = merit
            start = si
            end = ei
          }
        }
        if (start !== undefined && end !== undefined && end > start + 1) {
          windows.set(lane.connection_name!, { start, end })
          const widerStart = indices[indices.indexOf(start) - 1],
            widerEnd = indices[indices.indexOf(end) + 1]
          const choices: RoutingWindow[] = [
            { start, end },
            ...(widerStart !== undefined && widerEnd !== undefined
              ? [{ start: widerStart, end: widerEnd }]
              : []),
            ...ranked.sort((a, b) => b.merit - a.merit),
          ]
          const keys = new Set<string>()
          portalVariants.set(
            lane.connection_name!,
            choices
              .filter((window) => {
                const key = `${window.start}:${window.end}`
                if (keys.has(key)) return false
                keys.add(key)
                return true
              })
              .slice(0, Math.max(1, options.maxPortalVariants ?? 2))
              .map(({ start, end }) => ({ start, end })),
          )
        }
      }
    }
  }
  const pinnedApproachesFor = (
    group: Trace[],
    localWindows: ReadonlyMap<string, RoutingWindow>,
  ) =>
    group.flatMap((trace) => {
      const window = localWindows.get(trace.connection_name!)
      return window
        ? [
            ...routeCopper({
              ...trace,
              route: trace.route.slice(0, window.start + 1),
            }),
            ...routeCopper({ ...trace, route: trace.route.slice(window.end) }),
          ]
        : []
    })
  const fixed = fixedCopper(input)
  const reserved: Copper[] = input.connections.flatMap((c) =>
    c.pointsToConnect.map((p) => ({
      a: p,
      b: p,
      layer: p.layer,
      radius:
        ((original.find((t) => t.connection_name === c.name)?.route[0] as Wire)
          ?.width ?? input.minTraceWidth) / 2,
      owners: [c.name, c.source_trace_id ?? c.name],
    })),
  )
  const sceneFor = (
    scratch: Trace[],
    target: Trace,
    bounds: Bounds,
    localWindows: ReadonlyMap<string, RoutingWindow>,
    pinnedApproaches: Copper[],
  ) => {
    const originalConnection = input.connections.find(
      (c) => c.name === target.connection_name,
    )!
    const window = localWindows.get(target.connection_name!)
    const connection = window
      ? {
          ...originalConnection,
          pointsToConnect: [
            target.route[window.start],
            target.route[window.end],
          ].map((p) => ({ x: p.x, y: p.y, layer: (p as Wire).layer })),
        }
      : originalConnection
    return new VectorScene(
      { ...input, bounds },
      connection,
      (target.route[0] as Wire).width,
      [
        ...fixed,
        ...reserved,
        ...pinnedApproaches,
        ...scratch.flatMap(routeCopper),
      ],
    )
  }
  const gridSteps = options.gridStep
    ? [options.gridStep]
    : [input.minTraceWidth * 2, input.minTraceWidth, input.minTraceWidth / 2]
  const gridBoundsFor = (bounds: Bounds, gridStep: number): Bounds => {
    const down = (value: number, origin: number) =>
      origin + Math.floor((value - origin) / gridStep) * gridStep
    const up = (value: number, origin: number) =>
      origin + Math.ceil((value - origin) / gridStep) * gridStep
    // Contract the physical window without shifting its routing lattice.
    // Moving the origin by tiny envelope epsilons loses exact BGA corridors.
    return {
      minX: down(bounds.minX, input.bounds.minX),
      maxX: up(bounds.maxX, input.bounds.minX),
      minY: down(bounds.minY, input.bounds.minY),
      maxY: up(bounds.maxY, input.bounds.minY),
    }
  }
  let transactions = 0,
    proposals = 0
  const seen = new Set<string>()
  function* targetSearch(
    target: Trace,
    wholeGroup = false,
    alternateWindow?: RoutingWindow,
  ): Generator<AnytimeTopologyProposal | undefined> {
    if (transactions >= maxTransactions || proposals >= maxProposals) return
    const targetWindow = alternateWindow ??
      windows.get(target.connection_name!) ?? {
        start: 0,
        end: target.route.length - 1,
      }
    const shortest = connectors(
      target.route[targetWindow.start],
      target.route[targetWindow.end],
    ).sort((a, b) => length(a) - length(b) || a.length - b.length)
    const blockerRanks = new Map<string, number>()
    const clearance =
      (target.route[0] as Wire).width / 2 +
      (input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075)
    for (const candidate of wholeGroup ? [] : shortest) {
      for (const blocker of eligible) {
        if (blocker === target) continue
        let conflicts = 0
        for (const copper of routeCopper(blocker)) {
          if (copper.layer !== (target.route[0] as Wire).layer) continue
          for (let i = 1; i < candidate.length; i++)
            if (
              copperTooClose(
                candidate[i - 1],
                candidate[i],
                copper,
                clearance - 1e-8,
              )
            )
              conflicts++
        }
        if (conflicts)
          blockerRanks.set(
            blocker.connection_name!,
            Math.max(
              blockerRanks.get(blocker.connection_name!) ?? 0,
              conflicts,
            ),
          )
      }
      yield undefined
    }
    const allBlockers = [...blockerRanks]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => original.find((t) => t.connection_name === name)!)
    const blockers = allBlockers.slice(0, beamWidth)
    const groups: Trace[][] = wholeGroup ? [[...eligible]] : [[target]]
    // A short corridor may cross many independent controls outside its bus.
    // Treat that complete geometric blocker closure as one early transaction,
    // rather than hoping a one/two-lane local beam can clear it incrementally.
    if (
      !wholeGroup &&
      options.ripUpBlockerClosure !== false &&
      allBlockers.length > 1
    )
      groups.unshift([target, ...allBlockers])
    if (!wholeGroup && maxRipUp > 0)
      for (const blocker of blockers) groups.push([target, blocker])
    if (!wholeGroup && maxRipUp > 1)
      for (let i = 0; i < blockers.length; i++)
        for (let j = i + 1; j < blockers.length; j++)
          groups.push([target, blockers[i], blockers[j]])
    // The beam includes independent shortcuts, one blocker and pairs of
    // blockers. Order reversal explores which lane owns a contested corridor.
    for (const fraction of options.contractions ?? [0.12, 0.25, 0, 0.4]) {
      for (const group of groups.slice(0, beamWidth + 1)) {
        const localWindows = new Map(windows)
        if (alternateWindow)
          localWindows.set(target.connection_name!, alternateWindow)
        if (group.length > 1) {
          const bridge = shortest[0]
          for (const blocker of group) {
            if (blocker === target) continue
            const collides = (copper: Copper) =>
              copper.layer === (target.route[0] as Wire).layer &&
              bridge
                .slice(1)
                .some((point, index) =>
                  copperTooClose(
                    bridge[index],
                    point,
                    copper,
                    clearance - 1e-8,
                  ),
                )
            const segments = routeCopper(blocker)
            const collisions = segments.flatMap((copper, index) =>
              collides(copper) ? [index] : [],
            )
            if (!collisions.length) continue
            const previous = localWindows.get(blocker.connection_name!) ?? {
              start: 0,
              end: blocker.route.length - 1,
            }
            let start = Math.min(previous.start, Math.max(0, collisions[0] - 1))
            let end = Math.max(
              previous.end,
              Math.min(blocker.route.length - 1, collisions.at(-1)! + 2),
            )
            while (start > 0 && segments.slice(0, start).some(collides)) start--
            while (
              end < blocker.route.length - 1 &&
              segments.slice(end).some(collides)
            )
              end++
            localWindows.set(blocker.connection_name!, { start, end })
          }
        }
        const pinnedApproaches = pinnedApproachesFor(group, localWindows)
        const orders =
          group.length === 1 ? [group] : [group, [...group].reverse()]
        if (group.length > 3 && !wholeGroup)
          orders.push(
            [target, ...group.slice(1).reverse()],
            [...group.slice(1), target],
          )
        if (wholeGroup)
          orders.push(
            [...group].sort(
              (a, b) =>
                length(b.route) +
                  fixedRouteLength(input, b.connection_name!) -
                  length(a.route) -
                  fixedRouteLength(input, a.connection_name!) ||
                a.connection_name!.localeCompare(b.connection_name!),
            ),
          )
        const bounds = contractedEnvelope(input, original, fraction)
        for (const order of orders) {
          if (transactions++ >= maxTransactions || proposals >= maxProposals)
            return
          const removed = new Set(group.map((t) => t.connection_name))
          const scratch = original.filter(
            (t) => !removed.has(t.connection_name),
          )
          let complete = true
          for (const lane of order) {
            const scene = sceneFor(
              scratch,
              lane,
              bounds,
              localWindows,
              pinnedApproaches,
            )
            const window = localWindows.get(lane.connection_name!) ?? {
              start: 0,
              end: lane.route.length - 1,
            }
            const start = lane.route[window.start],
              end = lane.route[window.end]
            const paths = connectors(start, end).sort(
              (a, b) => length(a) - length(b) || a.length - b.length,
            )
            let path = paths.find(
              (points) =>
                scene.pathVisible(points) &&
                tuningPathIsSelfClear(points, scene.width / 2 + scene.margin),
            )
            yield undefined
            if (!path) {
              for (const requestedStep of gridSteps) {
                const gridStep = Math.max(0.01, requestedStep)
                const search = new GridVisibilitySearch(
                  scene,
                  start,
                  end,
                  [],
                  0,
                  undefined,
                  {
                    step: gridStep,
                    bounds: gridBoundsFor(bounds, gridStep),
                    maxLength:
                      length(lane.route.slice(window.start, window.end + 1)) *
                      (lane === target
                        ? 1.1
                        : Math.max(1.1, options.blockerLengthAllowance ?? 2)),
                    allTerminalAttachments: true,
                  },
                )
                try {
                  while (
                    !search.solved &&
                    !search.failed &&
                    search.expanded < maxSearchExpansions
                  ) {
                    for (
                      let step = 0;
                      step < stepsPerYield &&
                      !search.solved &&
                      !search.failed &&
                      search.expanded < maxSearchExpansions;
                      step++
                    )
                      search.step()
                    yield undefined
                  }
                  if (search.solved) path = search.result
                } finally {
                  search.cancel()
                }
                if (path) break
              }
            }
            if (!path) {
              // A cohort transaction need not replace every lane. Retain its
              // continuous incumbent corridor when earlier routes leave it
              // clear, rather than discarding other useful topology changes
              // because the bounded grid cannot rediscover this attachment.
              const previous = lane.route.slice(window.start, window.end + 1)
              if (scene.pathVisible(previous)) {
                scratch.push(structuredClone(lane))
                continue
              }
            }
            if (
              !path ||
              !scene.pathVisible(path) ||
              !tuningPathIsSelfClear(path, scene.width / 2 + scene.margin)
            ) {
              complete = false
              break
            }
            const nextLane = replacement(lane, path, window.start, window.end)
            if (
              !tuningPathIsSelfClear(
                nextLane.route,
                scene.width / 2 + scene.margin,
              )
            ) {
              complete = false
              break
            }
            scratch.push(nextLane)
          }
          if (!complete) continue
          const ordered = original.map(
            (old) =>
              scratch.find((t) => t.connection_name === old.connection_name)!,
          )
          const changed = ordered.filter((t, i) => !samePath(t, original[i]))
          if (!changed.length) continue
          const changedNames = changed.map((t) => t.connection_name!)
          const key = ordered
            .map((t) =>
              t.route
                .map((p) => `${p.x.toFixed(8)},${p.y.toFixed(8)}`)
                .join(";"),
            )
            .join("|")
          if (seen.has(key)) continue
          seen.add(key)
          // Search output can contain orthogonal raster corners. Bevel only
          // scratch ordinary routes, checking the preserved copper again.
          const beveledChanges = chamferOrdinaryCorners(
            { ...input, bounds },
            changed,
            [
              ...fixed,
              ...ordered
                .filter((t) => !changedNames.includes(t.connection_name!))
                .flatMap(routeCopper),
            ],
          )
          const beveled = ordered.map(
            (trace) =>
              beveledChanges.find(
                (t) => t.connection_name === trace.connection_name,
              ) ?? trace,
          )
          proposals++
          yield {
            traces: structuredClone(beveled),
            changedNames,
            retuneNames: anytimeMatchingCohort(input, changedNames),
            envelope: bounds,
            stage:
              group.length > 1 ? "rip_up" : fraction ? "contract" : "shortcut",
          }
        }
      }
    }
  }
  function* alternateSearch(
    target: Trace,
  ): Generator<AnytimeTopologyProposal | undefined> {
    const alternatives = portalVariants.get(target.connection_name!)
    if (!alternatives || alternatives.length === 1) {
      yield* targetSearch(target)
      return
    }
    const streams = alternatives.map((window) =>
      targetSearch(target, false, window),
    )
    try {
      while (streams.length) {
        for (let index = 0; index < streams.length; ) {
          const next = streams[index].next()
          if (next.done) streams.splice(index, 1)
          else {
            yield next.value
            index++
          }
        }
      }
    } finally {
      for (const stream of streams) stream.return(undefined)
    }
  }
  // Each target gets a work chunk before any target gets its next chunk. This
  // avoids spending a short effort budget on the first congested lane alone.
  const active = eligible
    .slice(0, maxTargets)
    .map((target) => ({ generator: alternateSearch(target), quota: 1 }))
  // A coordinated cohort branch starts immediately, before local blocker
  // discovery. This can move an entire bundle out of its old routing channels.
  if (options.repackWholeCohort !== false && eligible.length > 1)
    active.unshift({
      generator: targetSearch(eligible[0], true),
      quota: Math.max(1, Math.floor(options.repackChunksPerRound ?? 8)),
    })
  try {
    while (active.length && proposals < maxProposals) {
      for (let index = 0; index < active.length; ) {
        const stream = active[index]
        let done = false
        for (let chunk = 0; chunk < stream.quota; chunk++) {
          const next = stream.generator.next()
          if (next.done) {
            done = true
            break
          }
          yield next.value
          if (proposals >= maxProposals) return
        }
        if (done) active.splice(index, 1)
        else index++
      }
    }
  } finally {
    for (const stream of active) stream.generator.return(undefined)
  }
}
