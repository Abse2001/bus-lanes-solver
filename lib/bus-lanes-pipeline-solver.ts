import { routeSharedLayerBuses } from "./route-shared-layer-buses"
import { simplifyMatchedTraces } from "./simplify-matched-traces"
import { routeBackwardPackageBuses } from "./route-backward-package-buses"
import type { RepairedBusDogbones } from "./repair-bus-dogbones"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { shortenPairApproaches } from "./shorten-pair-approaches"
import { busLengthReports } from "./route-lengths"
import { extendPackageCoupling } from "./extend-package-coupling"
import { routeAlternateSignalDogbones } from "./alternate-signal-dogbones"
import { backwardFacingPackageTerminals } from "./backward-facing-package-terminals"
import { isUnroutedComponentPad } from "./is-unrouted-component-pad"
import {
  rematchTrappedSignalDogbones,
  type RematchedSignalDogbones,
} from "./rematch-trapped-signal-dogbones"
import { BaseSolver } from "@tscircuit/solver-utils"
import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { BusLanesSolver } from "./bus-lanes-solver"
import type { SimpleRouteJson, SolverOptions, Trace } from "./types"

export interface BusLanesPipelineOptions extends SolverOptions {
  fanout?: "auto" | "none"
}

/** Board-world points in mm, +X right, +Y up. Adds only local terminal vias;
 * the interconnect solver retains its strict fixed-layer contract. */
