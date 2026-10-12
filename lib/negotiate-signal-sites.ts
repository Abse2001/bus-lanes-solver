import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { routeAlternateSignalDogbones } from "./alternate-signal-dogbones"
import { CopperConflictIndex } from "./copper-conflict-index"
import {
  expandedSignalSiteChoices,
  generatedEscapeHolesConflict,
} from "./expanded-signal-sites"
import {
  type FlexibleSignalState,
  signalLayers,
  signalTrace,
} from "./flexible-signal-state"
import { distance, length } from "./geometry"
import { GridHistoryProjector, GridVisibilitySearch } from "./grid-visibility"
import {
  type CandidateDomainFailure,
  pruneCandidateDomains,
} from "./prune-candidate-domains"
import {
  ownedSignalEscapes,
  signalDogboneOptions,
  signalWidth,
} from "./repair-bus-dogbones"
import { retargetGeneratedEscape } from "./retarget-generated-escape"
import { RouteConflictIndex } from "./route-conflict-index"
import { maximumCarrierLength } from "./route-lengths"
import { solveSignalCandidatePool } from "./solve-signal-candidate-pool"
import type { Connection, Terminal, Trace, Wire } from "./types"
import {
  type Copper,
  fixedCopper,
  routeCopper,
  VectorScene,
} from "./vector-scene"

export type SignalSiteDomainFailure =
  | {
      kind: "empty-native-site-domain"
      connection: Connection
      /** The offered finite policy completed; it does not exhaust all copper. */
      searchComplete: true
      budgetUnknown: false
    }
  | {
      /** Heuristic contradiction of offered sites, never native infeasibility. */
      kind: "incompatible-offered-native-site-domains"
      /** False when any contributing site search exhausted its work budget. */
      searchComplete: boolean
      budgetUnknown: boolean
      names: string[]
      domains: Array<{
        name: string
        options: Array<{ escapes: Trace[]; escapeCopper: Copper[] }>
      }>
      proof: CandidateDomainFailure & { kind: "arc-consistency" }
    }

export interface DeferredCarrierExpansion {
  connectionName: string
  layer: string
}

interface SignalSiteOptions {
  allowExpandedSites?: boolean
  /** Widen only carrier layers with no reachable cheap site/carrier choice. */
  expandOnlyWhenBlocked?: boolean
  /** Try the cheap joint domains before widening an alternate carrier. */
  deferAlternateCarrierExpansion?: boolean
  /** Emitted only after all offered native-site domains have completed. */
  onDeferredCarrierExpansion?: (
    deferred?: readonly DeferredCarrierExpansion[],
  ) => void
  /** Fine native approaches are a failed-stage recovery, not a default bank. */
  allowFineNativeApproachRetry?: boolean
  /** Completed eligible precision deferrals; cancellation emits nothing. */
  onDeferredFineNativeApproachRetry?: () => void
  maxCandidateSearchNodes?: number
  retainExistingRoutes?: boolean
  /** Feedback concerns finite offered native sites, never carrier failures. */
  onSiteDomainFailure?: (failure: SignalSiteDomainFailure) => void
}

interface SiteOption {
  connection: Connection
  escapes: Trace[]
  escapeCopper: Copper[]
  scene: VectorScene
  layer: string
  length: number
  maxLength: number
}
interface Candidate extends SiteOption {
  id: number
  trace: Trace
  copper: Copper[]
  hits: Candidate[]
  score: number
}

/** Owned escapes declare their manufactured barrel and both layer handoffs.
 * An implicit span or a wire-only layer jump is not a physical route. */
