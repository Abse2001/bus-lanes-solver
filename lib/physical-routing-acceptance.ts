import { checkPcbTraceSelfShorts } from "@tscircuit/checks"
import {
  getCopperLayerNames,
  type RoutedCopperDrcReport,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { all_layers, type AnyCircuitElement, type LayerRef } from "circuit-json"
import { boardBoundaryReports } from "./board-boundary"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { nativeSignalGeometryIsValid } from "./native-signal-geometry"
import { pairCouplingReports } from "./pair-coupling"
import { busLengthReports, pairLengthReports } from "./route-lengths"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import type { SimpleRouteJson, Trace, Via } from "./types"

export interface PhysicalRoutingAcceptanceOptions {
  /** Immutable generated or supplied escape paths, before joining. */
  escapes?: readonly Trace[]
}

/** Sort keys without rounding coordinates or dropping extra point fields. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${stableJson(field)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}

function escapeIsPreserved(escape: Trace, joined: Trace): boolean {
  const actual = joined.route.map(stableJson)
  const curves = new Set(joined.curvedSegments ?? [])
  if (
    !escape.route.length ||
    new Set(escape.curvedSegments ?? []).size !==
      (escape.curvedSegments?.length ?? 0) ||
    (escape.curvedSegments ?? []).some((i) => {
      const a = escape.route[i - 1],
        b = escape.route[i]
      return (
        !Number.isInteger(i) ||
        i <= 0 ||
        i >= escape.route.length ||
        a?.route_type !== "wire" ||
        b?.route_type !== "wire" ||
        a.layer !== b.layer
      )
    })
  )
    return false
  for (const reverse of [false, true]) {
    const points = reverse
      ? escape.route
          .toReversed()
          .map((p) =>
            p.route_type === "via"
              ? { ...p, from_layer: p.to_layer, to_layer: p.from_layer }
              : p,
          )
      : escape.route
    const expected = points.map(stableJson)
    for (let start = 0; start + points.length <= actual.length; start++) {
      if (!expected.every((p, i) => p === actual[start + i])) continue
      const expectedCurves = new Set(
        (escape.curvedSegments ?? []).map(
          (i) => start + (reverse ? points.length - i : i),
        ),
      )
      if (
        points
          .slice(1)
          .every(
            (_, i) =>
              curves.has(start + i + 1) === expectedCurves.has(start + i + 1),
          )
      )
        return true
    }
  }
  return false
}

function viaDimensions(input: SimpleRouteJson, via: Via) {
  return {
    pad: via.via_diameter ?? input.minViaPadDiameter ?? 0.3,
    hole: via.via_hole_diameter ?? input.minViaHoleDiameter ?? 0.15,
  }
}

/** Materialize via lands because route points alone omit them from this check.
 * A synthetic audit bus asks the native check to inspect untimed signals too. */
function nativeSelfShorts(
  input: SimpleRouteJson,
  traces: Trace[],
  stack: string[],
) {
  const layer = (name: string): LayerRef => {
    const result = all_layers.find((candidate) => candidate === name)
    if (!result)
      throw Error(`Native self-short check does not support layer ${name}`)
    return result
  }
  const circuit: AnyCircuitElement[] = [
    {
      type: "pcb_board",
      pcb_board_id: "physical_acceptance_board",
      num_layers: input.layerCount,
      thickness: 1.6,
      material: "fr4",
      center: {
        x: (input.bounds.minX + input.bounds.maxX) / 2,
        y: (input.bounds.minY + input.bounds.maxY) / 2,
      },
    },
    {
      type: "source_bus",
      source_bus_id: "physical_acceptance_self_shorts",
      max_length_skew: 0,
      source_trace_ids: traces.map(
        (t) => t.connection_name ?? t.source_trace_id ?? t.pcb_trace_id,
      ),
    },
    ...input.connections.map(
      (connection): AnyCircuitElement => ({
        type: "source_trace",
        source_trace_id: connection.name,
        name: connection.name,
        connected_source_port_ids: [],
        connected_source_net_ids: [],
      }),
    ),
    ...traces.map(
      (trace): AnyCircuitElement => ({
        type: "pcb_trace",
        pcb_trace_id: trace.pcb_trace_id,
        source_trace_id:
          trace.connection_name ?? trace.source_trace_id ?? trace.pcb_trace_id,
        route: trace.route.map((point) =>
          point.route_type === "wire"
            ? { ...point, layer: layer(point.layer) }
            : {
                ...point,
                from_layer: layer(point.from_layer),
                to_layer: layer(point.to_layer),
              },
        ),
      }),
    ),
    ...traces.flatMap((trace) =>
      trace.route.flatMap((point, index): AnyCircuitElement[] => {
        if (point.route_type !== "via") return []
        const from = stack.indexOf(point.from_layer),
          to = stack.indexOf(point.to_layer)
        const layers =
          point.layers ??
          (!(input.allowBlindAndBuriedVias ?? false)
            ? stack
            : stack.slice(Math.min(from, to), Math.max(from, to) + 1))
        const { pad, hole } = viaDimensions(input, point)
        return [
          {
            type: "pcb_via",
            pcb_via_id: `${trace.pcb_trace_id}_via_${index}`,
            pcb_trace_id: trace.pcb_trace_id,
            source_trace_id:
              trace.connection_name ??
              trace.source_trace_id ??
              trace.pcb_trace_id,
            x: point.x,
            y: point.y,
            outer_diameter: pad,
            hole_diameter: hole,
            layers: layers.map(layer),
          },
        ]
      }),
    ),
  ]
  return checkPcbTraceSelfShorts(circuit)
}

/** Audit fresh joined routes against the unchanged native board. Bus tuning is
 * reported separately; differential-pair requirements remain physical gates. */
export function physicalRoutingAcceptance(
  input: SimpleRouteJson,
  traces: readonly Trace[],
  options: PhysicalRoutingAcceptanceOptions = {},
) {
  const fresh = [...traces]
  const all = [...(input.traces ?? []), ...fresh]
  const output: SimpleRouteJson = { ...input, traces: all }
  const allowBlindAndBuriedVias = input.allowBlindAndBuriedVias ?? false
  const errors: string[] = []
  let stack: string[] = []
  try {
    stack = getCopperLayerNames(input.layerCount)
  } catch (error) {
    errors.push(String(error))
  }
  const names = new Set(input.connections.map((c) => c.name))
  const duplicates = input.connections.filter(
    (c, i) =>
      input.connections.findIndex((other) => other.name === c.name) !== i,
  )
  const duplicateSignals = [
    ...new Set(
      fresh
        .filter(
          (t, i) =>
            fresh.findIndex(
              (other) => other.connection_name === t.connection_name,
            ) !== i,
        )
        .map((t) => t.connection_name ?? ""),
    ),
  ]
  const unexpectedSignals = fresh
    .filter((t) => !t.connection_name || !names.has(t.connection_name))
    .map((t) => t.connection_name ?? t.pcb_trace_id)
  const connectedNames = input.connections
    .filter((connection) => {
      const matches = fresh.filter((t) => t.connection_name === connection.name)
      if (
        matches.length !== 1 ||
        matches[0].route.length < 2 ||
        connection.pointsToConnect.length !== 2
      )
        return false
      const ends = [matches[0].route[0], matches[0].route.at(-1)!]
      const match = (
        end: Trace["route"][number],
        point: (typeof connection.pointsToConnect)[number],
      ) =>
        end.route_type === "wire" &&
        end.layer === point.layer &&
        end.x === point.x &&
        end.y === point.y
      return (
        (match(ends[0], connection.pointsToConnect[0]) &&
          match(ends[1], connection.pointsToConnect[1])) ||
        (match(ends[0], connection.pointsToConnect[1]) &&
          match(ends[1], connection.pointsToConnect[0]))
      )
    })
    .map((c) => c.name)
  const missingSignals = input.connections
    .filter((c) => !connectedNames.includes(c.name))
    .map((c) => c.name)
  const complete =
    duplicates.length === 0 &&
    !missingSignals.length &&
    !duplicateSignals.length &&
    !unexpectedSignals.length &&
    fresh.length === input.connections.length
  const ruleDimensionsValid =
    Number.isFinite(input.minTraceWidth) &&
    input.minTraceWidth > 0 &&
    [input.minViaPadDiameter, input.minViaHoleDiameter].every(
      (v) => v === undefined || (Number.isFinite(v) && v > 0),
    ) &&
    [
      input.minViaHoleEdgeToViaHoleEdgeClearance,
      input.minTraceToPadEdgeClearance,
      input.defaultObstacleMargin,
    ].every((v) => v === undefined || (Number.isFinite(v) && v >= 0))
  const routeGeometryValid =
    ruleDimensionsValid &&
    all.every(
      (t) =>
        t.route.length >= 2 &&
        t.route.every((p) => {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false
          if (p.route_type === "wire")
            return Number.isFinite(p.width) && p.width >= input.minTraceWidth
          if (p.route_type !== "via") return false
          const { pad, hole } = viaDimensions(input, p)
          return (
            Number.isFinite(pad) &&
            Number.isFinite(hole) &&
            pad > 0 &&
            hole > 0 &&
            hole < pad &&
            pad >= (input.minViaPadDiameter ?? 0) &&
            hole >= (input.minViaHoleDiameter ?? 0)
          )
        }),
    )
  const physicalLayersValid =
    stack.length > 0 &&
    all.every((t) =>
      t.route.every((p) =>
        p.route_type === "wire"
          ? stack.includes(p.layer)
          : stack.includes(p.from_layer) &&
            stack.includes(p.to_layer) &&
            p.from_layer !== p.to_layer &&
            (p.layers === undefined ||
              (new Set(p.layers).size === p.layers.length &&
                p.layers.includes(p.from_layer) &&
                p.layers.includes(p.to_layer) &&
                p.layers.every((l) => stack.includes(l)))),
      ),
    )
  const allowedLayersValid =
    (input.allowedLayers === undefined ||
      (input.allowedLayers.length > 0 &&
        input.allowedLayers.every((l) => stack.includes(l)))) &&
    fresh.every((t) => {
      const allowed = input.allowedLayers ?? stack
      const buses = (input.buses ?? []).filter((b) =>
        b.connectionNames.includes(t.connection_name ?? ""),
      )
      return t.route.every((p) =>
        (p.route_type === "wire"
          ? [p.layer]
          : [p.from_layer, p.to_layer]
        ).every(
          (l) =>
            allowed.includes(l) &&
            buses.every(
              (b) =>
                b.allowedLayers === undefined || b.allowedLayers.includes(l),
            ),
        ),
      )
    })
  const viaRulesValid =
    physicalLayersValid &&
    all.every((t) =>
      t.route.every(
        (p) =>
          p.route_type !== "via" ||
          p.layers === undefined ||
          (!allowBlindAndBuriedVias
            ? p.layers.length === stack.length &&
              stack.every((l) => p.layers!.includes(l))
            : (() => {
                const span = stack.slice(
                  Math.min(
                    stack.indexOf(p.from_layer),
                    stack.indexOf(p.to_layer),
                  ),
                  Math.max(
                    stack.indexOf(p.from_layer),
                    stack.indexOf(p.to_layer),
                  ) + 1,
                )
                return (
                  p.layers.length === span.length &&
                  span.every((l) => p.layers!.includes(l))
                )
              })()),
      ),
    )
  const vias = all.flatMap((t) =>
    t.route.filter((p): p is Via => p.route_type === "via"),
  )
  const drillSpacingValid =
    routeGeometryValid &&
    vias.every((via, i) =>
      vias
        .slice(i + 1)
        .every(
          (other) =>
            Math.hypot(via.x - other.x, via.y - other.y) >=
            (viaDimensions(input, via).hole +
              viaDimensions(input, other).hole) /
              2 +
              (input.minViaHoleEdgeToViaHoleEdgeClearance ?? 0) -
              1e-7,
        ),
    )
  const missingEscapes = (options.escapes ?? [])
    .filter(
      (escape) =>
        !fresh.some(
          (trace) =>
            escape.connection_name !== undefined &&
            trace.connection_name === escape.connection_name &&
            escapeIsPreserved(escape, trace),
        ),
    )
    .map((escape) => escape.pcb_trace_id)
  const escapesPreserved = missingEscapes.length === 0
  const safe = routeGeometryValid && physicalLayersValid && viaRulesValid
  let nativeDrc: RoutedCopperDrcReport = {
    valid: false,
    checkedTraceCount: 0,
    checkedSegmentCount: 0,
    checkedViaCount: 0,
    issues: [],
  }
  let selfShorts: ReturnType<typeof checkPcbTraceSelfShorts> = []
  let selfShortCheckValid = false
  let boardBoundary: ReturnType<typeof boardBoundaryReports> = {
    valid: false,
    issues: [],
  }
  if (safe) {
    try {
      // The native DRC uses the ending width; audit the larger width at each
      // wire transition while retaining the original output objects verbatim.
      const drcOutput = {
        ...output,
        traces: all.map((t) => ({
          ...t,
          route: t.route.map((p, i) => {
            const previous = t.route[i - 1]
            return p.route_type === "wire" &&
              previous?.route_type === "wire" &&
              previous.layer === p.layer
              ? { ...p, width: Math.max(previous.width, p.width) }
              : p.route_type === "via"
                ? {
                    ...p,
                    via_diameter: viaDimensions(input, p).pad,
                    via_hole_diameter: viaDimensions(input, p).hole,
                  }
                : p
          }),
        })),
      }
      // Supplied copper can belong to an unrouted power or control net. Name
      // that owner for DRC without inventing terminals or excluding its copper.
      const suppliedNames = new Set(
        (input.traces ?? []).flatMap((trace) =>
          trace.connection_name && !names.has(trace.connection_name)
            ? [trace.connection_name]
            : [],
        ),
      )
      const validationInput = {
        ...input,
        connections: [
          ...input.connections,
          ...[...suppliedNames].map((name) => ({ name, pointsToConnect: [] })),
        ],
      }
      nativeDrc = validateRoutedCopperDrc({
        inputSrj: validationInput,
        routedSrj: { ...drcOutput, connections: validationInput.connections },
        clearance:
          input.minTraceToPadEdgeClearance ??
          input.defaultObstacleMargin ??
          0.075,
        allowBlindAndBuriedVias,
      } as Parameters<typeof validateRoutedCopperDrc>[0])
    } catch (error) {
      errors.push(String(error))
    }
    try {
      selfShorts = nativeSelfShorts(input, all, stack)
      selfShortCheckValid = true
    } catch (error) {
      errors.push(String(error))
    }
    try {
      boardBoundary = boardBoundaryReports(input, all)
    } catch (error) {
      errors.push(String(error))
    }
  }
  const buses = busLengthReports(input, fresh)
  const pairs = pairLengthReports(input, fresh)
  const sharedPairSpacing = safe ? sharedPairSpacingReports(input, fresh) : []
  const exteriorPairSpacing = safe
    ? exteriorPairSpacingReports(input, fresh)
    : []
  const pairCoupling = safe ? pairCouplingReports(input, fresh) : []
  const pairCount = input.differentialPairs?.length ?? 0
  const gates = {
    complete,
    exactlyOneJoinedTracePerConnection: complete,
    originalGeometryPreserved: true,
    originalFixedCopperPreserved: all
      .slice(0, input.traces?.length ?? 0)
      .every((t, i) => t === input.traces![i]),
    routeGeometryValid,
    physicalLayersValid,
    allowedLayersValid,
    viaRulesValid,
    drillSpacingValid,
    zeroNativeDrcIssues: nativeDrc.valid && nativeDrc.issues.length === 0,
    zeroSelfShorts: selfShortCheckValid && selfShorts.length === 0,
    boardBoundaryValid: boardBoundary.valid,
    conventionalAngles:
      routeGeometryValid && all.every(nativeSignalGeometryIsValid),
    differentialPairsMatched:
      pairs.length === pairCount && pairs.every((p) => p.matched),
    sharedPairSpacingValid:
      sharedPairSpacing.length === pairCount &&
      sharedPairSpacing.every((p) => p.matched),
    exteriorPairCouplingValid:
      exteriorPairSpacing.length === pairCount &&
      exteriorPairSpacing.every((p) => p.matched),
    pairCouplingValid: safe && pairCoupling.every((p) => p.matched),
    escapesPreserved,
  }
  return {
    physicalRoutingAccepted: Object.values(gates).every(Boolean),
    ddrTimingAccepted:
      complete &&
      pairs.every((p) => p.matched) &&
      buses.every(
        (b) =>
          (b.toleranceMm === null || b.matched) &&
          b.aboveMinimumLength &&
          b.withinLengthLimit,
      ),
    requestedSignals: input.connections.length,
    connectedSignals: connectedNames.length,
    missingSignals,
    duplicateSignals,
    unexpectedSignals,
    gates,
    nativeDrc,
    selfShorts,
    boardBoundary,
    buses,
    pairs,
    sharedPairSpacing,
    exteriorPairSpacing,
    pairCoupling,
    escapes: structuredClone(options.escapes ?? []),
    escapesPreserved,
    missingEscapes,
    errors,
    output,
  }
}
