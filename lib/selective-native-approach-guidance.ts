import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import { CopperConflictIndex } from "./copper-conflict-index"
import type { SimpleRouteJson, Trace } from "./types"
import type { Copper } from "./vector-scene"
import { fixedCopper, VectorScene, clearanceToCopper } from "./vector-scene"
import {
  validateRoutedCopperDrc,
  getCopperLayerNames,
} from "@tscircuit/fanout-solver"
import { signalWidth, signalDogboneOptions } from "./repair-bus-dogbones"
import { signalLayers, type FlexibleSignalState } from "./flexible-signal-state"
import type { SignalSiteDomainFailure } from "./negotiate-signal-sites"
import type { Connection, Terminal, Via, Wire } from "./types"
type NativeTerminal = Terminal & { port_selector?: string }
type OwnedWire = Wire & Partial<NativeTerminal>

export interface NativeApproachGuide {
  key: string
  mode: "wire" | "full"
  trace: Trace
}
export interface NativeApproachGuidanceLimits {
  maxSupportChecks?: number
  maxCandidateSearchNodes?: number
  /** Full physical capture; timing scope can omit immutable untimed nets. */
  physicalInput?: SimpleRouteJson
}
interface GeometryCheck {
  wireClear: boolean
  blockedViaLayers: string[]
}
interface EndpointProof {
  key: string
  end: number
  actual: GeometryCheck
  proposedMode: "wire" | "full"
  counterfactuals: Array<{
    removedOwnedPair: string[]
    proposedClears: boolean
  }>
  completeNativeSiteRepair?: Result
  selected?: boolean
}
export interface NativeApproachGuideProof {
  name?: string
  endpoints: EndpointProof[]
}

/** A manufactured owned approach stops at its coincident carrier handoff.
 * Supplied routes and later carrier copper cannot become transient guides. */
function ownedFullApproach(
  native: SimpleRouteJson,
  connection: Connection,
  pad: Connection["pointsToConnect"][number],
  originals: Trace[],
): Trace | undefined {
  const supplied = new Set(native.traces?.map((trace) => trace.pcb_trace_id))
  const matches = originals.filter((trace) => {
    const first = trace.route[0] as OwnedWire | undefined
    const nativePad = pad as NativeTerminal
    return (
      trace.connection_name === connection.name &&
      !supplied.has(trace.pcb_trace_id) &&
      trace.source_trace_id ===
        (connection.source_trace_id ?? connection.name) &&
      !!trace.pcb_trace_id &&
      first?.route_type === "wire" &&
      first.layer === pad.layer &&
      Math.hypot(first.x - pad.x, first.y - pad.y) < 1e-8 &&
      (!(first.pcb_port_id ?? first.pointId) ||
        !(nativePad.pcb_port_id ?? nativePad.pointId) ||
        (first.pcb_port_id ?? first.pointId) ===
          (nativePad.pcb_port_id ?? nativePad.pointId)) &&
      (!first.port_selector ||
        !nativePad.port_selector ||
        first.port_selector === nativePad.port_selector)
    )
  })
  if (
    matches.length !== 1 ||
    connection.pointsToConnect.filter(
      (point) =>
        point.layer === pad.layer &&
        Math.hypot(point.x - pad.x, point.y - pad.y) < 1e-8,
    ).length !== 1
  )
    return undefined
  const original = matches[0],
    width = signalWidth(native, connection)
  const manufactured = signalDogboneOptions(native, new Map())
  const land = manufactured.viaDiameter!,
    drill = manufactured.viaHoleDiameter!
  const viaIndex = original.route.findIndex(
    (point) => point.route_type === "via",
  )
  const via = original.route[viaIndex],
    before = original.route[viaIndex - 1],
    after = original.route[viaIndex + 1]
  const physical = getCopperLayerNames(native.layerCount)
  if (
    via?.route_type !== "via" ||
    before?.route_type !== "wire" ||
    after?.route_type !== "wire" ||
    original.route.length !== viaIndex + 2 ||
    original.route.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    ) ||
    via.from_layer !== pad.layer ||
    before.layer !== pad.layer ||
    after.layer !== via.to_layer ||
    via.from_layer === via.to_layer ||
    !physical.includes(via.to_layer) ||
    Math.hypot(before.x - via.x, before.y - via.y) > 1e-8 ||
    Math.hypot(after.x - via.x, after.y - via.y) > 1e-8 ||
    original.route.filter((point) => point.route_type === "via").length !== 1 ||
    !Number.isFinite(width) ||
    width <= 0 ||
    original.route
      .slice(0, viaIndex)
      .some(
        (point) =>
          point.route_type !== "wire" ||
          point.layer !== pad.layer ||
          !Number.isFinite(point.width) ||
          point.width <= 0 ||
          Math.abs(point.width - width) > 1e-8,
      ) ||
    !Number.isFinite(after.width) ||
    after.width <= 0 ||
    Math.abs(after.width - width) > 1e-8 ||
    !Number.isFinite(via.via_diameter) ||
    !Number.isFinite(via.via_hole_diameter) ||
    !Number.isFinite(land) ||
    !Number.isFinite(drill) ||
    via.via_diameter! <= 0 ||
    via.via_hole_diameter! <= 0 ||
    via.via_hole_diameter! > via.via_diameter! ||
    Math.abs(via.via_diameter! - land) > 1e-8 ||
    Math.abs(via.via_hole_diameter! - drill) > 1e-8 ||
    JSON.stringify(via.layers) !== JSON.stringify(physical)
  )
    return undefined
  return {
    ...original,
    route: original.route.slice(0, viaIndex + 2).map((point) => ({ ...point })),
    curvedSegments: undefined,
    coupledSection: undefined,
  }
}

