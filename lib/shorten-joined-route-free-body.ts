import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { findFixedPathRanges, fixedPathPointKey } from "./fixed-route-paths"
import { distance, length, simplify } from "./geometry"
import { physicalRoutingAcceptance } from "./physical-routing-acceptance"
import { fixedRouteLength } from "./route-lengths"
import type { Connection, Point, SimpleRouteJson, Trace, Wire } from "./types"
import { fixedCopper, VectorScene, type Copper } from "./vector-scene"
import { connectors, VectorVisibilitySearch } from "./vector-visibility"

export interface FreeBodyShorteningOptions {
  connectionName: string
  /** Full-owned XY copper, including native supplied copper and joined escapes. */
  minimumLength: number
  maximumLength: number
  fixedEscapes: readonly Trace[]
  /** Retain a physically accepted shorter route outside the target band only
   * when it strictly reduces the actual distance to that band. */
  allowPartialProgress?: boolean
  maxExpansions?: number
  maxCandidates?: number
  /** Absolute performance.now() deadline, including physical candidate audits. */
  deadlineMs?: number
}

export interface FreeBodyShorteningProposal {
  trace: Trace
  traces: Trace[]
  fullOwnedLength: number
  previousFullOwnedLength: number
  withinTargetBand: boolean
  distanceToTargetBand: number
  previousDistanceToTargetBand: number
  addedVias: 0
  removedVias: number
  freeInterval: { start: number; end: number }
}

const tolerance = 1e-7
const distanceToBand = (value: number, minimum: number, maximum: number) =>
  Math.max(0, minimum - value, value - maximum)

function freeBody(trace: Trace, fixedEscapes: readonly Trace[]) {
  const ranges = findFixedPathRanges(trace, fixedEscapes)
  if (!ranges || trace.route.length < 2) return null
  let start = 0
  let end = trace.route.length - 1
  for (const range of ranges) {
    if (range.start <= start) start = Math.max(start, range.end)
  }
  for (const range of ranges.toReversed()) {
    if (range.end >= end) end = Math.min(end, range.start)
  }
  if (start >= end) return null
  // An additional immutable interior path cannot be removed by this operator.
  if (ranges.some((range) => range.start < end && range.end > start))
    return null
  const first = trace.route[start]
  const last = trace.route[end]
  if (
    first.route_type !== "wire" ||
    last.route_type !== "wire" ||
    first.layer !== last.layer
  )
    return null
  if (
    trace.coupledSection &&
    trace.coupledSection[0] < end &&
    trace.coupledSection[1] > start
  )
    return null
  return { start, end, first, last }
}

/** Remove only a local contact disk around each joined handoff. The rest of
 * each same-owner fixed path remains hard search geometry; the full native
 * self-short oracle still qualifies these intentional connected contacts. */
function hardOutsideHandoffs(
  copper: Copper,
  handoffs: readonly Point[],
  margin: number,
): Copper[] {
  const dx = copper.b.x - copper.a.x
  const dy = copper.b.y - copper.a.y
  const square = dx * dx + dy * dy
  const radius = copper.radius + margin + 1e-6
  if (square === 0) {
    return handoffs.some((point) => distance(point, copper.a) <= radius)
      ? []
      : [{ ...copper, owners: [] }]
  }
  let intervals: Array<[number, number]> = [[0, 1]]
  for (const point of handoffs) {
    const ex = copper.a.x - point.x
    const ey = copper.a.y - point.y
    const b = 2 * (ex * dx + ey * dy)
    const c = ex * ex + ey * ey - radius * radius
    const discriminant = b * b - 4 * square * c
    if (discriminant < 0) continue
    const root = Math.sqrt(discriminant)
    const lo = Math.max(0, (-b - root) / (2 * square))
    const hi = Math.min(1, (-b + root) / (2 * square))
    if (lo > hi) continue
    intervals = intervals.flatMap(([a, z]): Array<[number, number]> => {
      if (hi <= a || lo >= z) return [[a, z]]
      const remaining: Array<[number, number]> = []
      if (lo > a) remaining.push([a, lo])
      if (hi < z) remaining.push([hi, z])
      return remaining
    })
  }
  return intervals
    .filter(([a, b]) => b > a)
    .map(([a, b]) => ({
      ...copper,
      a: { x: copper.a.x + dx * a, y: copper.a.y + dy * a },
      b: { x: copper.a.x + dx * b, y: copper.a.y + dy * b },
      owners: [],
    }))
}