function escapeHasValidHandoff(
  escape: Trace,
  physical: string[],
  allowBlindAndBuriedVias: boolean,
): boolean {
  const first = escape.route[0],
    last = escape.route.at(-1)
  if (first?.route_type !== "wire" || last?.route_type !== "wire") return false
  const viaIndexes = escape.route.flatMap((point, index) =>
    point.route_type === "via" ? [index] : [],
  )
  if (!viaIndexes.length)
    return escape.route.every(
      (point) => point.route_type === "wire" && point.layer === first.layer,
    )
  if (viaIndexes.length !== 1) return false
  const index = viaIndexes[0],
    via = escape.route[index]
  const before = escape.route[index - 1],
    after = escape.route[index + 1]
  if (
    via.route_type !== "via" ||
    before?.route_type !== "wire" ||
    after?.route_type !== "wire" ||
    first.layer === last.layer ||
    via.from_layer !== first.layer ||
    via.to_layer !== last.layer ||
    distance(before, via) > 1e-8 ||
    distance(after, via) > 1e-8 ||
    escape.route
      .slice(0, index)
      .some(
        (point) => point.route_type !== "wire" || point.layer !== first.layer,
      ) ||
    escape.route
      .slice(index + 1)
      .some(
        (point) => point.route_type !== "wire" || point.layer !== last.layer,
      ) ||
    !via.layers ||
    via.layers.some((layer) => !physical.includes(layer)) ||
    !via.layers.includes(via.from_layer) ||
    !via.layers.includes(via.to_layer) ||
    !Number.isFinite(via.via_diameter) ||
    via.via_diameter! <= 0 ||
    !Number.isFinite(via.via_hole_diameter) ||
    via.via_hole_diameter! <= 0 ||
    via.via_hole_diameter! > via.via_diameter!
  )
    return false
  const start = physical.indexOf(via.from_layer),
    end = physical.indexOf(via.to_layer)
  const required = allowBlindAndBuriedVias
    ? physical.slice(Math.min(start, end), Math.max(start, end) + 1)
    : physical
  return required.every((layer) => via.layers!.includes(layer))
}

/** Existing owned sites can be absent from the bounded fresh-site domain.
 * Keep the site when its physical dogbones remain valid, and separately keep
 * the original carrier only when it also clears the newly fixed copper. */
function existingSignalSite(
  base: FlexibleSignalState["native"],
  native: FlexibleSignalState["native"],
  connection: Connection,
  trace: Trace | undefined,
  escapes: Trace[],
  hard: Copper[],
): { option: SiteOption; trace?: Trace } | undefined {
  if (!trace || trace.route.length < 2) return
  const first = trace.route[0]
  if (first.route_type !== "wire") return
  const layer = first.layer,
    width = signalWidth(native, connection)
  if (
    !signalLayers(native, connection).includes(layer) ||
    trace.route.some(
      (point) =>
        point.route_type !== "wire" ||
        point.layer !== layer ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !Number.isFinite(point.width) ||
        Math.abs(point.width - width) > 1e-8,
    )
  )
    return
  const ends = [trace.route[0], trace.route.at(-1)!] as Wire[]
  const attached = new Set<Trace>()
  for (let end = 0; end < 2; end++) {
    const pad = connection.pointsToConnect[end],
      point = ends[end]
    const escape = escapes.find((candidate) => {
      const start = candidate.route[0],
        last = candidate.route.at(-1)
      return (
        start?.route_type === "wire" &&
        start.layer === pad.layer &&
        distance(start, pad) < 1e-8 &&
        last?.route_type === "wire" &&
        last.layer === layer &&
        distance(last, point) < 1e-8
      )
    })
    if (escape) attached.add(escape)
    else if (point.layer !== pad.layer || distance(point, pad) > 1e-8) return
  }
  if (escapes.some((escape) => !attached.has(escape))) return
  const physical = getCopperLayerNames(native.layerCount)
  if (
    escapes.some(
      (escape) =>
        !escapeHasValidHandoff(
          escape,
          physical,
          native.allowBlindAndBuriedVias ?? false,
        ),
    )
  )
    return
  if (
    escapes.some((escape) =>
      escape.route.some(
        (point) =>
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          (point.route_type === "wire"
            ? !physical.includes(point.layer) ||
              !Number.isFinite(point.width) ||
              point.width <= 0
            : !physical.includes(point.from_layer) ||
              !physical.includes(point.to_layer) ||
              (!native.allowBlindAndBuriedVias &&
                point.layers !== undefined &&
                physical.some((carrier) => !point.layers!.includes(carrier)))),
      ),
    )
  )
    return
  if (
    escapes.some((escape, index) =>
      generatedEscapeHolesConflict(native, [escape], escapes.slice(index + 1)),
    ) ||
    generatedEscapeHolesConflict(native, escapes, base.traces ?? [])
  )
    return
  const local = {
    ...connection,
    pointsToConnect: ends.map((point, end) => ({
      ...connection.pointsToConnect[end],
      ...point,
    })),
  }
  const scene = new VectorScene(base, local, width, hard)
  const escapeCopper = fixedCopper({ ...base, obstacles: [], traces: escapes })
  const otherCopper = hard.filter(
    (copper) => !copper.owners.some((owner) => scene.owners.has(owner)),
  )
  const clearance =
    native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  if (
    new CopperConflictIndex().firstConflict(
      escapeCopper,
      otherCopper,
      clearance - 1e-8,
    )
  )
    return
  const bounds = base.bounds
  if (
    escapeCopper.some((copper) =>
      [copper.a, copper.b].some((point) => {
        const margin = copper.radius + (base.minBoardEdgeClearance ?? 0)
        return (
          point.x < bounds.minX + margin - 1e-9 ||
          point.x > bounds.maxX - margin + 1e-9 ||
          point.y < bounds.minY + margin - 1e-9 ||
          point.y > bounds.maxY - margin + 1e-9
        )
      }),
    )
  )
    return
  const maxLength = maximumCarrierLength(
    { ...native, traces: [...(native.traces ?? []), ...escapes] },
    connection.name,
  )
  if (distance(ends[0], ends[1]) > maxLength + 1e-8) return
  const option: SiteOption = {
    connection: local,
    escapes,
    escapeCopper,
    scene,
    layer,
    length: length(trace.route),
    maxLength,
  }
  return {
    option,
    trace:
      length(trace.route) <= maxLength + 1e-8 && scene.pathVisible(trace.route)
        ? trace
        : undefined,
  }
}

