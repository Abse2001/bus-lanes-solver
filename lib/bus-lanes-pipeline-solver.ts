import { routeFlexibleLanes } from "./route-flexible-lanes"
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
  private child?: BusLanesSolver
  private escapes: Trace[] = []
  private attempt = 0
  private flexibleInput?: SimpleRouteJson
  private flexibleConnections: SimpleRouteJson["connections"] = []
  private reachable = new Map<string, string[]>()
  private flexible?: Generator<void, Trace[]>
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
      this.child = new BusLanesSolver(this.input, this.options)
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
      const allowed = layers.filter((l) =>
        buses.every((b) => !b.allowedLayers || b.allowedLayers.includes(l)),
      )
      if (!allowed.length)
        throw Error("Bus/pair has no common allowed signal layer")
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
          return crossings * (this.attempt === 1 ? 0 : 4) + load.get(layer)!
        }
        return (
          rank(a) - rank(b) ||
          via ||
          crossingCost(a) - crossingCost(b) ||
          layers.indexOf(a) - layers.indexOf(b)
        )
      })
      const target = allowed[Math.max(0, this.attempt - 1) % allowed.length]
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
    const result = routeLocalSignalDogbones(
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
    const constrained = new Set([
      ...(this.input.buses ?? []).flatMap((b) => b.connectionNames),
      ...(this.input.differentialPairs ?? []).flatMap((p) => p.connectionNames),
    ])
    this.flexibleInput = {
      ...this.input,
      connections: result.connections as SimpleRouteJson["connections"],
      traces: [...(this.input.traces ?? []), ...this.escapes],
    }
    this.flexibleConnections =
      this.input.connections.length > 12 && constrained.size > 0
        ? this.flexibleInput.connections.filter((c) => !constrained.has(c.name))
        : []
    for (const connection of this.flexibleConnections) {
      const original = this.input.connections.find(
        (c) => c.name === connection.name,
      )!
      const ends = original.pointsToConnect.map((p, index) => {
        const escape = this.escapes.find(
          (t) =>
            t.connection_name === connection.name &&
            Math.hypot(t.route[0].x - p.x, t.route[0].y - p.y) < 1e-8,
        )
        const via = escape?.route.find((p) => p.route_type === "via")
        return via?.layers ?? p.layers ?? [p.layer]
      })
      this.reachable.set(
        connection.name,
        layers.filter((l) => ends.every((e) => e.includes(l))),
      )
    }
    const flexibleNames = new Set(this.flexibleConnections.map((c) => c.name))
    this.child = new BusLanesSolver(
      {
        ...this.flexibleInput,
        connections: this.flexibleInput.connections.filter(
          (c) => !flexibleNames.has(c.name),
        ),
      },
      this.options,
    )
  }
  _step() {
    try {
      if (!this.child) this.prepare()
      this.child!.step()
      this.phase = `lanes_${this.child!.phase}`
      this.stats = {
        ...this.child!.stats,
        layerAttempt: this.attempt,
        dogbones: this.escapes.length,
      }
      this.progress = this.child!.progress
      if (this.child!.failed)
        throw Error(this.child!.error ?? "Bus lanes failed")
      if (this.child!.solved) {
        let lanes = this.child!.traces
        if (this.flexibleConnections.length) {
          this.flexible ??= routeFlexibleLanes(
            this.flexibleInput!,
            this.flexibleConnections,
            lanes,
            this.reachable,
          )
          const step = this.flexible.next()
          this.phase = "assign_remaining_layers"
          if (!step.done) return
          lanes = step.value
        }
        this.traces = lanes.map((lane) => {
          const escapes = this.escapes.filter(
            (t) => t.connection_name === lane.connection_name,
          )
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
          const layer = (lane.route[0] as import("./types").Wire).layer
          const adapt = (trace: Trace | undefined) =>
            trace?.route.map((p, i) =>
              p.route_type === "via"
                ? { ...p, to_layer: layer }
                : i === trace.route.length - 1
                  ? { ...p, layer }
                  : p,
            )
          const prefixRoute = adapt(prefix),
            suffixRoute = adapt(suffix)
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
      this.attempt++
      if (
        this.options.fanout !== "none" &&
        this.attempt < this.input.layerCount
      ) {
        this.child = undefined
        this.escapes = []
        this.flexible = undefined
        this.flexibleConnections = []
        this.reachable.clear()
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