/** Derive a preference from a completed unary failure or offered-site conflict.
 * Removing a selected pair is diagnostic only; native supplied copper remains
 * hard in every counterfactual. Every returned guide is original owned copper,
 * and a joint proposal must repair its finite escape-site contradiction core.
 * Limited offered domains do not establish physical native infeasibility. */
export function deriveSelectiveNativeApproachGuide(
  state: FlexibleSignalState,
  failure: SignalSiteDomainFailure,
  originals: Trace[],
  current: readonly NativeApproachGuide[],
  limits: NativeApproachGuidanceLimits = {},
): { guide?: NativeApproachGuide; proof: NativeApproachGuideProof } {
  const native = state.native
  const physical = limits.physicalInput ?? native
  const paired = new Set(
    native.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  const joint =
    failure.kind === "incompatible-offered-native-site-domains"
      ? failure
      : undefined
  const names = joint?.names ?? [
    failure.kind === "empty-native-site-domain" ? failure.connection.name : "",
  ]
  const proof: NativeApproachGuideProof = { endpoints: [] }
  const scopedNames = new Set(
    native.connections.map((connection) => connection.name),
  )
  const unscopedKeys = new Set([
    ...Object.keys(native),
    ...Object.keys(physical),
  ])
  for (const key of ["connections", "buses", "differentialPairs"])
    unscopedKeys.delete(key)
  if (
    [...unscopedKeys].some(
      (key) =>
        JSON.stringify(native[key as keyof SimpleRouteJson]) !==
        JSON.stringify(physical[key as keyof SimpleRouteJson]),
    ) ||
    native.connections.some(
      (connection) =>
        !physical.connections.some(
          (candidate) =>
            candidate.name === connection.name &&
            JSON.stringify(candidate) === JSON.stringify(connection),
        ),
    ) ||
    JSON.stringify(native.buses) !==
      JSON.stringify(
        physical.buses?.filter((bus) =>
          bus.connectionNames.every((name) => scopedNames.has(name)),
        ),
      ) ||
    JSON.stringify(native.differentialPairs) !==
      JSON.stringify(
        physical.differentialPairs?.filter((pair) =>
          pair.connectionNames.every((name) => scopedNames.has(name)),
        ),
      ) ||
    (failure.kind === "empty-native-site-domain" &&
      (failure.searchComplete !== true || failure.budgetUnknown !== false)) ||
    (joint &&
      (typeof joint.searchComplete !== "boolean" ||
        typeof joint.budgetUnknown !== "boolean" ||
        joint.searchComplete === joint.budgetUnknown))
  )
    return { proof }
  const generated = [...state.escapes, ...state.retained, ...state.traces]
  const clearance =
    native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  for (const name of names) {
    if (paired.has(name)) continue
    const connection = native.connections.find(
      (candidate) => candidate.name === name,
    )
    if (
      !connection ||
      (failure.kind === "empty-native-site-domain" &&
        JSON.stringify(connection) !== JSON.stringify(failure.connection))
    )
      continue
    proof.name = connection.name
    const width = signalWidth(native, connection)
    const base = {
      ...native,
      connections: [connection],
      traces: [...(native.traces ?? []), ...generated],
    }
    const checks = (
      input: SimpleRouteJson,
      head: Trace,
      via: Via,
    ): GeometryCheck => {
      const hard = fixedCopper(input)
      return {
        wireClear: new VectorScene(input, connection, width, hard).pathVisible(
          head.route,
        ),
        blockedViaLayers: via.layers!.filter(
          (layer) =>
            !new VectorScene(
              input,
              {
                ...connection,
                pointsToConnect: connection.pointsToConnect.map((point) => ({
                  ...point,
                  layer,
                })),
              },
              via.via_diameter!,
              hard,
            ).visible(via, via),
        ),
      }
    }
    for (let end = 0; end < connection.pointsToConnect.length; end++) {
      const pad = connection.pointsToConnect[end],
        full = ownedFullApproach(native, connection, pad, originals)
      if (!full) continue
      const viaIndex = full.route.findIndex(
          (point) => point.route_type === "via",
        ),
        via = full.route[viaIndex] as Via
      const head = { ...full, route: full.route.slice(0, viaIndex) }
      const key = JSON.stringify([
        connection.name,
        end,
        pad.layer,
        pad.x,
        pad.y,
      ])
      const actual = checks(base, head, via),
        mode = joint || actual.wireClear ? "full" : "wire"
      const entry: EndpointProof = {
        key,
        end,
        actual,
        proposedMode: mode,
        counterfactuals: [],
      }
      proof.endpoints.push(entry)
      if (actual.wireClear && !actual.blockedViaLayers.length) continue
      const existing = current.find((guide) => guide.key === key)
      if (existing?.mode === "full" || existing?.mode === mode) continue
      if (joint) {
        const domain = joint.domains.find(
          (candidate) => candidate.name === connection.name,
        )
        if (
          !domain ||
          joint.proof.kind !== "arc-consistency" ||
          joint.domains.length !==
            native.connections.filter(
              (candidate) => !paired.has(candidate.name),
            ).length
        )
          continue
        const carrierLayer = (full.route.at(-1) as Wire).layer
        if (!signalLayers(native, connection).includes(carrierLayer)) continue
        const repaired = domain.options.flatMap((option) => {
          // Substitution preserves a complete offered site: both approaches
          // must hand off to the same permitted carrier as the original.
          if (
            option.escapes.length !== connection.pointsToConnect.length ||
            option.escapes.some((escape) => {
              const handoff = escape.route.at(-1)
              return (
                handoff?.route_type !== "wire" || handoff.layer !== carrierLayer
              )
            })
          )
            return []
          const owned = option.escapes.filter((escape) => {
            const start = escape.route[0]
            return (
              escape.connection_name === connection.name &&
              start?.route_type === "wire" &&
              start.layer === pad.layer &&
              Math.hypot(start.x - pad.x, start.y - pad.y) < 1e-8
            )
          })
          if (owned.length !== 1) return []
          const escapes = option.escapes.map((escape) =>
            escape === owned[0] ? full : escape,
          )
          return [
            {
              escapes,
              escapeCopper: fixedCopper({
                ...native,
                obstacles: [],
                traces: escapes,
              }),
            },
          ]
        })
        if (!repaired.length) continue
        // Check the exact causal contradiction core. An independent failure
        // elsewhere must not veto a valid incremental repair of this core.
        // The event still preserves every original domain for provenance.
        const domains = new Map(
          joint.domains
            .filter((candidate) => joint.names.includes(candidate.name))
            .map((candidate) => [
              candidate.name,
              candidate.name === connection.name ? repaired : candidate.options,
            ]),
        )
        const repair = finiteSiteCompatibility(native, domains, {
          searchAssignment: true,
          maxChecks: limits.maxSupportChecks,
          maxNodes: limits.maxCandidateSearchNodes,
        })
        entry.completeNativeSiteRepair = repair
        if (repair.status !== "compatible-assignment") continue
      }
      let attributed = false
      for (const pair of native.differentialPairs ?? []) {
        const copper = fixedCopper({
          ...native,
          obstacles: [],
          traces: generated.filter((trace) =>
            pair.connectionNames.includes(trace.connection_name!),
          ),
        })
        const wireCollision = copper.some(
          (item) =>
            item.layer === pad.layer &&
            head.route
              .slice(1)
              .some(
                (point, index) =>
                  clearanceToCopper(head.route[index], point, item) <
                  width / 2 + clearance - 1e-8,
              ),
        )
        const landCollision = copper.some(
          (item) =>
            via.layers!.includes(item.layer) &&
            clearanceToCopper(via, via, item) <
              via.via_diameter! / 2 + clearance - 1e-8,
        )
        if (!(wireCollision || (mode === "full" && landCollision))) continue
        const reduced = {
          ...base,
          traces: [
            ...(native.traces ?? []),
            ...generated.filter(
              (trace) => !pair.connectionNames.includes(trace.connection_name!),
            ),
          ],
        }
        const after = checks(reduced, head, via),
          clears =
            after.wireClear &&
            (mode === "wire" || !after.blockedViaLayers.length)
        entry.counterfactuals.push({
          removedOwnedPair: pair.connectionNames,
          proposedClears: clears,
        })
        if (clears) attributed = true
      }
      if (!attributed) continue
      const proposed = mode === "wire" ? head : full
      const drc = validateRoutedCopperDrc({
        inputSrj: physical,
        routedSrj: {
          ...physical,
          traces: [
            ...(physical.traces ?? []),
            ...current
              .filter((guide) => guide.key !== key)
              .map((guide) => guide.trace),
            proposed,
          ],
        },
        clearance,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0])
      if (!drc.valid) continue
      entry.selected = true
      return { guide: { key, mode, trace: structuredClone(proposed) }, proof }
    }
  }
  return { proof }
}

export type Site = { escapes: Trace[]; escapeCopper: Copper[] }
export type NativeEscapeDomain = { name: string; options: Site[] }
type Limits = {
  maxChecks?: number
  maxNodes?: number
  alive?: () => boolean
  searchAssignment?: boolean
}
type Removal = {
  id: number
  name: string
  other: string
  before: number
  after: number
  removed: number[]
  support: number[]
  dependencies: number[]
}
type FiniteSiteFailure = {
  kind: "incompatible-finite-native-sites"
  proof: "arc-consistency"
  names: string[]
  domains: NativeEscapeDomain[]
  allOptionsExamined: true
  checks: number
  nodes: number
  removals: Removal[]
  implicatedRemovals: Removal[]
}
type Result =
  | { status: "incompatible"; failure: FiniteSiteFailure }
  | { status: "unknown"; checks: number; nodes: number }
  | { status: "arc-consistent"; checks: number; nodes: number }
  | {
      status: "compatible-assignment"
      checks: number
      nodes: number
      assignment: Array<{ name: string; option: number }>
    }

/** This finite CSP uses only offered native escapes, which may be a limited
 * site policy. No carrier path, candidate-route pool, or prior routing failure
 * participates. An interrupted scan returns unknown, never a contradiction. */
function finiteSiteCompatibility(
  native: SimpleRouteJson,
  variants: ReadonlyMap<string, Site[]>,
  limits: Limits = {},
): Result {
  const index = new CopperConflictIndex()
  const clearance =
    native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  const source = [...variants].map(([name, choices]) => {
    const shapes = new Set<string>()
    return {
      name,
      options: choices
        .filter((choice) => {
          const key = JSON.stringify(choice.escapes.map((trace) => trace.route))
          if (shapes.has(key)) return false
          shapes.add(key)
          return true
        })
        .map((choice) => ({
          escapes: choice.escapes,
          escapeCopper: choice.escapeCopper,
        })),
    }
  })
  const count = source.length,
    domains = source.map((domain) => domain.options.map((_, option) => option))
  // Completed zero domains have their own unary callback. A partial/empty map
  // does not prove the universal site CSP required by this observer.
  if (!count || domains.some((domain) => !domain.length))
    return { status: "unknown", checks: 0, nodes: 0 }
  const maxChecks = limits.maxChecks ?? 1_000_000,
    maxNodes = limits.maxNodes ?? 12_000
  if (
    !Number.isInteger(maxChecks) ||
    maxChecks < 1 ||
    !Number.isInteger(maxNodes) ||
    maxNodes < 1
  )
    throw Error("Finite support and node budgets must be positive integers")
  let checks = 0,
    nodes = 0
  const stopped = Symbol("finite-domain-budget")
  const guard = () => {
    if (limits.alive && !limits.alive()) throw stopped
  }
  const cache = new Map<string, boolean>()
  const compatible = (a: number, x: number, b: number, y: number) => {
    guard()
    const key = a < b ? `${a}:${x}:${b}:${y}` : `${b}:${y}:${a}:${x}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    if (++checks > maxChecks) throw stopped
    const first = source[a].options[x],
      second = source[b].options[y]
    const result =
      !generatedEscapeHolesConflict(native, first.escapes, second.escapes) &&
      !index.firstConflict(
        first.escapeCopper,
        second.escapeCopper,
        clearance - 1e-8,
      )
    cache.set(key, result)
    return result
  }
  const removals: Removal[] = [],
    removedBy = source.map((domain) => new Map<number, number>())
  const queue: Array<[number, number]> = [],
    queued = new Uint8Array(count * count)
  const enqueue = (a: number, b: number) => {
    const key = a * count + b
    if (a !== b && !queued[key]) {
      queued[key] = 1
      queue.push([a, b])
    }
  }
  for (let a = 0; a < count; a++) for (let b = 0; b < count; b++) enqueue(a, b)
  queue.sort((a, b) => domains[a[1]].length - domains[b[1]].length)
  try {
    for (let head = 0; head < queue.length; head++) {
      guard()
      const [a, b] = queue[head]
      queued[a * count + b] = 0
      const before = domains[a],
        support = domains[b],
        kept: number[] = [],
        removed: number[] = []
      for (const x of before)
        (support.some((y) => compatible(a, x, b, y)) ? kept : removed).push(x)
      if (!removed.length) continue
      const dependencies = new Set<number>()
      // Every original compatible support eliminated earlier contributes a
      // dependency. This retains the exact causal propagation chain.
      for (const x of removed)
        for (const [y, cause] of removedBy[b])
          if (compatible(a, x, b, y)) dependencies.add(cause)
      const removal: Removal = {
        id: removals.length,
        name: source[a].name,
        other: source[b].name,
        before: before.length,
        after: kept.length,
        removed,
        support: support.slice(),
        dependencies: [...dependencies],
      }
      removals.push(removal)
      for (const x of removed) removedBy[a].set(x, removal.id)
      domains[a] = kept
      if (!kept.length) {
        const causes = new Set<number>(),
          visit = (id: number) => {
            if (causes.has(id)) return
            causes.add(id)
            removals[id].dependencies.forEach(visit)
          }
        visit(removal.id)
        // The emptied variable's earlier eliminations also establish why its
        // original complete domain has no remaining option.
        for (const id of removedBy[a].values()) visit(id)
        const implicatedRemovals = [...causes]
          .sort((a, b) => a - b)
          .map((id) => removals[id])
        const names = [
          ...new Set(
            implicatedRemovals.flatMap((entry) => [entry.name, entry.other]),
          ),
        ]
        return {
          status: "incompatible",
          failure: {
            kind: "incompatible-finite-native-sites",
            proof: "arc-consistency",
            names,
            domains: source,
            allOptionsExamined: true,
            checks,
            nodes,
            removals,
            implicatedRemovals,
          },
        }
      }
      for (let other = 0; other < count; other++)
        if (other !== b) enqueue(other, a)
    }
    if (!limits.searchAssignment)
      return { status: "arc-consistent", checks, nodes }
    const assignments = new Map<number, number>()
    const search = (remaining: number[][]): boolean => {
      guard()
      if (assignments.size === count) return true
      if (++nodes > maxNodes) throw stopped
      let variable = -1
      for (let candidate = 0; candidate < count; candidate++)
        if (
          !assignments.has(candidate) &&
          (variable < 0 ||
            remaining[candidate].length < remaining[variable].length)
        )
          variable = candidate
      for (const option of remaining[variable]) {
        const narrowed = remaining.map((domain) => domain.slice())
        let feasible = true
        for (let other = 0; other < count; other++)
          if (other !== variable && !assignments.has(other)) {
            narrowed[other] = narrowed[other].filter((choice) =>
              compatible(variable, option, other, choice),
            )
            if (!narrowed[other].length) {
              feasible = false
              break
            }
          }
        if (!feasible) continue
        assignments.set(variable, option)
        if (search(narrowed)) return true
        assignments.delete(variable)
      }
      return false
    }
    if (search(domains))
      return {
        status: "compatible-assignment",
        checks,
        nodes,
        assignment: [...assignments].map(([variable, option]) => ({
          name: source[variable].name,
          option,
        })),
      }
    // Exhaustive search can prove unsatisfiable, but the guidance API accepts
    // only the separately auditable AC propagation certificate for now.
    return { status: "unknown", checks, nodes }
  } catch (error) {
    if (error !== stopped) throw error
    return { status: "unknown", checks, nodes }
  }
}
