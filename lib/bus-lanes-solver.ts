import { spreadCoupledTuningLanes } from "./spread-coupled-tuning-lanes"
import { simplifyMatchedTraces } from "./simplify-matched-traces"
import { tuneCoupledLengths } from "./tune-coupled-lengths"
import { negotiateLanes } from "./negotiate-lanes"
import { pairCouplingReports } from "./pair-coupling"
import { tuningPathIsSelfClear } from "./length-tuning"
import { routeCoupledPair } from "./coupled-pair-routing"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import type {
  SimpleRouteJson,
  SolverOptions,
  Connection,
  Trace,
  Point,
  Wire,
} from "./types"
import {
  fixedCopper,
  routeCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"
import { GridVisibilitySearch } from "./grid-visibility"
import { VectorVisibilitySearch } from "./vector-visibility"
import { length, distance } from "./geometry"
import { windingOrders } from "./winding-orders"
import {
  lengthConstraints,
  minimumLengthTargets,
  pairLengthReports,
} from "./route-lengths"
import { busLengthReports } from "./route-lengths"
import { spreadTuningLanes } from "./spread-tuning-lanes"
import { tuneSmoothLengths } from "./smooth-length-tuning"
import { tuneLengths } from "./length-tuning"
import { layerColor } from "./layer-colors"
/** Routes on an implicit clearance-offset visibility graph in board-world mm.
 * Every step expands a geometric vertex or commits a complete lane. */
export class BusLanesSolver extends BaseSolver {
  readonly input: SimpleRouteJson
  readonly options: SolverOptions
  phase = "validate"
  failureCode: string | null = null
  traces: Trace[] = []
  private widths = new Map<string, number>()
  private fixed: Copper[] = []
  private orders: Connection[][] = []
  private attempt = 0
  private lane = 0
  private search?: VectorVisibilitySearch | GridVisibilitySearch
  private bestPartial: Trace[] = []
  private pairedTraces: Trace[] = []
  private pairIndex = 0
  private congestionPass = 0
  private conflictingLanes = 0
  private negotiated?: Generator<Trace[], Trace[] | null>
  private pairSearch?: Generator<void, Trace[] | null>
  constructor(
    input: SimpleRouteJson,
    options: SolverOptions = {},
    private readonly terminalLayers: ReadonlyMap<string, string[]> = new Map(),
  ) {
    super()
    this.input = structuredClone(input)
    this.options = options
    this.MAX_ITERATIONS = options.maxSearchIterations ?? 200000
  }
  getConstructorParams() {
    return [this.input, this.options]
  }
  getOutput() {
    if (!this.solved) throw Error(this.error ?? "Bus lanes are not solved")
    return {
      ...this.input,
      traces: [...(this.input.traces ?? []), ...this.traces],
    }
  }
  private fail(code: string, message: string) {
    this.failureCode = code
    this.error = message
    this.failed = true
    this.phase = "failed"
  }
  tryFinalAcceptance() {
    if (!this.solved)
      this.fail(
        "search_budget_exhausted",
        "Vector visibility search budget exhausted",
      )
  }
  private initialize() {
    const input = this.input
    if (input.outline?.length) {
      this.fail("unsupported_outline", "Custom board outlines are unsupported")
      return
    }
    const names = new Set<string>()
    for (const c of input.connections) {
      if (names.has(c.name)) throw Error(`Duplicate connection ${c.name}`)
      names.add(c.name)
      if (c.pointsToConnect.length !== 2) {
        this.fail(
          "invalid_terminals",
          `${c.name}: exactly two terminals required`,
        )
        return
      }
      const [a, b] = c.pointsToConnect
      if (a.layers || b.layers || a.layer !== b.layer) {
        this.fail(
          "layer_change_required",
          `${c.name}: ${a.layer} → ${b.layer}; a common fixed layer is required; fanout handoff layers must agree`,
        )
        return
      }
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite))
        throw Error("Nonfinite terminal")
      this.widths.set(
        c.name,
        c.nominalTraceWidth ?? c.width ?? input.minTraceWidth,
      )
    }
    for (const b of input.buses ?? [])
      if (
        b.maxLengthSkew !== undefined &&
        (!Number.isFinite(b.maxLengthSkew) || b.maxLengthSkew < 0)
      )
        throw Error("Invalid maximum length skew")
    for (const { names: members, tolerance } of lengthConstraints(input)) {
      if (!Number.isFinite(tolerance) || tolerance < 0)
        throw Error("Invalid maximum length skew")
      if (
        members.length < 1 ||
        new Set(members).size !== members.length ||
        members.some((n) => !names.has(n))
      )
        throw Error("Invalid length matching members")
    }
    const claimed = new Set<string>()
    for (const b of input.buses ?? [])
      for (const name of b.connectionNames) {
        const c = input.connections.find((c) => c.name === name)
        if (!c || claimed.has(name))
          throw Error(`Missing or duplicated bus member ${name}`)
        claimed.add(name)
        const layer = c.pointsToConnect[0].layer
        if (b.allowedLayers && !b.allowedLayers.includes(layer))
          throw Error(`${b.busId}: forbidden layer ${layer}`)
        const width = b.traceWidth
        if (width !== undefined) this.widths.set(name, width)
      }
    for (const width of this.widths.values())
      if (!Number.isFinite(width) || width <= 0 || width < input.minTraceWidth)
        throw Error("Invalid trace width")
    this.fixed = fixedCopper(input)
    for (const c of input.connections)
      for (const p of c.pointsToConnect)
        this.fixed.push({
          a: p,
          b: p,
          layer: p.layer,
          radius: this.widths.get(c.name)! / 2,
          owners: [c.name],
        })
    const negotiatePairs =
      this.options.denseSearch && input.connections.length > 12
    const paired = new Set(
      negotiatePairs
        ? []
        : this.coupledPairs().flatMap((p) => p.connectionNames),
    )
    this.orders = windingOrders(
      input.connections.filter((c) => !paired.has(c.name)),
    )
    if (!input.connections.length) {
      this.solved = true
      this.phase = "solved"
      return
    }
    if (!negotiatePairs && this.coupledPairs().length) {
      this.phase = "coupled_pairs"
      return
    }
    this.phase = "route"
    this.startLane()
  }
  private coupledPairs() {
    return (this.input.differentialPairs ?? []).filter(
      (p) => p.traceGap !== undefined || p.maxUncoupledLength !== undefined,
    )
  }
  private routePair() {
    const pair = this.coupledPairs()[this.pairIndex]
    if (!pair) {
      this.pairedTraces = structuredClone(this.traces)
      this.phase = "route"
      this.startLane()
      return
    }
    this.pairSearch ??= routeCoupledPair(this.input, pair, [
      ...this.fixed,
      ...this.traces.flatMap(routeCopper),
    ])
    const step = this.pairSearch.next()
    if (!step.done) return
    if (!step.value) {
      this.fail(
        "coupled_routing_failed",
        "No legal coupled corridor and package approaches",
      )
      return
    }
    this.traces.push(...step.value)
    this.pairSearch = undefined
    this.pairIndex++
  }
  private scene(c: Connection) {
    return new VectorScene(this.input, c, this.widths.get(c.name)!, [
      ...this.fixed,
      ...this.traces.flatMap(routeCopper),
    ])
  }
  private startLane() {
    if (this.lane === this.orders[this.attempt].length) {
      this.phase = "match"
      return
    }
    const c = this.orders[this.attempt][this.lane],
      [a, b] = c.pointsToConnect
    this.search =
      this.options.denseSearch && this.input.connections.length > 12
        ? new GridVisibilitySearch(this.scene(c), a, b)
        : new VectorVisibilitySearch(this.scene(c), a, b)
  }
  private retry() {
    if (this.traces.length > this.bestPartial.length)
      this.bestPartial = structuredClone(this.traces)
    if (this.options.denseSearch && this.attempt < 300) {
      const current = this.orders[this.attempt]
      const failed = current[this.lane]
      if (failed) {
        const next = [...current]
        next.splice(this.lane, 1)
        next.splice(
          Math.max(0, this.lane - 1 - Math.floor(this.attempt / 8)),
          0,
          failed,
        )
        const key = next.map((c) => c.name).join("\0")
        if (
          !this.orders
            .slice(0, this.attempt + 1)
            .some((order) => order.map((c) => c.name).join("\0") === key)
        )
          this.orders.splice(this.attempt + 1, 0, next)
      }
    }
    this.attempt++
    if (this.attempt >= this.orders.length) {
      this.traces = this.bestPartial
      this.fail(
        "no_planar_route",
        "No collision-free routing found in the vector visibility graph",
      )
      return
    }
    this.traces = structuredClone(this.pairedTraces)
    this.lane = 0
    this.startLane()
  }
  private route() {
    if (this.options.denseSearch && this.input.connections.length > 12) {
      this.negotiated ??= negotiateLanes(
        this.input,
        this.orders[0],
        this.fixed,
        this.pairedTraces,
        this.widths,
        (pass, conflicts) => {
          this.congestionPass = pass
          this.conflictingLanes = conflicts
        },
        this.terminalLayers,
      )
      const step = this.negotiated.next()
      if (!step.done) {
        this.traces = step.value
        this.lane = this.traces.length - this.pairedTraces.length
        return
      }
      if (!step.value) {
        this.fail(
          "no_planar_route",
          "Negotiated lane search exhausted without a complete route",
        )
        return
      }
      this.traces = step.value
      this.phase = "match"
      return
    }
    const s = this.search!
    s.step()
    if (s.solved) {
      const c = this.orders[this.attempt][this.lane]
      this.traces.push({
        type: "pcb_trace",
        pcb_trace_id: `bus_lane_${c.name}`,
        connection_name: c.name,
        source_trace_id: c.source_trace_id ?? c.name,
        route: reduceOrdinaryTurns(s.result, this.scene(c)).map((p) => ({
          route_type: "wire",
          x: p.x,
          y: p.y,
          layer: c.pointsToConnect[0].layer,
          width: this.widths.get(c.name)!,
        })),
      })
      this.lane++
      this.startLane()
    } else if (
      s.failed ||
      s.expanded >=
        (this.options.maxLaneIterations ??
          (s instanceof GridVisibilitySearch ? 1_000_000 : 4000))
    )
      this.retry()
  }
  private match() {
    const original = this.traces
    const input = this.input
    function* candidates() {
      yield original
      if (original.some((t) => t.coupledSection)) {
        for (const multiplier of [8, 12, 16, 20]) {
          const spread = spreadCoupledTuningLanes(
            input,
            original,
            input.minTraceWidth * multiplier,
          )
          if (spread) yield spread
        }
        return
      }
      const width = Math.max(...original.map((t) => (t.route[0] as Wire).width))
      for (const multiplier of [16, 24, 28, 32]) {
        const spread = spreadTuningLanes(input, original, width * multiplier)
        if (spread) yield spread
      }
    }
    let error: unknown
    for (const candidate of candidates()) {
      const targets = minimumLengthTargets(input, candidate)
      try {
        this.traces =
          this.options.smoothTuning && candidate.some((t) => t.coupledSection)
            ? tuneCoupledLengths(input, candidate)
            : (this.options.smoothTuning ? tuneSmoothLengths : tuneLengths)(
                input,
                candidate,
                targets,
              )
        if (this.options.smoothTuning)
          this.traces = simplifyMatchedTraces(input, this.traces)
        this.phase = "validate_output"
        return
      } catch (e) {
        error = e
      }
    }
    this.fail("length_matching_failed", String(error))
    return
  }
  private validateOutput() {
    for (const c of this.input.connections) {
      const t = this.traces.find((t) => t.connection_name === c.name)
      if (!t) throw Error("Missing lane")
      if (
        t.route.length < 2 ||
        t.route.some(
          (p) =>
            !Number.isFinite(p.x) ||
            !Number.isFinite(p.y) ||
            p.route_type !== "wire" ||
            !Number.isFinite(p.width) ||
            p.width <= 0,
        )
      )
        throw Error("Invalid lane geometry")
      const scene = this.scene(c)
      if (
        !tuningPathIsSelfClear(
          t.route,
          this.widths.get(c.name)! / 2 + scene.margin,
        )
      )
        throw Error("Final self-clearance violation")
      if (
        distance(t.route[0], c.pointsToConnect[0]) > 1e-8 ||
        distance(t.route.at(-1)!, c.pointsToConnect[1]) > 1e-8
      )
        throw Error("Broken lane endpoints")
      for (let i = 1; i < t.route.length; i++) {
        const a = t.route[i - 1],
          b = t.route[i],
          dx = Math.abs(a.x - b.x),
          dy = Math.abs(a.y - b.y)
        if (
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          a.layer !== b.layer
        )
          throw Error("Forbidden layer transition")
        if (
          Math.min(dx, dy) > 1e-8 &&
          Math.abs(dx - dy) > 1e-8 &&
          !t.curvedSegments?.includes(i)
        )
          throw Error("Non-octilinear segment")
        if (!scene.visible(a, b))
          throw Error("Final copper clearance violation")
      }
    }
    if (
      [
        ...busLengthReports(this.input, this.traces),
        ...pairLengthReports(this.input, this.traces),
      ].some((b) => b.toleranceMm !== null && !b.matched)
    )
      throw Error("Final bus length skew violation")
    if (pairCouplingReports(this.input, this.traces).some((p) => !p.matched))
      throw Error("Final pair uncoupled length violation")
    this.phase = "solved"
    this.solved = true
  }
  _step() {
    try {
      if (this.phase === "validate") this.initialize()
      else if (this.phase === "coupled_pairs") this.routePair()
      else if (this.phase === "route") this.route()
      else if (this.phase === "match") this.match()
      else if (this.phase === "validate_output") this.validateOutput()
    } catch (e) {
      this.fail("constraint_error", String(e))
    }
    this.progress = this.lane / Math.max(1, this.input.connections.length)
    this.stats = {
      busLengths: busLengthReports(this.input, this.traces),
      pairLengths: pairLengthReports(this.input, this.traces),
      phase: this.phase,
      algorithm: "octilinear_visibility",
      attempt: this.attempt,
      lane: this.lane,
      totalLanes: this.input.connections.length,
      congestionPass: this.congestionPass,
      conflictingLanes: this.conflictingLanes,
      vertices:
        (this.search instanceof VectorVisibilitySearch
          ? this.search.vertices.length
          : 0) ?? 0,
      expandedVertices: this.search?.expanded ?? 0,
      frontier:
        (this.search instanceof VectorVisibilitySearch
          ? this.search.open.length
          : 0) ?? 0,
      failureCode: this.failureCode,
      traceLengthsMm: this.traces.map((t) => ({
        name: t.connection_name,
        length: length(t.route),
      })),
    }
  }
  visualize(): GraphicsObject {
    const lines: any[] = [],
      points: any[] = [],
      rects: any[] = [],
      circles: any[] = []
    for (const c of fixedCopper(this.input)) {
      if (c.rect) {
        rects.push({
          center: {
            x: (c.rect.minX + c.rect.maxX) / 2,
            y: (c.rect.minY + c.rect.maxY) / 2,
          },
          width: c.rect.maxX - c.rect.minX,
          height: c.rect.maxY - c.rect.minY,
          layer: c.layer,
          fill: `${layerColor(c.layer)}30`,
          stroke: layerColor(c.layer),
        })
        continue
      }
      if (distance(c.a, c.b) < 1e-9)
        circles.push({
          center: c.a,
          radius: c.radius,
          layer: c.layer,
          fill: "transparent",
          stroke: layerColor(c.layer),
        })
      else
        lines.push({
          points: [
            { x: c.a.x, y: c.a.y },
            { x: c.b.x, y: c.b.y },
          ],
          strokeWidth: c.radius * 2,
          strokeColor: layerColor(c.layer),
          layer: c.layer,
          label: `Fixed fanout [${c.layer}]`,
        })
    }
    for (const t of this.traces)
      lines.push({
        points: t.route.map(({ x, y }) => ({ x, y })),
        strokeWidth: (t.route[0] as Wire).width,
        strokeColor: layerColor((t.route[0] as Wire).layer),
        layer: (t.route[0] as Wire).layer,
        label: t.connection_name,
      })
    for (const c of this.input.connections)
      for (const [i, p] of c.pointsToConnect.entries())
        points.push({
          ...p,
          color: i ? "#d97706" : "#2563eb",
          label: `${c.name} ${i ? "target" : "source"} [${p.layer}]`,
        })
    if (
      this.search instanceof VectorVisibilitySearch &&
      this.phase === "route"
    ) {
      const layer =
        this.orders[this.attempt][this.lane]?.pointsToConnect[0].layer
      for (const edge of this.search.visibleEdges)
        lines.push({
          points: edge,
          strokeWidth: 0.02,
          strokeColor: "#67e8f980",
          layer,
        })
      for (const n of this.search.open.values().slice(0, 80))
        points.push({ ...this.search.vertices[n.id], color: "#06b6d4", layer })
      lines.push({
        points: this.search.currentPath(),
        strokeColor: "#f43f5e",
        strokeWidth: 0.09,
        layer,
      })
    }
    return {
      title: `Vector bus lanes · ${this.phase}`,
      lines,
      points,
      rects,
      circles,
    }
  }
}
