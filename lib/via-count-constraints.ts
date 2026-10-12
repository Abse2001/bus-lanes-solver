import type { SimpleRouteJson, Trace, Via, Wire } from "./types"

/** Optional transition-count bounds supplement, rather than replace, planar matching. */
export interface ViaCountOptions {
  maxBusViaCountSkew?: number
  maxPairViaCountSkew?: number
}

export function viaCountConstraintsEnabled(options: ViaCountOptions) {
  return (
    options.maxBusViaCountSkew !== undefined ||
    options.maxPairViaCountSkew !== undefined
  )
}

export function validateViaCountOptions(options: ViaCountOptions) {
  for (const name of ["maxBusViaCountSkew", "maxPairViaCountSkew"] as const) {
    const value = options[name]
    if (value !== undefined && (!Number.isInteger(value) || value < 0))
      throw Error(`${name} must be a nonnegative integer`)
  }
}

function transitionKey(point: Via, input: SimpleRouteJson) {
  if (!Number.isInteger(input.layerCount) || input.layerCount < 1)
    throw Error("Unsupported via-count accounting: invalid physical stack")
  // Same canonical physical stack as VectorScene and the fanout layer API.
  const physical = Array.from({ length: input.layerCount }, (_, index) =>
    index === 0
      ? "top"
      : index === input.layerCount - 1
        ? "bottom"
        : `inner${index}`,
  )
  const from = physical.indexOf(point.from_layer),
    to = physical.indexOf(point.to_layer),
    required = input.allowBlindAndBuriedVias
      ? physical.slice(Math.min(from, to), Math.max(from, to) + 1)
      : physical,
    span = point.layers ?? required,
    diameter = point.via_diameter ?? input.minViaPadDiameter ?? 0.3,
    hole = point.via_hole_diameter ?? input.minViaHoleDiameter ?? 0.15
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    from < 0 ||
    to < 0 ||
    from === to ||
    !Array.isArray(span) ||
    span.some((layer) => !physical.includes(layer)) ||
    !required.every((layer) => span.includes(layer)) ||
    new Set(span).size !== span.length ||
    !Number.isFinite(diameter) ||
    !Number.isFinite(hole) ||
    diameter <= 0 ||
    hole <= 0 ||
    hole > diameter ||
    diameter < (input.minViaPadDiameter ?? 0.3) - 1e-8 ||
    hole < (input.minViaHoleDiameter ?? 0.15) - 1e-8
  )
    throw Error("Unsupported via-count accounting: invalid transition record")
  return JSON.stringify([
    point.x,
    point.y,
    [point.from_layer, point.to_layer].sort(),
  ])
}

/** Count actual records. A repeated fragment is ambiguous, so never deduplicate it. */
export function countRouteViaTransitions(trace: Trace, input: SimpleRouteJson) {
  const transitions = new Set<string>()
  if (
    trace.route.some((point) => point.route_type === "via") &&
    (trace.route[0]?.route_type !== "wire" ||
      trace.route.at(-1)?.route_type !== "wire")
  )
    throw Error("Unsupported via-count accounting: incomplete via fragment")
  for (let index = 0; index < trace.route.length; index++) {
    const point = trace.route[index],
      before = trace.route[index - 1],
      after = trace.route[index + 1]
    if (point.route_type === "wire") {
      const physical = Array.from({ length: input.layerCount }, (_, index) =>
        index === 0
          ? "top"
          : index === input.layerCount - 1
            ? "bottom"
            : `inner${index}`,
      )
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !physical.includes(point.layer) ||
        !Number.isFinite(point.width) ||
        point.width <= 0 ||
        point.width < input.minTraceWidth - 1e-8 ||
        (after?.route_type === "wire" && after.layer !== point.layer)
      )
        throw Error("Unsupported via-count accounting: invalid wire handoff")
      continue
    }
    if (point.route_type !== "via")
      throw Error("Unsupported via-count accounting: unknown route primitive")
    const key = transitionKey(point, input)
    if (transitions.has(key))
      throw Error("Unsupported via-count accounting: repeated via record")
    if (
      before?.route_type !== "wire" ||
      after?.route_type !== "wire" ||
      before.layer !== point.from_layer ||
      after.layer !== point.to_layer ||
      Math.hypot(before.x - point.x, before.y - point.y) > 1e-8 ||
      Math.hypot(after.x - point.x, after.y - point.y) > 1e-8
    )
      throw Error("Unsupported via-count accounting: invalid via handoff")
    transitions.add(key)
  }
  return transitions.size
}