export class BusLanesPipelineSolver extends BaseSolver {
  readonly input: SimpleRouteJson
  readonly options: BusLanesPipelineOptions
  phase = "resolve_layers"
  traces: Trace[] = []
  failureCode: string | null = null
  private sharedPackages?: Generator<void, RepairedBusDogbones | null>
  private backwardPackages?: Generator<void, RepairedBusDogbones | null>
  private child?: BusLanesSolver
  private escapes: Trace[] = []
  private attempt = 0
  private completedLanes: Trace[] = []
  private remainingInput?: SimpleRouteJson
  private followingInput?: SimpleRouteJson
  private siteRematch?: Generator<void, RematchedSignalDogbones>
  private packageCoupling?: Generator<void, Trace[]>
  private terminalLayers = new Map<string, string[]>()
  constructor(input: SimpleRouteJson, options: BusLanesPipelineOptions = {}) {
    super()
    this.input = structuredClone(input)
    this.options = { smoothTuning: true, denseSearch: true, ...options }
    this.MAX_ITERATIONS =
      (options.maxSearchIterations ?? 200000) * Math.max(1, input.layerCount)
  }
  getConstructorParams() {
    return [this.input, this.options]
  }
  getOutput() {
    if (!this.solved)
      throw Error(this.error ?? "Bus lane pipeline is not solved")
    return {
      ...this.input,
      traces: [...(this.input.traces ?? []), ...this.traces],
    }
  }
  tryFinalAcceptance() {
    this.sharedPackages?.return(null)
    this.sharedPackages = undefined
    this.backwardPackages?.return(null)
    this.backwardPackages = undefined
    this.packageCoupling?.return([])
    this.packageCoupling = undefined
    this.siteRematch?.return({ connections: [], escapes: [] })
    this.siteRematch = undefined
    this.child?.tryFinalAcceptance()
    this.failureCode = "search_budget_exhausted"
    this.traces = []
  }
  private childOptions(reserveForControls = false): BusLanesPipelineOptions {
    const remaining = Math.max(1, this.MAX_ITERATIONS - this.iterations)
    const reserve = reserveForControls
      ? Math.min(200000, Math.floor(remaining / 4))
      : 0
    return {
      ...this.options,
      // Keep the aggregate pipeline budget. Restarting a dense bus at the
      // old per-layer cutoff discards compatible computed alternatives just
      // before they converge. Unconstrained controls retain a work reserve.
      maxSearchIterations:
        this.options.maxSearchIterations ?? Math.max(1, remaining - reserve),
    }
  }
  private *finishPackageCoupling(
    input: SimpleRouteJson,
    lanes: Trace[],
  ): Generator<void, Trace[]> {
    let refined = yield* extendPackageCoupling(input, lanes)
    if (exteriorPairSpacingReports(input, refined).every((r) => r.matched))
      return refined
    refined = yield* extendPackageCoupling(
      input,
      shortenPairApproaches(input, refined),
      { preserveMatching: false },
    )
    if (exteriorPairSpacingReports(input, refined).some((r) => !r.matched))
      throw Error(
        "Pair approaches still separate outside native package fanouts",
      )
    const matcher = BusLanesSolver.forRefinement(input, refined, this.options)
    try {
      while (!matcher.solved && !matcher.failed) {
        matcher.step()
        yield
      }
      if (!matcher.solved)
        throw Error(matcher.error ?? "Package approach length matching failed")
      const ceilings = new Map(
        busLengthReports(input, lanes).map((b) => [
          b.busId,
          Math.max(
            ...b.lengths.map(
              (l) => l.totalLengthMm ?? Number.POSITIVE_INFINITY,
            ),
          ),
        ]),
      )
      if (
        busLengthReports(input, matcher.traces).some(
          (b) =>
            Math.max(
              ...b.lengths.map(
                (l) => l.totalLengthMm ?? Number.POSITIVE_INFINITY,
              ),
            ) >
            ceilings.get(b.busId)! + 1e-6,
        )
      )
        throw Error("Package refinement increased the bus length target")
      if (
        exteriorPairSpacingReports(input, matcher.traces).some(
          (r) => !r.matched,
        )
      )
        throw Error("Package approach matching separated the pair")
      return matcher.traces
    } finally {
      if (!matcher.solved && !matcher.failed) matcher.tryFinalAcceptance()
    }
  }
  private prepare() {
    if (this.options.fanout === "none") {
      this.child = new BusLanesSolver(this.input, this.options)
      return
    }
    const physicalLayers = getCopperLayerNames(this.input.layerCount)
    if (
      this.input.allowedLayers?.some((layer) => !physicalLayers.includes(layer))
    )
      throw Error("Allowed signal layer is not in the physical stack")
    const layers = physicalLayers.filter(
      (layer) =>
        !this.input.allowedLayers || this.input.allowedLayers.includes(layer),
    )
    if (!layers.length) throw Error("No allowed signal layers")
    const groups = this.input.connections.map((c) => new Set([c.name]))
    for (const members of [
      ...(this.input.buses ?? []).map((b) => b.connectionNames),
      ...(this.input.differentialPairs ?? []).map((p) => p.connectionNames),
    ]) {
      const related = groups.filter((g) => members.some((n) => g.has(n)))
      if (members.some((n) => !related.some((g) => g.has(n))))
        throw Error("Unknown bus or differential pair member")
      const merged = new Set(related.flatMap((g) => [...g]))
      for (const group of related) groups.splice(groups.indexOf(group), 1)
      groups.push(merged)
    }
    groups.sort((a, b) => b.size - a.size)
    const load = new Map(layers.map((l) => [l, 0]))
    const targets = new Map<string, string>()
    for (const group of groups) {
      const buses = (this.input.buses ?? []).filter((b) =>
        b.connectionNames.some((n) => group.has(n)),
      )
      const members = this.input.connections.filter((c) => group.has(c.name))
      const allowed = layers.filter(
        (layer) =>
          buses.every(
            (b) => !b.allowedLayers || b.allowedLayers.includes(layer),
          ) &&
          members.every((connection) =>
            connection.pointsToConnect.every(
              (point) =>
                (point.layers ?? [point.layer]).includes(layer) ||
                isUnroutedComponentPad(this.input, connection, point),
            ),
          ),
      )
      if (!allowed.length)
        throw Error(
          "Bus/pair has no common allowed signal layer; existing fanout handoffs cannot be dogboned again",
        )
      const preferred = buses
        .flatMap((b) => [b.preferredLayer, ...(b.preferredLayers ?? [])])
        .filter((l): l is string => !!l)
      const countVias = (l: string) =>
        members
          .flatMap((c) => c.pointsToConnect)
          .filter((p) => !(p.layers ?? [p.layer]).includes(l)).length
      const rank = (l: string) =>
        preferred.includes(l) ? preferred.indexOf(l) : preferred.length
      const layerCost = new Map(
        allowed.map((layer) => [
          layer,
          countVias(layer) +
            this.input.obstacles.filter(
              (o) => o.componentId && o.layers.includes(layer),
            ).length /
              8,
        ]),
      )
      const retryOrder = new Map(
        allowed.map((layer) => {
          const peers = allowed.filter(
            (other) =>
              rank(other) === rank(layer) &&
              layerCost.get(other) === layerCost.get(layer),
          )
          return [
            layer,
            (peers.indexOf(layer) -
              (this.attempt % peers.length) +
              peers.length) %
              peers.length,
          ]
        }),
      )
      allowed.sort((a, b) => {
        // Prefer explicit signal-layer intent, then balance via count against
        // pad-field congestion. Empty compatible layers retain zero-via routes.
        const via = layerCost.get(a)! - layerCost.get(b)!
        const crossingCost = (layer: string) => {
          const cross = (
            p: { x: number; y: number },
            q: { x: number; y: number },
            r: { x: number; y: number },
          ) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
          let crossings = 0
          for (const member of members)
            for (const other of this.input.connections) {
              if (targets.get(other.name) !== layer) continue
              const [p, q] = member.pointsToConnect,
                [r, s] = other.pointsToConnect
              if (
                cross(p, q, r) * cross(p, q, s) < 0 &&
                cross(r, s, p) * cross(r, s, q) < 0
              )
                crossings++
            }
          return crossings * (this.attempt === 1 ? 0 : 4) + load.get(layer)!
        }
        return (
          rank(a) - rank(b) ||
          via ||
          crossingCost(a) - crossingCost(b) ||
          retryOrder.get(a)! - retryOrder.get(b)!
        )
      })
      // Reconsider equally good layers without discarding load balancing.
      // Selecting the second-ranked layer for every group puts independent
      // buses onto the same crowded layer instead of exploring an alternative.
      const target = allowed[0]
      for (const name of group) targets.set(name, target)
      load.set(target, load.get(target)! + group.size)
    }
    const widths = this.input.connections.map(
      (c) =>
        (this.input.buses ?? []).find((b) => b.connectionNames.includes(c.name))
          ?.traceWidth ??
        c.nominalTraceWidth ??
        c.width ??
        this.input.minTraceWidth,
    )
    // The shared site matcher uses a conservative width while reserving sites.
    const result = routeAlternateSignalDogbones(
      this.input,
      {
        targetLayers: targets,
        viaDiameter: this.input.minViaPadDiameter ?? 0.6,
        viaHoleDiameter: this.input.minViaHoleDiameter ?? 0.3,
        traceWidth: Math.max(this.input.minTraceWidth, ...widths),
        clearance:
          this.input.minTraceToPadEdgeClearance ??
          this.input.defaultObstacleMargin ??
          0.075,
        boardEdgeClearance: this.input.minBoardEdgeClearance,
        holeToHoleClearance: this.input.minViaHoleEdgeToViaHoleEdgeClearance,
        allowBlindAndBuriedVias: this.input.allowBlindAndBuriedVias ?? false,
      },
      this.attempt,
    )
    this.escapes = result.traces.map((t) => ({
      ...t,
      source_trace_id:
        this.input.connections.find((c) => c.name === t.connection_name)
          ?.source_trace_id ?? t.connection_name,
    })) as Trace[]
    // Only newly created, two-ended dogbones may change signal layers during
    // congestion negotiation. Existing handoffs always keep their fixed layer.
    const terminalLayers = new Map<string, string[]>()
    for (const connection of this.input.connections) {
      if (
        (this.input.buses ?? []).some((b) =>
          b.connectionNames.includes(connection.name),
        )
      )
        continue
      const vias = this.escapes
        .filter((t) => t.connection_name === connection.name)
        .flatMap((t) => t.route.filter((p) => p.route_type === "via"))
      if (vias.length !== 2) continue
      const available = layers.filter((layer) =>
        vias.every(
          (via) =>
            layer !== via.from_layer &&
            (
              via.layers ??
              physicalLayers.slice(
                Math.min(
                  physicalLayers.indexOf(via.from_layer),
                  physicalLayers.indexOf(via.to_layer),
                ),
                Math.max(
                  physicalLayers.indexOf(via.from_layer),
                  physicalLayers.indexOf(via.to_layer),
                ) + 1,
              )
            ).includes(layer),
        ),
      )
      if (available.length > 1) terminalLayers.set(connection.name, available)
    }
    this.terminalLayers = terminalLayers
    const laneInput: SimpleRouteJson = {
      ...this.input,
      connections: result.connections as SimpleRouteJson["connections"],
      traces: [...(this.input.traces ?? []), ...this.escapes],
    }
    const busNames = new Set(laneInput.buses?.flatMap((b) => b.connectionNames))
    const pairsPerLayer = new Map<string, number>()
    for (const pair of laneInput.differentialPairs ?? []) {
      const layer = laneInput.connections.find(
        (c) => c.name === pair.connectionNames[0],
      )!.pointsToConnect[0].layer
      pairsPerLayer.set(layer, (pairsPerLayer.get(layer) ?? 0) + 1)
    }
    // A standalone pair sharing a bus layer disables independent bus routing.
    // Match the buses first, then route standalone pairs before the controls.
    const deferStandalonePairs = [...pairsPerLayer.values()].some(
      (count) => count > 1,
    )
    const constrained = new Set([
      ...busNames,
      ...(laneInput.differentialPairs ?? [])
        .filter(
          (p) =>
            !deferStandalonePairs ||
            p.connectionNames.some((name) => busNames.has(name)),
        )
        .flatMap((p) => p.connectionNames),
    ])
    const matching = laneInput.connections.filter((c) =>
      constrained.has(c.name),
    )
    const remaining = laneInput.connections.filter(
      (c) => !constrained.has(c.name),
    )
    // The reference routes and tunes bus corridors before placing unrelated
    // controls, so those controls cannot consume space required for matching.
    const direction = laneInput.connections
      .filter((c) => busNames.has(c.name))
      .reduce(
        (sum, c) => ({
          x: sum.x + c.pointsToConnect[1].x - c.pointsToConnect[0].x,
          y: sum.y + c.pointsToConnect[1].y - c.pointsToConnect[0].y,
        }),
        { x: 0, y: 0 },
      )
    if (
      this.attempt === 0 &&
      deferStandalonePairs &&
      (laneInput.buses?.length ?? 0) > 1 &&
      this.options.smoothTuning &&
      this.options.denseSearch &&
      (Math.abs(direction.x) > Math.abs(direction.y) ||
        backwardFacingPackageTerminals({
          ...this.input,
          connections: this.input.connections.filter((c) =>
            busNames.has(c.name),
          ),
        }))
    ) {
      this.sharedPackages = routeSharedLayerBuses(
        this.input,
        laneInput,
        this.escapes,
        terminalLayers,
        this.childOptions(),
      )
      return
    }
    if (
      this.attempt === 0 &&
      this.options.smoothTuning &&
      this.options.denseSearch &&
      Math.abs(direction.y) >= Math.abs(direction.x) &&
      backwardFacingPackageTerminals({
        ...this.input,
        connections: this.input.connections.filter((c) => busNames.has(c.name)),
      }) &&
      this.input.connections.every(
        (c) =>
          c.pointsToConnect.length === 2 &&
          c.pointsToConnect.every((p) =>
            isUnroutedComponentPad(this.input, c, p),
          ),
      )
    ) {
      this.backwardPackages = routeBackwardPackageBuses(
        this.input,
        laneInput,
        terminalLayers,
        this.childOptions(),
      )
      return
    }
    const joint =
      (this.attempt > 0 || Math.abs(direction.x) > Math.abs(direction.y)) &&
      backwardFacingPackageTerminals({
        ...this.input,
        connections: this.input.connections.filter((c) => busNames.has(c.name)),
      })
    if (matching.length && remaining.length && !joint) {
      this.remainingInput = {
        ...laneInput,
        connections: remaining,
        buses: [],
        differentialPairs: (laneInput.differentialPairs ?? []).filter((p) =>
          p.connectionNames.every((n) => !constrained.has(n)),
        ),
      }
      if (deferStandalonePairs) {
        const standaloneNames = new Set(
          this.remainingInput.differentialPairs?.flatMap(
            (p) => p.connectionNames,
          ),
        )
        const standalone = remaining.filter((c) => standaloneNames.has(c.name))
        const controls = remaining.filter((c) => !standaloneNames.has(c.name))
        if (standalone.length && controls.length) {
          this.followingInput = {
            ...this.remainingInput,
            connections: controls,
            differentialPairs: [],
          }
          this.remainingInput = {
            ...this.remainingInput,
            connections: standalone,
          }
        }
      }
      this.child = new BusLanesSolver(
        {
          ...laneInput,
          connections: matching,
          differentialPairs: (laneInput.differentialPairs ?? []).filter((p) =>
            p.connectionNames.every((n) => constrained.has(n)),
          ),
        },
        this.childOptions(true),
        terminalLayers,
      )
    } else
      this.child = new BusLanesSolver(
        laneInput,
        this.childOptions(),
        terminalLayers,
      )
  }
  _step() {
    try {
      if (this.siteRematch) {
        const step = this.siteRematch.next()
        this.phase = "resolve_control_sites"
        this.stats = { ...this.stats, routingStage: "control_sites" }
        if (!step.done) return
        this.escapes = step.value.escapes
        this.child = new BusLanesSolver(
          {
            ...this.remainingInput!,
            connections: step.value.connections,
            traces: [
              ...(this.input.traces ?? []),
              ...this.escapes,
              ...this.completedLanes,
            ],
          },
          this.childOptions(),
          this.terminalLayers,
        )
        this.remainingInput = undefined
        this.siteRematch = undefined
        return
      }
      if (!this.child && !this.backwardPackages && !this.sharedPackages)
        this.prepare()
      if (this.sharedPackages) {
        this.phase = "route_shared_layers"
        const state = this.sharedPackages.next()
        if (!state.done) return
        this.sharedPackages = undefined
        if (!state.value) throw Error("Shared-layer bus routing exhausted")
        this.escapes = state.value.escapes
        this.child = BusLanesSolver.forValidation(
          state.value.input,
          state.value.traces,
          this.childOptions(),
        )
      }
      if (this.backwardPackages) {
        this.phase = "route_backward_packages"
        const step = this.backwardPackages.next()
        if (!step.done) return
        this.backwardPackages = undefined
        if (!step.value) throw Error("Backward package bus routing failed")
        this.escapes = step.value.escapes
        this.child = BusLanesSolver.forRefinement(
          step.value.input,
          step.value.traces,
          this.childOptions(),
        )
      }
      this.child!.step()
      this.phase = `lanes_${this.child!.phase}`
      this.stats = {
        ...this.child!.stats,
        layerAttempt: this.attempt,
        dogbones: this.escapes.length,
        routingStage: this.completedLanes.length
          ? "remaining_signals"
          : this.remainingInput
            ? "matched_buses"
            : "all_signals",
      }
      this.progress = this.child!.progress
      if (this.child!.failed)
        throw Error(this.child!.error ?? "Bus lanes failed")
      if (this.child!.solved && !this.remainingInput && this.followingInput) {
        this.remainingInput = this.followingInput
        this.followingInput = undefined
      }
      if (this.child!.solved && this.remainingInput) {
        this.completedLanes.push(...this.child!.traces)
        this.siteRematch = rematchTrappedSignalDogbones(
          this.input,
          this.remainingInput,
          this.completedLanes,
          this.escapes,
          this.terminalLayers,
        )
        return
      }
      if (this.child!.solved) {
        const lanes = [...this.completedLanes, ...this.child!.traces]
        let refined = lanes
        if (this.options.smoothTuning && this.input.differentialPairs?.length) {
          this.packageCoupling ??= this.finishPackageCoupling(
            {
              ...this.input,
              traces: [...(this.input.traces ?? []), ...this.escapes],
              connections: this.input.connections.map((c) => {
                const lane = lanes.find((t) => t.connection_name === c.name)!
                return {
                  ...c,
                  pointsToConnect: [
                    lane.route[0],
                    lane.route.at(-1)!,
                  ] as typeof c.pointsToConnect,
                }
              }),
            },
            lanes,
          )
          const step = this.packageCoupling.next()
          if (!step.done) {
            this.phase = "extend_package_coupling"
            return
          }
          refined = step.value
          this.packageCoupling = undefined
        }
        if (this.options.smoothTuning)
          refined = simplifyMatchedTraces(
            {
              ...this.input,
              traces: [...(this.input.traces ?? []), ...this.escapes],
              connections: this.input.connections.map((c) => {
                const t = refined.find((t) => t.connection_name === c.name)!
                return {
                  ...c,
                  pointsToConnect: [
                    t.route[0],
                    t.route.at(-1)!,
                  ] as typeof c.pointsToConnect,
                }
              }),
            },
            refined,
          )
        this.traces = refined.map((lane) => {
          const signalLayer = lane.route.find(
            (p) => p.route_type === "wire",
          )!.layer
          const escapes = this.escapes
            .filter((t) => t.connection_name === lane.connection_name)
            .map((t) => {
              const via = t.route.find((p) => p.route_type === "via")!
              return {
                ...t,
                route: t.route.map((p) =>
                  p.route_type === "via"
                    ? { ...p, to_layer: signalLayer }
                    : p.layer === via.to_layer
                      ? { ...p, layer: signalLayer }
                      : p,
                ),
              }
            })
          const near = (
            a: { x: number; y: number },
            b: { x: number; y: number },
          ) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-8
          const prefix = escapes.find((t) =>
            near(t.route.at(-1)!, lane.route[0]),
          )
          const suffix = escapes.find(
            (t) => t !== prefix && near(t.route.at(-1)!, lane.route.at(-1)!),
          )
          const prefixRoute = prefix?.route,
            suffixRoute = suffix?.route
          const reversed =
            suffixRoute
              ?.toReversed()
              .map((p) =>
                p.route_type === "via"
                  ? { ...p, from_layer: p.to_layer, to_layer: p.from_layer }
                  : p,
              ) ?? []
          const offset = (prefix?.route.length ?? 1) - 1
          return {
            ...lane,
            coupledSection: lane.coupledSection?.map((i) => i + offset) as
              | [number, number]
              | undefined,
            curvedSegments: lane.curvedSegments?.map((i) => i + offset),
            route: [
              ...(prefixRoute?.slice(0, -1) ?? []),
              ...lane.route,
              ...reversed.slice(1),
            ],
          }
        })
        this.solved = true
        this.phase = "solved"
      }
    } catch (error) {
      this.sharedPackages?.return(null)
      this.sharedPackages = undefined
      this.backwardPackages?.return(null)
      this.backwardPackages = undefined
      this.packageCoupling?.return([])
      this.packageCoupling = undefined
      this.siteRematch?.return({ connections: [], escapes: [] })
      this.siteRematch = undefined
      this.attempt++
      if (
        this.options.fanout !== "none" &&
        this.attempt < this.input.layerCount
      ) {
        this.child = undefined
        this.escapes = []
        this.completedLanes = []
        this.remainingInput = undefined
        this.followingInput = undefined
        this.phase = "retry_layers"
        return
      }
      this.failureCode = this.child?.failureCode ?? "local_dogbone_failed"
      this.error = error instanceof Error ? error.message : String(error)
      this.failed = true
      this.phase = "failed"
      this.traces = []
    }
  }
  visualize() {
    return this.child?.visualize() ?? { points: [], lines: [] }
  }
}
