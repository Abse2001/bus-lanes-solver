import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { boardOutlineViolations } from "./board-outline"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { CopperConflictIndex } from "./copper-conflict-index"
import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import { distance, length } from "./geometry"
import { joinSignalEscapes } from "./join-signal-escapes"
import { tuningPathIsSelfClear } from "./length-tuning"
import { normalizeSurfaceCarriers } from "./normalize-surface-carriers"
import type { CandidateDomainFailure } from "./prune-candidate-domains"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { signalWidth } from "./repair-bus-dogbones"
import { routeAnglesAreConventional } from "./route-angle-validation"
import type { Connection, SimpleRouteJson, Trace, Wire } from "./types"
import {
  fixedCopper,
  routeCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"

export interface CarrierShapeCandidate {
  connection: Connection
  layer: string
  trace: Trace
  escapes: Trace[]
  escapeCopper: Copper[]
  maxLength: number
}
/** Only deterministic shaping work is cached, never routing infeasibility.
 * Successful bodies remain available after ordinary pool eviction. */
export type CarrierShapeWorkCache = Map<string, [Wire[], Wire[]] | null>
// A work map belongs to one negotiation. Retain its full physical context
// once, instead of duplicating native pads and fixed copper in every pair key.
const physicalContexts = new WeakMap<CarrierShapeWorkCache, string>()
// SRJ data can contain optional fields and unbounded numeric limits. Preserve
// their types instead of JSON's null/omitted encodings for NaN/Infinity/undefined.
function physicalKey(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "undefined":
      return "undefined"
    case "number":
      return `number:${Object.is(value, -0) ? "-0" : String(value)}`
    case "string":
      return `string:${JSON.stringify(value)}`
    case "boolean":
      return `boolean:${value}`
    case "object":
      if (Array.isArray(value))
        return `array:[${Array.from({ length: value.length }, (_, index) =>
          index in value ? physicalKey(value[index]) : "hole",
        ).join(",")}]`
      return `object:{${Object.keys(value)
        .map(
          (key) =>
            `${JSON.stringify(key)}:${physicalKey((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`
    default:
      // Functions/symbols/bigints are outside the JSON routing-input contract.
      throw Error("Unsupported physical routing data")
  }
}
const maxVertices = 128
const sameEnd = (first: Wire, second: Wire) =>
  first.x === second.x &&
  first.y === second.y &&
  first.layer === second.layer &&
  first.width === second.width

/** Add no searches or sites: finalize ONE pair from the existing initial-AC
 * certificate. Return original candidate references plus separate new bodies.
 * The caller keeps the raw alternatives and uses its next scheduled selection. */
export function finalizeCarrierArcPair<T extends CarrierShapeCandidate>(
  native: SimpleRouteJson,
  fixedTraces: Trace[],
  domains: readonly (readonly T[])[],
  failure: CandidateDomainFailure,
  work: CarrierShapeWorkCache,
): Array<{ original: T; trace: Trace }> {
  if (
    !Array.isArray(failure?.removals) ||
    !Array.isArray(failure?.implicatedRemovals) ||
    !failure.removals.length ||
    !failure.implicatedRemovals.length ||
    domains.some((domain) => !Array.isArray(domain) || domain.length > 48)
  )
    return []
  const index = (value: number, size: number) =>
    Number.isInteger(value) && value >= 0 && value < size
  const validRow = (row: CandidateDomainFailure["removals"][number]) =>
    row &&
    index(row.first, domains.length) &&
    index(row.second, domains.length) &&
    row.first !== row.second &&
    Array.isArray(row.removed) &&
    Array.isArray(row.support) &&
    row.removed.length > 0 &&
    row.support.length > 0 &&
    new Set(row.removed).size === row.removed.length &&
    new Set(row.support).size === row.support.length &&
    row.removed.every((value) => index(value, domains[row.first].length)) &&
    row.support.every((value) => index(value, domains[row.second].length))
  const last = failure.removals.at(-1)!
  if (
    !validRow(last) ||
    last.first !== failure.emptyDomain ||
    last.second !== failure.unsupportedBy ||
    JSON.stringify(last) !== JSON.stringify(failure.implicatedRemovals.at(-1))
  )
    return []
  const recordedRows = new Map<string, number>()
  const removedByDomain = new Map<number, Set<number>>()
  for (const [order, row] of failure.removals.entries()) {
    if (!validRow(row)) return []
    let removed = removedByDomain.get(row.first)
    if (!removed) removedByDomain.set(row.first, (removed = new Set()))
    for (const value of row.removed) {
      if (removed.has(value)) return []
      removed.add(value)
    }
    recordedRows.set(JSON.stringify(row), order)
  }
  let previousOrder = -1
  for (const row of failure.implicatedRemovals) {
    const order = recordedRows.get(JSON.stringify(row))
    if (!validRow(row) || order === undefined || order <= previousOrder)
      return []
    previousOrder = order
  }
  // Compare values every time, including same-reference mutations. A changed
  // physical scene discards both successful and unsuccessful old prefix work.
  const context = physicalKey([native, fixedTraces])
  if (physicalContexts.get(work) !== context) {
    work.clear()
    physicalContexts.set(work, context)
  }
  const signature = (candidate: T, route = candidate?.trace?.route) =>
    candidate && Array.isArray(candidate.escapes) && Array.isArray(route)
      ? JSON.stringify([candidate.escapes.map((trace) => trace?.route), route])
      : undefined
  // Genuine causal rows retain their chronological order and original complete
  // bank indices. With the caller's 48-entry banks, this finite scan is bounded
  // by 48 times the number of actually removed original options. No new route
  // searches or AC/CSP calls occur, and only ONE new pair key is offered here.
  for (const row of failure.implicatedRemovals) {
    for (const removed of row.removed) {
      for (const support of row.support) {
        const pair = [
          domains[row.first][removed],
          domains[row.second][support],
        ] as [T, T]
        const key = physicalKey(
          pair.map((candidate) => [
            candidate?.connection,
            candidate?.layer,
            candidate?.maxLength,
            candidate?.escapes,
            candidate?.escapeCopper,
            candidate?.trace,
          ]),
        )
        if (work.has(key)) {
          const cached = work.get(key)
          if (!cached) continue
          const active = pair.every((candidate, index) => {
            const expected = signature(candidate, cached[index])
            return domains[index ? row.second : row.first].some(
              (other) => signature(other) === expected,
            )
          })
          if (active) continue
          // A valid positive body may have been evicted by the ordinary 48-entry
          // policy. Reoffer it at current original references; never force it.
          return pair.map((original, index) => ({
            original,
            trace: {
              ...original.trace,
              route: structuredClone(cached[index]),
              curvedSegments: undefined,
            },
          }))
        }
        // This is attempted deterministic prefix work, not an unreachable-site
        // cache. Even an ineligible new pair consumes this selection's offer.
        work.set(key, null)
        return finalizePair(native, fixedTraces, pair, work, key)
      }
    }
  }
  return []
}

function finalizePair<T extends CarrierShapeCandidate>(
  native: SimpleRouteJson,
  fixedTraces: Trace[],
  pair: [T, T],
  work: CarrierShapeWorkCache,
  key: string,
): Array<{ original: T; trace: Trace }> {
  if (
    pair.some(
      (candidate) =>
        !candidate ||
        !candidate.connection ||
        typeof candidate.connection.name !== "string" ||
        !Array.isArray(candidate.connection.pointsToConnect) ||
        !candidate.trace ||
        !Array.isArray(candidate.trace.route) ||
        !Array.isArray(candidate.escapes) ||
        !Array.isArray(candidate.escapeCopper),
    )
  )
    return []
  if (
    pair[0].connection.name === pair[1].connection.name ||
    pair.some(
      (candidate) =>
        !native.connections.some(
          (connection) => connection.name === candidate.connection.name,
        ),
    ) ||
    pair.some((candidate) =>
      native.differentialPairs?.some((group) =>
        group.connectionNames.includes(candidate.connection.name),
      ),
    ) ||
    pair.reduce((sum, candidate) => sum + candidate.trace.route.length, 0) >
      maxVertices
  )
    return []
  const allowed = native.allowedLayers ?? getCopperLayerNames(native.layerCount)
  for (const candidate of pair) {
    const trace = candidate.trace,
      width = signalWidth(native, candidate.connection)
    if (
      trace.route.length < 2 ||
      trace.curvedSegments?.length ||
      trace.coupledSection ||
      typeof candidate.maxLength !== "number" ||
      Number.isNaN(candidate.maxLength) ||
      candidate.maxLength < 0 ||
      !allowed.includes(candidate.layer) ||
      trace.route.some(
        (point) =>
          !point ||
          point.route_type !== "wire" ||
          point.layer !== candidate.layer ||
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          !Number.isFinite(point.width) ||
          point.width <= 0 ||
          Math.abs(point.width - width) > 1e-8,
      ) ||
      trace.route[0].route_type !== "wire" ||
      trace.route.at(-1)!.route_type !== "wire" ||
      candidate.connection.pointsToConnect.length !== 2 ||
      candidate.connection.pointsToConnect.some(
        (point) =>
          !point ||
          point.layer !== candidate.layer ||
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y),
      ) ||
      distance(trace.route[0], candidate.connection.pointsToConnect[0]) >
        1e-8 ||
      distance(trace.route.at(-1)!, candidate.connection.pointsToConnect[1]) >
        1e-8
    )
      return []
  }
  const clearance =
    native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  const conflicts = new CopperConflictIndex()
  if (
    generatedEscapeHolesConflict(native, pair[0].escapes, pair[1].escapes) ||
    pair.some((candidate) =>
      generatedEscapeHolesConflict(native, candidate.escapes, fixedTraces),
    ) ||
    conflicts.firstConflict(
      pair[0].escapeCopper,
      pair[1].escapeCopper,
      clearance - 1e-8,
    )
  )
    return []
  const input: SimpleRouteJson = {
    ...native,
    connections: native.connections.map((connection) => {
      const candidate = pair.find(
        (candidate) => candidate.connection.name === connection.name,
      )
      return candidate
        ? {
            ...connection,
            pointsToConnect: [
              candidate.trace.route[0],
              candidate.trace.route.at(-1)!,
            ] as Wire[],
          }
        : connection
    }),
    traces: [...fixedTraces, ...pair.flatMap((candidate) => candidate.escapes)],
  }
  const fixed = fixedCopper(input)
  const scenes = pair.map(
    (candidate) =>
      new VectorScene(
        input,
        candidate.connection,
        (candidate.trace.route[0] as Wire).width,
        fixed,
      ),
  )
  if ([...scenes[0].owners].some((owner) => scenes[1].owners.has(owner)))
    return []
  const attach = (routes: [Wire[], Wire[]]) =>
    pair.map((original, index) => ({
      original,
      trace: {
        ...original.trace,
        route: structuredClone(routes[index]),
        curvedSegments: undefined,
      },
    }))
  // No generated escapes are offered for absorption: exact owned sites and
  // all escape primitives stay with their original option, including Top.
  let prepared = normalizeSurfaceCarriers(
    input,
    structuredClone(pair.map((candidate) => candidate.trace)),
    [],
  )
  const valid = (trace: Trace, index: number) => {
    const original = pair[index],
      first = trace.route[0] as Wire,
      last = trace.route.at(-1) as Wire
    if (
      !sameEnd(first, original.trace.route[0] as Wire) ||
      !sameEnd(last, original.trace.route.at(-1) as Wire) ||
      trace.route.some(
        (point) =>
          point.route_type !== "wire" ||
          point.layer !== original.layer ||
          Math.abs(point.width - first.width) > 1e-8,
      ) ||
      length(trace.route) > original.maxLength + 1e-8 ||
      !scenes[index].pathVisible(trace.route)
    )
      return false
    const joined = joinSignalEscapes(trace, original.escapes)
    if (
      !routeAnglesAreConventional([joined]) ||
      boardOutlineViolations(native, [joined]).length
    )
      return false
    const runs: Wire[][] = []
    for (const point of joined.route) {
      if (point.route_type !== "wire") {
        runs.push([])
        continue
      }
      let run = runs.at(-1)
      if (!run || (run.length && run[0].layer !== point.layer))
        runs.push((run = []))
      run.push(point)
    }
    return runs.every(
      (run) =>
        run.length < 2 || tuningPathIsSelfClear(run, run[0].width + clearance),
    )
  }
  for (let pass = 0; pass < 3; pass++) {
    if (
      prepared.traces.reduce((sum, trace) => sum + trace.route.length, 0) >
      maxVertices
    )
      break
    const before = prepared.traces
    prepared.traces = [...before]
    for (let index = 0; index < 2; index++) {
      const trace = prepared.traces[index],
        first = trace.route[0] as Wire
      const connection = prepared.input.connections.find(
        (connection) => connection.name === trace.connection_name,
      )!
      prepared.traces[index] = {
        ...trace,
        curvedSegments: undefined,
        route: reduceOrdinaryTurns(
          trace.route,
          new VectorScene(prepared.input, connection, first.width, [
            ...fixed,
            ...prepared.traces.flatMap(routeCopper),
          ]),
        ).map((point) => ({
          ...point,
          route_type: "wire",
          layer: first.layer,
          width: first.width,
        })),
      }
    }
    prepared.traces = chamferOrdinaryCorners(
      prepared.input,
      prepared.traces,
      fixed,
    ).map((trace, index) =>
      !valid(trace, index) && valid(before[index], index)
        ? before[index]
        : trace,
    )
    if (
      prepared.traces.reduce((sum, trace) => sum + trace.route.length, 0) >
        maxVertices ||
      !prepared.traces.every(valid)
    )
      continue
    const copper = prepared.traces.map((trace, index) => [
      ...pair[index].escapeCopper,
      ...routeCopper(trace),
    ])
    if (conflicts.firstConflict(copper[0], copper[1], clearance - 1e-8))
      continue
    const routes = prepared.traces.map((trace) => trace.route as Wire[]) as [
      Wire[],
      Wire[],
    ]
    work.set(key, structuredClone(routes))
    return attach(routes)
  }
  return []
}