interface CountConstraint {
  names: readonly string[]
  limit: number
}

export interface ViaCountConstraintChecker {
  readonly policy: ViaCountOptions
  total(name: string, owned: readonly Trace[]): number
  compatible(
    firstName: string,
    first: number,
    secondName: string,
    second: number,
  ): boolean
  acceptsKnown(
    name: string,
    count: number,
    known: ReadonlyMap<string, number>,
  ): boolean
  matches(complete: readonly Trace[]): boolean
}

/** Count immutable fanouts and owned fragments with the same electrical ownership
 * used by planar matching. Aliased owners or repeated fragments need a path graph
 * to disambiguate and are explicitly unsupported by this optional policy. */
export function createViaCountConstraintChecker(
  input: SimpleRouteJson,
  options: ViaCountOptions,
): ViaCountConstraintChecker | undefined {
  if (!viaCountConstraintsEnabled(options)) return undefined
  validateViaCountOptions(options)
  if (
    !Number.isInteger(input.layerCount) ||
    input.layerCount < 1 ||
    !Number.isFinite(input.minTraceWidth) ||
    input.minTraceWidth <= 0 ||
    [input.minViaPadDiameter, input.minViaHoleDiameter].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value <= 0),
    )
  )
    throw Error(
      "Unsupported via-count accounting: invalid manufacturing context",
    )
  const policy: ViaCountOptions = {
    ...(options.maxBusViaCountSkew !== undefined
      ? { maxBusViaCountSkew: options.maxBusViaCountSkew }
      : {}),
    ...(options.maxPairViaCountSkew !== undefined
      ? { maxPairViaCountSkew: options.maxPairViaCountSkew }
      : {}),
  }
  const byName = new Map(
    input.connections.map((connection) => [connection.name, connection]),
  )
  if (byName.size !== input.connections.length)
    throw Error("Unsupported via-count accounting: duplicate connection name")
  const bySource = new Map<string, string>()
  for (const connection of input.connections) {
    const owner = connection.source_trace_id || connection.name
    if (bySource.has(owner))
      throw Error("Unsupported via-count accounting: aliased source owner")
    bySource.set(owner, connection.name)
  }
  const ownerOf = (trace: Trace) => {
    const named =
      trace.connection_name && byName.has(trace.connection_name)
        ? trace.connection_name
        : undefined
    const sourced = trace.source_trace_id
      ? bySource.get(trace.source_trace_id)
      : undefined
    if (trace.connection_name && !named && sourced)
      throw Error("Unsupported via-count accounting: unknown named alias")
    if (named && trace.source_trace_id) {
      const expected = byName.get(named)!.source_trace_id || named
      if (trace.source_trace_id !== expected)
        throw Error(
          "Unsupported via-count accounting: contradictory trace owner",
        )
    }
    if (named && sourced && named !== sourced)
      throw Error("Unsupported via-count accounting: contradictory trace owner")
    if (
      !named &&
      !sourced &&
      !trace.connection_name &&
      !trace.source_trace_id &&
      trace.route.some((point) => point.route_type === "via")
    )
      throw Error("Unsupported via-count accounting: unattributed via fragment")
    return named ?? sourced
  }
  const constraints: CountConstraint[] = [
    ...(policy.maxBusViaCountSkew === undefined
      ? []
      : (input.buses ?? []).map((bus) => ({
          names: bus.connectionNames,
          limit: policy.maxBusViaCountSkew!,
        }))),
    ...(policy.maxPairViaCountSkew === undefined
      ? []
      : (input.differentialPairs ?? []).map((pair) => ({
          names: pair.connectionNames,
          limit: policy.maxPairViaCountSkew!,
        }))),
  ]
  for (const constraint of constraints)
    if (
      new Set(constraint.names).size !== constraint.names.length ||
      constraint.names.some((name) => !byName.has(name))
    )
      throw Error(
        "Unsupported via-count accounting: invalid constraint membership",
      )
  const fixed = new Map<string, Trace[]>()
  for (const trace of input.traces ?? []) {
    const name = ownerOf(trace)
    if (name) fixed.set(name, [...(fixed.get(name) ?? []), trace])
  }
  const count = (fragments: readonly Trace[]) => {
    const transitions = new Set<string>(),
      ids = new Set<string>()
    const previousEdges: Array<[Wire, Wire]> = []
    let total = 0
    for (const trace of fragments) {
      if (ids.has(trace.pcb_trace_id))
        throw Error(
          "Unsupported via-count accounting: duplicate trace fragment",
        )
      ids.add(trace.pcb_trace_id)
      total += countRouteViaTransitions(trace, input)
      for (const point of trace.route) {
        if (point.route_type !== "via") continue
        const key = transitionKey(point, input)
        if (transitions.has(key))
          throw Error(
            "Unsupported via-count accounting: overlapping via fragments",
          )
        transitions.add(key)
      }
      const edges: Array<[Wire, Wire]> = []
      for (let index = 1; index < trace.route.length; index++) {
        const a = trace.route[index - 1],
          b = trace.route[index]
        if (
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          a.layer !== b.layer
        )
          continue
        const dx = b.x - a.x,
          dy = b.y - a.y
        if (dx === 0 && dy === 0) continue
        for (const [c, d] of previousEdges) {
          if (c.layer !== a.layer) continue
          const scale = Math.sqrt(dx * dx + dy * dy)
          const cross = (point: Wire) =>
            Math.abs(dx * (point.y - a.y) - dy * (point.x - a.x))
          if (cross(c) > scale * 1e-8 || cross(d) > scale * 1e-8) continue
          const coordinate = (point: Wire) =>
            Math.abs(dx) >= Math.abs(dy) ? point.x : point.y
          const overlap =
            Math.min(
              Math.max(coordinate(a), coordinate(b)),
              Math.max(coordinate(c), coordinate(d)),
            ) -
            Math.max(
              Math.min(coordinate(a), coordinate(b)),
              Math.min(coordinate(c), coordinate(d)),
            )
          if (overlap > 1e-8)
            throw Error(
              "Unsupported via-count accounting: overlapping wire fragments",
            )
        }
        edges.push([a, b])
      }
      previousEdges.push(...edges)
    }
    return total
  }
  for (const fragments of fixed.values()) count(fragments)
  const total = (name: string, owned: readonly Trace[]) => {
    if (!byName.has(name)) throw Error("Unknown via-count connection")
    if (owned.some((trace) => ownerOf(trace) !== name))
      throw Error("Unsupported via-count accounting: owned fragment mismatch")
    return count([...(fixed.get(name) ?? []), ...owned])
  }
  const compatible = (
    firstName: string,
    first: number,
    secondName: string,
    second: number,
  ) =>
    constraints.every(
      (constraint) =>
        !constraint.names.includes(firstName) ||
        !constraint.names.includes(secondName) ||
        Math.abs(first - second) <= constraint.limit,
    )
  const acceptsKnown = (
    name: string,
    value: number,
    known: ReadonlyMap<string, number>,
  ) =>
    [...known].every(([otherName, other]) =>
      compatible(name, value, otherName, other),
    )
  const matches = (complete: readonly Trace[]) => {
    const routed = new Map<string, Trace[]>()
    for (const trace of complete) {
      const name = ownerOf(trace)
      if (!name)
        throw Error("Unsupported via-count accounting: unknown completed owner")
      routed.set(name, [...(routed.get(name) ?? []), trace])
    }
    for (const constraint of constraints) {
      if (constraint.names.some((name) => !routed.has(name))) return false
      const values = constraint.names.map((name) =>
        total(name, routed.get(name)!),
      )
      if (
        values.length &&
        Math.max(...values) - Math.min(...values) > constraint.limit
      )
        return false
    }
    return true
  }
  return { policy, total, compatible, acceptsKnown, matches }
}