function fixedHeading(trace: Trace, at: number, before: boolean) {
  const handoff = trace.route[at]
  if (handoff.route_type !== "wire") return undefined
  for (
    let index = at + (before ? -1 : 1);
    index >= 0 && index < trace.route.length;
    index += before ? -1 : 1
  ) {
    const point = trace.route[index]
    if (point.route_type !== "wire" || point.layer !== handoff.layer)
      return undefined
    if (distance(point, handoff) <= 1e-12) continue
    const angle = before
      ? Math.atan2(handoff.y - point.y, handoff.x - point.x)
      : Math.atan2(point.y - handoff.y, point.x - handoff.x)
    const octant = (Math.round(angle / (Math.PI / 4)) * Math.PI) / 4
    return { x: Math.cos(octant), y: Math.sin(octant) }
  }
  return undefined
}

function replaceBody(
  trace: Trace,
  start: number,
  end: number,
  replacement: Wire[],
): Trace {
  const delta = replacement.length - (end - start + 1)
  const curvedSegments = trace.curvedSegments
    ?.filter((index) => index <= start || index > end)
    .map((index) => (index > end ? index + delta : index))
  const coupledSection = trace.coupledSection?.map((index) =>
    index >= end ? index + delta : index,
  ) as [number, number] | undefined
  return {
    ...trace,
    route: [
      ...trace.route.slice(0, start),
      ...replacement,
      ...trace.route.slice(end + 1),
    ],
    ...(trace.curvedSegments === undefined ? {} : { curvedSegments }),
    ...(trace.coupledSection === undefined ? {} : { coupledSection }),
  }
}

/** Shorten the complete free body between exact immutable endpoint paths.
 * Existing internal vias may disappear; endpoint paths, other routes and pair
 * metadata stay fixed. Every proposal is independently whole-native physical
 * accepted. The caller decides whether to adopt or combine proposals. */
