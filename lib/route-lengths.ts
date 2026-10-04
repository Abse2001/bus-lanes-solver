import { length } from "./geometry"
import type { SimpleRouteJson, Trace } from "./types"

/** Planar copper length already routed for a connection. Via depth and package
 * delay require stackup/package data and are not inferred from XY coordinates. */
export function fixedRouteLength(input: SimpleRouteJson, name: string) {
  const connection = input.connections.find((c) => c.name === name)
  return (input.traces ?? [])
    .filter(
      (t) =>
        t.connection_name === name ||
        t.source_trace_id === (connection?.source_trace_id ?? name),
    )
    .reduce((sum, t) => sum + length(t.route), 0)
}
export function busLengthReports(input: SimpleRouteJson, traces: Trace[]) {
  return (input.buses ?? []).map((bus) => {
    const lengths = bus.connectionNames.map((name) => {
      const route = traces.find((t) => t.connection_name === name)
      return {
        name,
        carrierLengthMm: route ? length(route.route) : null,
        fixedLengthMm: fixedRouteLength(input, name),
        totalLengthMm: route
          ? length(route.route) + fixedRouteLength(input, name)
          : null,
      }
    })
    const complete = lengths.every((l) => l.totalLengthMm !== null)
    const values = lengths.map((l) => l.totalLengthMm ?? 0)
    const skewMm =
      complete && values.length
        ? Math.max(...values) - Math.min(...values)
        : null
    return {
      busId: bus.busId,
      minLengthMm: bus.minLength ?? null,
      aboveMinimumLength:
        bus.minLength === undefined
          ? true
          : complete && values.every((value) => value >= bus.minLength! - 1e-7),
      maxLengthMm: bus.maxLength ?? null,
      withinLengthLimit:
        bus.maxLength === undefined
          ? true
          : complete && values.every((value) => value <= bus.maxLength! + 1e-7),
      toleranceMm: bus.maxLengthSkew ?? null,
      skewMm,
      matched:
        bus.maxLengthSkew !== undefined &&
        skewMm !== null &&
        skewMm <= bus.maxLengthSkew + 1e-7,
      lengths,
    }
  })
}

/** Existing SRJ skew bounds; omitted bus bounds do not request tuning. */
export function lengthConstraints(input: SimpleRouteJson) {
  return [
    ...(input.buses ?? [])
      .filter((b) => b.maxLengthSkew !== undefined)
      .map((b) => ({
        names: b.connectionNames,
        tolerance: b.maxLengthSkew!,
      })),
    ...(input.differentialPairs ?? []).map((p) => ({
      names: p.connectionNames,
      tolerance: p.lengthTolerance,
    })),
  ]
}

/** Least non-shortening lengths satisfying every overlapping bus/pair bound.
 * Relax difference constraints rather than collapsing connected groups to equality. */
export function minimumLengthTargets(input: SimpleRouteJson, traces: Trace[]) {
  const targets = new Map(
    traces.map((t) => [
      t.connection_name!,
      length(t.route) + fixedRouteLength(input, t.connection_name!),
    ]),
  )
  for (const bus of input.buses ?? [])
    if (bus.minLength !== undefined)
      for (const name of bus.connectionNames)
        if (targets.has(name))
          targets.set(name, Math.max(targets.get(name)!, bus.minLength))
  const constraints = lengthConstraints(input)
  for (let pass = 0; pass < targets.size; pass++) {
    let changed = false
    for (const { names, tolerance } of constraints) {
      const floor = Math.max(...names.map((n) => targets.get(n)!)) - tolerance
      for (const name of names)
        if (targets.get(name)! < floor - 1e-9) {
          targets.set(name, floor)
          changed = true
        }
    }
    if (!changed) break
  }
  return targets
}

export function pairLengthReports(input: SimpleRouteJson, traces: Trace[]) {
  return busLengthReports(
    {
      ...input,
      buses: (input.differentialPairs ?? []).map((p, i) => ({
        busId: `pair_${i}`,
        connectionNames: p.connectionNames,
        maxLengthSkew: p.lengthTolerance,
      })),
    },
    traces,
  )
}

/** Remaining carrier budget after immutable copper and generated escapes. */
export function maximumCarrierLength(input: SimpleRouteJson, name: string) {
  return Math.min(
    Infinity,
    ...(input.buses ?? [])
      .filter(
        (bus) =>
          bus.connectionNames.includes(name) && bus.maxLength !== undefined,
      )
      .map((bus) => bus.maxLength! - fixedRouteLength(input, name)),
  )
}

export function assertLengthTargets(
  input: SimpleRouteJson,
  targets: ReadonlyMap<string, number>,
) {
  for (const bus of input.buses ?? [])
    if (
      bus.maxLength !== undefined &&
      bus.connectionNames.some(
        (name) => (targets.get(name) ?? Infinity) > bus.maxLength! + 1e-7,
      )
    )
      throw Error(
        `${bus.busId}: matching would exceed maximum length ${bus.maxLength} mm`,
      )
}