/** Negotiate dogbone sites and signal layers as one atomic route choice. Via
 * barrels participate on every spanned layer, even when carriers use different
 * planes. Only this bounded pocket is movable; all other copper stays fixed. */
export function* negotiateSignalSites(
  state: FlexibleSignalState,
  remove: ReadonlySet<string>,
  stopWithOneRemaining = false,
  expandNonNativeSites = false,
  options: SignalSiteOptions = {},
): Generator<void, FlexibleSignalState | null> {
  if (!remove.size) return null
  const { native } = state
  const all = [...state.retained, ...state.traces]
  const stable = all.filter((trace) => !remove.has(trace.connection_name!))
  const fixedEscapes = state.escapes.filter(
    (trace) => !remove.has(trace.connection_name!),
  )
  const targets = new Map<string, string>([
    ...state.pending.connections.map((c): [string, string] => [
      c.name,
      c.pointsToConnect[0].layer,
    ]),
    ...all.map((t): [string, string] => [
      t.connection_name!,
      (t.route[0] as Wire).layer,
    ]),
  ])
  const base = {
    ...native,
    connections: native.connections.filter((c) => remove.has(c.name)),
    traces: [...(native.traces ?? []), ...fixedEscapes, ...stable],
  }
  if (!base.connections.length) return null
  const hard = fixedCopper(base),
    variants = new Map<string, SiteOption[]>()
  const existing = new Map<string, { option: SiteOption; trace?: Trace }>()
  const histories = new Map<string, Float32Array>(),
    projectors = new Map<string, GridHistoryProjector>()
  const clearance =
    native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  const deferredCarrierExpansions: DeferredCarrierExpansion[] = []
  const deferredCarrierExpansionKeys = new Set<string>()
  let deferredFineNativeApproachRetry = false
  let nativeSiteSearchIncomplete = false
  for (const connection of base.connections) {
    const previous = options.retainExistingRoutes
      ? existingSignalSite(
          base,
          native,
          connection,
          all.find((trace) => trace.connection_name === connection.name),
          state.escapes.filter(
            (escape) => escape.connection_name === connection.name,
          ),
          hard,
        )
      : undefined
    if (previous) existing.set(connection.name, previous)
    // Surface carriers still need an adjacent site candidate. Generate the
    // local site on another physical layer, then collapse its owned via for
    // a surface route; supplied traces remain untouched.
    const target = targets.get(connection.name)
    const nativeLayers = connection.pointsToConnect.map((point) => point.layer)
    if (target && nativeLayers.every((layer) => layer === target)) {
      const alternative = [
        ...signalLayers(native, connection),
        ...getCopperLayerNames(native.layerCount),
      ].find((layer) => !nativeLayers.includes(layer))
      if (alternative) targets.set(connection.name, alternative)
    }
    const single = { ...base, connections: [connection] },
      ends: Array<Array<{ point: Terminal; escape: Trace }>> = [[], []]
    const carrierLayers = signalLayers(native, connection)
    for (let end = 0; end < 2; end++) {
      const point = connection.pointsToConnect[end]
      if (carrierLayers.includes(point.layer))
        ends[end].push({
          point,
          escape: {
            type: "pcb_trace",
            pcb_trace_id: `local_surface_${connection.name}_${end}`,
            connection_name: connection.name,
            source_trace_id: connection.source_trace_id ?? connection.name,
            route: [
              {
                ...point,
                route_type: "wire",
                layer: point.layer,
                width: signalWidth(native, connection),
              },
            ],
          },
        })
    }
    for (let variant = 0; variant < 4; variant++) {
      try {
        const generated = routeAlternateSignalDogbones(
          single,
          signalDogboneOptions(single, targets),
          variant,
        )
        for (let end = 0; end < 2; end++) {
          const point = generated.connections[0].pointsToConnect[
            end
          ] as Terminal
          if (
            ends[end].some(
              (site) =>
                Math.hypot(site.point.x - point.x, site.point.y - point.y) <
                1e-6,
            )
          )
            continue
          const escape = ownedSignalEscapes(native, generated.traces).find(
            (t) =>
              Math.hypot(
                t.route[0].x - connection.pointsToConnect[end].x,
                t.route[0].y - connection.pointsToConnect[end].y,
              ) < 1e-6,
          )
          if (escape) ends[end].push({ point, escape })
        }
      } catch {
        /* The other quadrants remain independent candidates. */
      }
      yield
    }
    const choices: SiteOption[] = previous ? [previous.option] : []
    let siteSearchIncomplete = false
    let connectionDeferredFineNativeApproachRetry = false
    // A cached physical site can survive after its carrier becomes blocked.
    // Only a reachable carrier may suppress the blocked-only fallback.
    const reachableLocalCarriers = new Set(
      previous?.trace ? [previous.option.layer] : [],
    )
    for (const a of ends[0])
      for (const b of ends[1])
        for (const layer of signalLayers(native, connection)) {
          const local = {
            ...connection,
            pointsToConnect: [a.point, b.point].map((point) => ({
              ...point,
              layer,
            })),
          }
          const generatedEscapes = [a.escape, b.escape]
          if (
            generatedEscapes.some(
              (t) =>
                !t.route.some(
                  (p) => p.route_type === "via" && p.layers?.includes(layer),
                ) &&
                !t.route.every(
                  (p) => p.route_type === "wire" && p.layer === layer,
                ),
            )
          )
            continue
          const escapes = generatedEscapes.map((trace) =>
            retargetGeneratedEscape(trace, layer),
          )
          if (
            generatedEscapeHolesConflict(native, [escapes[0]], [escapes[1]]) ||
            generatedEscapeHolesConflict(native, escapes, base.traces)
          )
            continue
          const maxLength = maximumCarrierLength(
            { ...native, traces: [...(native.traces ?? []), ...escapes] },
            connection.name,
          )
          const escapeCopper = fixedCopper({
            ...base,
            obstacles: [],
            traces: escapes,
          })
          const scene = new VectorScene(
            base,
            local,
            signalWidth(native, connection),
            hard,
          )
          const search = new GridVisibilitySearch(
            scene,
            local.pointsToConnect[0],
            local.pointsToConnect[1],
            [],
            0,
            undefined,
            { checkReachability: true, maxLength },
          )
          try {
            let steps = 0
            while (!search.solved && !search.failed && steps++ < 3000) {
              search.step()
              yield
            }
            if (search.solved) {
              reachableLocalCarriers.add(layer)
              choices.push({
                connection: local,
                escapes,
                escapeCopper,
                scene,
                layer,
                length: length(search.result),
                maxLength,
              })
            } else if (!search.failed) siteSearchIncomplete = true
          } finally {
            search.cancel()
          }
        }
    for (const layer of carrierLayers) {
      if (
        options.allowExpandedSites === false ||
        (options.expandOnlyWhenBlocked && reachableLocalCarriers.has(layer)) ||
        !connection.pointsToConnect.every((point) =>
          native.allowedLayers?.includes(point.layer),
        ) ||
        connection.pointsToConnect.every((point) => point.layer === layer) ||
        (!expandNonNativeSites &&
          !options.expandOnlyWhenBlocked &&
          choices.some((choice) => choice.layer === layer))
      )
        continue
      if (
        options.deferAlternateCarrierExpansion &&
        !reachableLocalCarriers.has(layer) &&
        reachableLocalCarriers.size > 0
      ) {
        const key = JSON.stringify([connection.name, layer])
        if (!deferredCarrierExpansionKeys.has(key)) {
          deferredCarrierExpansionKeys.add(key)
          deferredCarrierExpansions.push({
            connectionName: connection.name,
            layer,
          })
        }
        continue
      }
      const expanded = yield* expandedSignalSiteChoices(
        single,
        connection,
        layer,
        8,
        {
          allowFineNativeApproachRetry: options.allowFineNativeApproachRetry,
          onDeferredFineNativeApproachRetry: () => {
            connectionDeferredFineNativeApproachRetry = true
          },
          onSearchIncomplete: () => {
            siteSearchIncomplete = true
          },
        },
      )
      for (const option of expanded) {
        const maxLength = maximumCarrierLength(
          { ...native, traces: [...(native.traces ?? []), ...option.escapes] },
          connection.name,
        )
        if (length(option.route) > maxLength + 1e-8) continue
        choices.push({
          connection: option.connection,
          escapes: option.escapes,
          escapeCopper: fixedCopper({
            ...base,
            obstacles: [],
            traces: option.escapes,
          }),
          scene: new VectorScene(
            base,
            option.connection,
            signalWidth(native, connection),
            hard,
          ),
          layer,
          length: length(option.route),
          maxLength,
        })
      }
    }
    choices.sort((a, b) => a.length - b.length)
    if (!choices.length) {
      // Another connection's precision cannot repair this independent empty
      // bank. Retry only if this failed connection itself omitted fine sites.
      if (connectionDeferredFineNativeApproachRetry)
        options.onDeferredFineNativeApproachRetry?.()
      if (!siteSearchIncomplete)
        options.onSiteDomainFailure?.({
          kind: "empty-native-site-domain",
          connection,
          searchComplete: true,
          budgetUnknown: false,
        })
      return null
    }
    nativeSiteSearchIncomplete ||= siteSearchIncomplete
    deferredFineNativeApproachRetry ||=
      connectionDeferredFineNativeApproachRetry
    variants.set(connection.name, choices)
  }
  if (deferredCarrierExpansions.length)
    options.onDeferredCarrierExpansion?.(deferredCarrierExpansions)
  if (deferredFineNativeApproachRetry)
    options.onDeferredFineNativeApproachRetry?.()
  if (options.onSiteDomainFailure) {
    const domains = [...variants].map(([name, choices]) => ({
      name,
      options: choices.map(({ escapes, escapeCopper }) => ({
        escapes,
        escapeCopper,
      })),
    }))
    const index = new CopperConflictIndex()
    const compatible = (a: SiteOption, b: SiteOption) =>
      !generatedEscapeHolesConflict(native, a.escapes, b.escapes) &&
      !index.firstConflict(a.escapeCopper, b.escapeCopper, clearance - 1e-8)
    const remaining = pruneCandidateDomains(
      [...variants.values()],
      compatible,
      1_000_000,
      (failure) => {
        const names = [
          ...new Set(
            failure.implicatedRemovals.flatMap(({ first, second }) => [
              domains[first].name,
              domains[second].name,
            ]),
          ),
        ]
        options.onSiteDomainFailure!({
          kind: "incompatible-offered-native-site-domains",
          searchComplete: !nativeSiteSearchIncomplete,
          budgetUnknown: nativeSiteSearchIncomplete,
          names,
          domains,
          proof: { kind: "arc-consistency", ...failure },
        })
      },
    )
    if (!remaining) return null
    if (!stopWithOneRemaining) {
      // These survivors preserve the offered order and references. A removed
      // native site cannot extend a complete assignment of the current bank;
      // rerouting its carrier cannot restore its missing physical support.
      // Partial seeds may omit that conflicting connection, so keep their
      // established choice bank. No result is cached across fresh attempts.
      for (const [index, name] of [...variants.keys()].entries()) {
        const surviving = remaining[index]
        variants.set(name, surviving)
        const previous = existing.get(name)
        if (previous && !surviving.includes(previous.option))
          existing.delete(name)
      }
    }
  }
  const copperConflicts = new CopperConflictIndex()
  const overlap = (a: Copper[], b: Copper[]) =>
    copperConflicts.firstConflict(a, b, clearance - 1e-8)
  const conflicts = new RouteConflictIndex(),
    pools = new Map<string, Candidate[]>(),
    signatures = new Map<string, Set<string>>(),
    compatibility = new Map<string, boolean>()
  let candidateId = 0
  const compatible = (a: Candidate, b: Candidate) => {
    const key = a.id < b.id ? `${a.id},${b.id}` : `${b.id},${a.id}`
    const cached = compatibility.get(key)
    if (cached !== undefined) return cached
    const required =
      ((a.trace.route[0] as Wire).width + (b.trace.route[0] as Wire).width) /
        2 +
      clearance
    const clash =
      (a.layer === b.layer &&
        conflicts.firstConflict(
          a.trace.route,
          b.trace.route,
          required - 1e-8,
        )) ||
      overlap(a.escapeCopper, b.copper) ||
      overlap(b.escapeCopper, a.copper) ||
      generatedEscapeHolesConflict(native, a.escapes, b.escapes)
    compatibility.set(key, !clash)
    return !clash
  }
  const addCandidate = (candidate: Candidate) => {
    const name = candidate.connection.name,
      key = JSON.stringify([
        candidate.escapes.map((t) => t.route),
        candidate.trace.route,
      ])
    let seen = signatures.get(name)
    if (!seen) signatures.set(name, (seen = new Set()))
    if (seen.has(key)) return
    seen.add(key)
    let pool = pools.get(name)
    if (!pool) pools.set(name, (pool = []))
    pool.push(candidate)
    if (pool.length > 48) {
      const [evicted] = pool.splice(8, 1)
      seen.delete(
        JSON.stringify([
          evicted.escapes.map((trace) => trace.route),
          evicted.trace.route,
        ]),
      )
    }
  }
  const select = (): Candidate[] | undefined => {
    if (base.connections.some((c) => !pools.get(c.name)?.length)) return
    return (
      solveSignalCandidatePool(
        base.connections.map((c) => [...pools.get(c.name)!].reverse()),
        compatible,
        options.maxCandidateSearchNodes ?? 4000,
      ) ?? undefined
    )
  }

  const routed = new Map<string, Candidate>()
  for (const connection of base.connections) {
    const previous = existing.get(connection.name)
    if (!previous?.trace) continue
    const candidate: Candidate = {
      ...previous.option,
      id: candidateId++,
      trace: previous.trace,
      copper: [...previous.option.escapeCopper, ...routeCopper(previous.trace)],
      hits: [],
      score: length(previous.trace.route),
    }
    addCandidate(candidate)
    if ([...routed.values()].every((other) => compatible(candidate, other)))
      routed.set(connection.name, candidate)
  }
  const queue = base.connections
      .filter((connection) => !routed.has(connection.name))
      .sort(
        (a, b) => variants.get(a.name)!.length - variants.get(b.name)!.length,
      ),
    visits = new Map<string, number>()
  const finish = (): FlexibleSignalState => {
    const chosen = [...routed.values()],
      escapes = [...fixedEscapes, ...chosen.flatMap((option) => option.escapes)]
    const connections = base.connections.map(
      (c) =>
        routed.get(c.name)?.connection ?? variants.get(c.name)![0].connection,
    )
    return {
      native,
      pending: {
        ...base,
        connections,
        traces: [...(native.traces ?? []), ...escapes, ...stable],
      },
      escapes,
      retained: stable,
      traces: chosen.map((option) => option.trace),
    }
  }
  if (!queue.length) return finish()
  for (let iteration = 0; queue.length && iteration < 1200; iteration++) {
    const connection = queue.shift()!,
      choices = variants.get(connection.name)!,
      visit = visits.get(connection.name) ?? 0
    visits.set(connection.name, visit + 1)
    routed.delete(connection.name)
    const others = [...routed.values()],
      soft = others.flatMap((option) => option.copper)
    let best: Candidate | undefined
    for (let k = 0; k < Math.min(choices.length, 4); k++) {
      const option = choices[(visit * 4 + k) % choices.length],
        { scene, connection: local, layer } = option
      // The terminal dogbones are fixed for this option. Each conflicting
      // route must be displaced regardless of the carrier path. Together with
      // straight-line distance this is a conservative score lower bound; skip
      // searches that cannot beat the incumbent. Full repairs still collect
      // every alternative for the compatibility pool.
      if (stopWithOneRemaining && best) {
        const [a, b] = local.pointsToConnect
        const forcedHits = others.filter(
          (other) =>
            overlap(option.escapeCopper, other.copper) ||
            generatedEscapeHolesConflict(native, option.escapes, other.escapes),
        ).length
        if (
          Math.hypot(a.x - b.x, a.y - b.y) + 100 * forcedHits >
          best.score + 1e-7
        )
          continue
      }
      if (!projectors.has(layer)) {
        const projector = new GridHistoryProjector(scene)
        projectors.set(layer, projector)
        histories.set(layer, new Float32Array(projector.cellCount))
      }
      const search = new GridVisibilitySearch(
        scene,
        local.pointsToConnect[0],
        local.pointsToConnect[1],
        soft,
        10 + iteration,
        histories.get(layer),
        {
          checkReachability: true,
          maxLength: option.maxLength,
          paretoLength: Number.isFinite(option.maxLength),
        },
      )
      try {
        let steps = 0
        while (!search.solved && !search.failed && steps++ < 3000) {
          search.step()
          yield
        }
        if (search.solved) {
          const trace = signalTrace(native, connection, search.result, layer),
            copper = [...option.escapeCopper, ...routeCopper(trace)]
          const hits = others.filter(
              (other) =>
                overlap(copper, other.copper) ||
                generatedEscapeHolesConflict(
                  native,
                  option.escapes,
                  other.escapes,
                ),
            ),
            score = length(trace.route) + hits.length * 100
          const candidate = {
            ...option,
            id: candidateId++,
            trace,
            copper,
            hits,
            score,
          }
          if (!stopWithOneRemaining) addCandidate(candidate)
          if (!best || score < best.score) best = candidate
        }
      } finally {
        search.cancel()
      }
    }
    if (!best) {
      queue.push(connection)
      continue
    }
    for (const other of best.hits) {
      const hit = overlap(best.copper, other.copper)
      if (hit) {
        const [a, b] = hit
        projectors
          .get(a.layer)
          ?.penalizeIntersection(
            histories.get(a.layer)!,
            a.a,
            a.b,
            b.a,
            b.b,
            a.radius + b.radius + clearance,
            true,
          )
      }
      routed.delete(other.connection.name)
      if (!queue.some((c) => c.name === other.connection.name))
        queue.push(
          base.connections.find((c) => c.name === other.connection.name)!,
        )
    }
    routed.set(connection.name, best)
    if (stopWithOneRemaining && routed.size >= base.connections.length - 1)
      return finish()
    if (!stopWithOneRemaining && iteration % 8 === 0) {
      const selected = select()
      if (selected) {
        for (const option of selected)
          routed.set(option.connection.name, option)
        queue.length = 0
      }
    }
    yield
  }
  return routed.size === base.connections.length ? finish() : null
}
