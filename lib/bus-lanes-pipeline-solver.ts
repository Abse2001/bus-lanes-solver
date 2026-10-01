import { routeHypergraphDogbones } from "./hypergraph-dogbones"
import { captureRoutingStage } from "./capture-routing-stage"
import { isUnroutedComponentPad } from "./is-unrouted-component-pad"
import { BaseSolver } from "@tscircuit/solver-utils"
import {
  routeLocalSignalDogbones,
  getCopperLayerNames,
} from "@tscircuit/fanout-solver"
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
  readonly attemptFailures: Array<{
    attempt: number
    phase: string
    error: string
  }> = []
  private child?: BusLanesSolver
  private escapes: Trace[] = []
  private attempt = 0
  private completedLanes: Trace[] = []
  private remainingInput?: SimpleRouteJson
  private terminalLayers = new Map<string, string[]>()
  private childOptions(): SolverOptions {
    return {
      ...this.options,
      onStage: this.options.onStage
        ? (snapshot) =>
            this.options.onStage!({
              ...snapshot,
              attempt: this.attempt,
              routingStage: this.completedLanes.length
                ? "remaining_signals"
                : this.remainingInput
                  ? "matched_buses"
                  : "all_signals",
            })
        : undefined,
    }
  }
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
  private prepare() {
    if (this.options.fanout === "none") {
      this.child = new BusLanesSolver(this.input, this.childOptions())
      return
    }
    const layers = getCopperLayerNames(this.input.layerCount)
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
      allowed.sort((a, b) => {
        // Prefer explicit signal-layer intent, then balance via count against
        // pad-field congestion. Empty compatible layers retain zero-via routes.
        const exposure = (layer: string) =>
          this.input.obstacles.filter(
            (o) => o.componentId && o.layers.includes(layer),
          ).length / 8
        const via = countVias(a) + exposure(a) - countVias(b) - exposure(b)
        const rank = (l: string) =>
          preferred.includes(l) ? preferred.indexOf(l) : preferred.length
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
          return (
            crossings *
              (this.attempt === 1 &&
              this.options.initialRouting !== "hypergraph"
                ? 0
                : 4) +
            load.get(layer)!
          )
        }
        return (
          rank(a) - rank(b) ||
          via ||
          crossingCost(a) - crossingCost(b) ||
          layers.indexOf(a) - layers.indexOf(b)
        )
      })
      const target =
        allowed[
          this.options.initialRouting === "hypergraph"
            ? 0
            : Math.max(0, this.attempt - 1) % allowed.length
        ]
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
    const dogboneRouter =
      this.options.initialRouting === "hypergraph"
        ? (
            input: Parameters<typeof routeLocalSignalDogbones>[0],
            options: Parameters<typeof routeLocalSignalDogbones>[1],
          ) =>
            routeHypergraphDogbones(
              input as SimpleRouteJson,
              options,
              this.attempt,
            )
        : routeLocalSignalDogbones
    const result = dogboneRouter(
      this.input as Parameters<typeof routeLocalSignalDogbones>[0],
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
              layers.slice(
                Math.min(
                  layers.indexOf(via.from_layer),
                  layers.indexOf(via.to_layer),
                ),
                Math.max(
                  layers.indexOf(via.from_layer),
                  layers.indexOf(via.to_layer),
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
    captureRoutingStage(this.options, {
      stage: "local_dogbones",
      input: this.input,
      traces: this.escapes,
      attempt: this.attempt,
      routingStage: "all_signals",
      stats: { localDogbones: this.escapes.length },
    })
    const constrained = new Set([
      ...(laneInput.buses ?? []).flatMap((b) => b.connectionNames),
      ...(laneInput.differentialPairs ?? []).flatMap((p) => p.connectionNames),
    ])
    const matching = laneInput.connections.filter((c) =>
      constrained.has(c.name),
    )
    const remaining = laneInput.connections.filter(
      (c) => !constrained.has(c.name),
    )
    // The reference routes and tunes bus corridors before placing unrelated
    // controls, so those controls cannot consume space required for matching.
    if (
      matching.length &&
      remaining.length &&
      (this.options.initialRouting !== "hypergraph" || this.attempt === 0)
    ) {
      this.remainingInput = {
        ...laneInput,
        connections: remaining,
        buses: [],
        differentialPairs: [],
      }
      this.child = new BusLanesSolver(
        { ...laneInput, connections: matching },
        this.childOptions(),
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
      if (!this.child) {
        this.prepare()
        this.activeSubSolver = this.child
        this.phase = "local_dogbones"
        return
      }
      this.activeSubSolver = this.child
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
      if (this.child!.solved && this.remainingInput) {
        this.completedLanes = this.child!.traces
        this.child = new BusLanesSolver(
          {
            ...this.remainingInput,
            traces: [
              ...(this.remainingInput.traces ?? []),
              ...this.completedLanes,
            ],
          },
          this.childOptions(),
          this.terminalLayers,
        )
        this.remainingInput = undefined
        this.phase = "remaining_signals"
        this.activeSubSolver = this.child
        return
      }
      if (this.child!.solved) {
        this.traces = [...this.completedLanes, ...this.child!.traces].map(
          (lane) => {
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
          },
        )
        this.solved = true
        this.phase = "solved"
        captureRoutingStage(this.options, {
          stage: "assembled_output",
          input: this.input,
          traces: this.traces,
          attempt: this.attempt,
          routingStage: "all_signals",
          stats: { connectedSignals: this.traces.length },
        })
      }
    } catch (error) {
      this.attemptFailures.push({
        attempt: this.attempt,
        phase: this.child?.phase ?? this.phase,
        error: String(error),
      })
      this.attempt++
      if (
        this.options.fanout !== "none" &&
        this.attempt < this.input.layerCount
      ) {
        this.child = undefined
        this.escapes = []
        this.completedLanes = []
        this.remainingInput = undefined
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
    if (this.solved)
      return new BusLanesSolver({
        ...this.getOutput(),
        connections: [],
      }).visualize()
    return this.child?.visualize() ?? new BusLanesSolver(this.input).visualize()
  }
}
