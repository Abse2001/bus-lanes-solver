import { CopperIndex } from "./copper-index"
import type { Connection, Point, SimpleRouteJson, Trace } from "./types"
import { copperTooClose, fixedCopper, type Copper } from "./vector-scene"

type TaggedCopper = Copper & { netIndex: number }

/** Indexed provisional copper costs. A net counts once per query, regardless
 * of trace subdivisions, duplicated shapes or the number of physical planes
 * occupied by its via. These costs never alter hard clearance predicates. */
export class SoftCopperCostIndex {
  private layers = new Map<string, CopperIndex>()
  private lands: CopperIndex
  private holes: CopperIndex
  private weights: number[] = []
  private marks: Uint32Array
  private stamp = 0
  readonly maxCost: number
  readonly integerCosts: boolean
  constructor(
    input: SimpleRouteJson,
    connection: Connection,
    traces: Trace[],
    weights?: Readonly<Record<string, number>>,
  ) {
    if (
      weights &&
      Object.values(weights).some(
        (weight) => !Number.isFinite(weight) || weight < 0,
      )
    )
      throw Error("Soft net weights must be finite and nonnegative")
    const own = new Set(
      [
        connection.name,
        connection.source_trace_id,
        ...connection.pointsToConnect.flatMap((point) => [
          point.pointId,
          point.pcb_port_id,
        ]),
      ].filter((owner): owner is string => !!owner),
    )
    const nets = new Map<string, number>()
    const copper: TaggedCopper[] = [],
      holes: TaggedCopper[] = []
    for (const trace of traces) {
      if (
        [trace.connection_name, trace.source_trace_id].some(
          (owner) => owner && own.has(owner),
        )
      )
        continue
      const name =
        trace.connection_name ?? trace.source_trace_id ?? trace.pcb_trace_id
      let netIndex = nets.get(name)
      if (netIndex === undefined) {
        netIndex = nets.size
        nets.set(name, netIndex)
        this.weights.push(
          weights?.[name] ??
            (trace.source_trace_id
              ? weights?.[trace.source_trace_id]
              : undefined) ??
            1,
        )
      }
      for (const shape of fixedCopper({
        ...input,
        obstacles: [],
        traces: [trace],
      }))
        copper.push({ ...shape, netIndex })
      for (const point of trace.route) {
        if (point.route_type !== "via") continue
        holes.push({
          a: point,
          b: point,
          radius:
            (point.via_hole_diameter ?? input.minViaHoleDiameter ?? 0.15) / 2,
          layer: "drill",
          owners: [],
          netIndex,
        })
      }
    }
    this.marks = new Uint32Array(nets.size)
    this.maxCost = this.weights.reduce((sum, weight) => sum + weight, 0)
    this.integerCosts = this.weights.every(Number.isInteger)
    for (const layer of new Set(copper.map((shape) => shape.layer)))
      this.layers.set(
        layer,
        new CopperIndex(copper.filter((shape) => shape.layer === layer)),
      )
    this.lands = new CopperIndex(copper)
    this.holes = new CopperIndex(holes)
  }
  private begin() {
    if (++this.stamp === 0x100000000) {
      this.marks.fill(0)
      this.stamp = 1
    }
  }
  private count(
    index: CopperIndex | undefined,
    a: Point,
    b: Point,
    margin: number,
    binary: boolean,
  ) {
    let cost = 0
    index?.some(
      {
        minX: Math.min(a.x, b.x) - margin,
        maxX: Math.max(a.x, b.x) + margin,
        minY: Math.min(a.y, b.y) - margin,
        maxY: Math.max(a.y, b.y) + margin,
      },
      (shape) => {
        const net = (shape as TaggedCopper).netIndex
        if (this.marks[net] === this.stamp || !this.weights[net]) return false
        if (!copperTooClose(a, b, shape, margin - 1e-8)) return false
        this.marks[net] = this.stamp
        cost += binary ? 1 : this.weights[net]
        return binary
      },
    )
    return cost
  }
  edgeCost(
    a: Point,
    b: Point,
    layer: string,
    radius: number,
    clearance: number,
    binary = false,
  ) {
    this.begin()
    return this.count(this.layers.get(layer), a, b, radius + clearance, binary)
  }
  landingCost(
    at: Point,
    radius: number,
    clearance: number,
    holeRadius: number,
    holeClearance: number,
    binary = false,
  ) {
    this.begin()
    const cost = this.count(this.lands, at, at, radius + clearance, binary)
    if (binary && cost) return cost
    return (
      cost + this.count(this.holes, at, at, holeRadius + holeClearance, binary)
    )
  }
}