export function* shortenJoinedRouteFreeBody(
  native: SimpleRouteJson,
  joinedTraces: readonly Trace[],
  options: FreeBodyShorteningOptions,
): Generator<void | FreeBodyShorteningProposal> {
  const maxExpansions = options.maxExpansions ?? 2000
  const maxCandidates = options.maxCandidates ?? 16
  const deadline = options.deadlineMs ?? Infinity
  if (
    !Number.isFinite(options.minimumLength) ||
    options.minimumLength < 0 ||
    typeof options.maximumLength !== "number" ||
    Number.isNaN(options.maximumLength) ||
    options.maximumLength < options.minimumLength ||
    !Number.isInteger(maxExpansions) ||
    maxExpansions < 0 ||
    !Number.isInteger(maxCandidates) ||
    maxCandidates < 0 ||
    Number.isNaN(deadline)
  )
    throw Error("Invalid free-body shortening band or budget")
  const expired = () => performance.now() >= deadline
  if (!maxExpansions || !maxCandidates || expired()) return
  if (
    native.differentialPairs?.some((pair) =>
      pair.connectionNames.includes(options.connectionName),
    )
  )
    return
  const connection = native.connections.find(
    (candidate) => candidate.name === options.connectionName,
  )
  const matches = joinedTraces.filter(
    (trace) => trace.connection_name === options.connectionName,
  )
  if (!connection || matches.length !== 1) return
  const old = matches[0]
  const interval = freeBody(old, options.fixedEscapes)
  if (!interval) return
  const baseline = physicalRoutingAcceptance(native, joinedTraces, {
    escapes: options.fixedEscapes,
  })
  if (!baseline.physicalRoutingAccepted || expired()) return
  const suppliedLength = fixedRouteLength(native, options.connectionName)
  const previousFullOwnedLength = length(old.route) + suppliedLength
  const previousDistanceToTargetBand = distanceToBand(
    previousFullOwnedLength,
    options.minimumLength,
    options.maximumLength,
  )
  const { first, last, start, end } = interval
  const width = Math.max(
    native.minTraceWidth,
    ...old.route
      .slice(start, end + 1)
      .flatMap((point) => (point.route_type === "wire" ? [point.width] : [])),
  )
  const others = joinedTraces.filter((trace) => trace !== old)
  const fixedParts = [
    { ...old, route: old.route.slice(0, start + 1) },
    { ...old, route: old.route.slice(end) },
    ...(native.traces ?? []).filter(
      (trace) =>
        trace.connection_name === options.connectionName ||
        (connection.source_trace_id !== undefined &&
          trace.source_trace_id === connection.source_trace_id),
    ),
  ]
  const bodyConnection: Connection = {
    ...connection,
    pointsToConnect: [first, last],
  }
  const bodyInput: SimpleRouteJson = {
    ...native,
    connections: [bodyConnection],
  }
  const margin =
    width / 2 +
    (native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075)
  const hard = [
    ...fixedCopper(native),
    ...fixedCopper({ ...native, obstacles: [], traces: [...others] }).map(
      (copper) => ({ ...copper, owners: [] }),
    ),
    ...fixedCopper({ ...native, obstacles: [], traces: fixedParts }).flatMap(
      (copper) => hardOutsideHandoffs(copper, [first, last], margin),
    ),
  ]
  const scene = new VectorScene(bodyInput, bodyConnection, width, hard)
  const seen = new Set<string>()
  let expansions = 0
  let testedCandidates = 0
  const proposal = (path: Point[]): FreeBodyShorteningProposal | null => {
    if (expired() || testedCandidates >= maxCandidates) return null
    const simplified = simplify(path)
    if (simplified.length < 2 || !scene.pathVisible(simplified)) return null
    const key = JSON.stringify(simplified)
    if (seen.has(key)) return null
    seen.add(key)
    testedCandidates++
    const body: Trace = {
      ...old,
      route: simplified.map(
        (point, index): Wire =>
          index === 0
            ? first
            : index === simplified.length - 1
              ? last
              : {
                  x: point.x,
                  y: point.y,
                  route_type: "wire",
                  layer: first.layer,
                  width,
                },
      ),
      curvedSegments: undefined,
      coupledSection: undefined,
    }
    const beveled = chamferOrdinaryCorners(bodyInput, [body], hard)[0]
    if (
      fixedPathPointKey(beveled.route[0]) !== fixedPathPointKey(first) ||
      fixedPathPointKey(beveled.route.at(-1)!) !== fixedPathPointKey(last)
    )
      return null
    const trace = replaceBody(old, start, end, beveled.route as Wire[])
    const fullOwnedLength = length(trace.route) + suppliedLength
    if (fullOwnedLength >= previousFullOwnedLength - tolerance) return null
    const distanceToTargetBand = distanceToBand(
      fullOwnedLength,
      options.minimumLength,
      options.maximumLength,
    )
    const withinTargetBand =
      fullOwnedLength >= options.minimumLength - tolerance &&
      fullOwnedLength <= options.maximumLength + tolerance
    if (
      !withinTargetBand &&
      (!options.allowPartialProgress ||
        distanceToTargetBand >= previousDistanceToTargetBand - tolerance)
    )
      return null
    const traces = joinedTraces.map((candidate) =>
      candidate === old ? trace : candidate,
    )
    const acceptance = physicalRoutingAcceptance(native, traces, {
      escapes: options.fixedEscapes,
    })
    if (!acceptance.physicalRoutingAccepted || expired()) return null
    return {
      trace,
      traces,
      fullOwnedLength,
      previousFullOwnedLength,
      withinTargetBand,
      distanceToTargetBand,
      previousDistanceToTargetBand,
      addedVias: 0,
      removedVias:
        old.route.filter((point) => point.route_type === "via").length -
        trace.route.filter((point) => point.route_type === "via").length,
      freeInterval: { start, end },
    }
  }
  const startHeading = fixedHeading(old, start, true)
  const endHeading = fixedHeading(old, end, false)
  const attemptedGuards = new Set<string>()
  for (const guard of [0, 1.5 * width, 3 * width]) {
    if (
      expired() ||
      testedCandidates >= maxCandidates ||
      expansions >= maxExpansions
    )
      return
    const a = startHeading
      ? {
          x: first.x + startHeading.x * guard,
          y: first.y + startHeading.y * guard,
        }
      : first
    const b = endHeading
      ? { x: last.x - endHeading.x * guard, y: last.y - endHeading.y * guard }
      : last
    const guardKey = JSON.stringify([a.x, a.y, b.x, b.y])
    if (attemptedGuards.has(guardKey)) continue
    attemptedGuards.add(guardKey)
    if (!scene.visible(first, a) || !scene.visible(b, last)) continue
    const compose = (middle: Point[]) => [
      first,
      a,
      ...middle.slice(1, -1),
      b,
      last,
    ]
    for (const path of connectors(a, b)) {
      const candidate = proposal(compose(path))
      if (candidate) yield candidate
      yield
      if (expired() || testedCandidates >= maxCandidates) return
    }
    for (const reverse of [false, true]) {
      const search = new VectorVisibilitySearch(
        scene,
        reverse ? b : a,
        reverse ? a : b,
      )
      while (
        !search.solved &&
        !search.failed &&
        expansions < maxExpansions &&
        !expired()
      ) {
        search.step()
        expansions++
        yield
      }
      if (search.solved) {
        const candidate = proposal(
          compose(reverse ? search.result.toReversed() : search.result),
        )
        if (candidate) yield candidate
        yield
      }
      if (
        expired() ||
        testedCandidates >= maxCandidates ||
        expansions >= maxExpansions
      )
        return
    }
  }
}
