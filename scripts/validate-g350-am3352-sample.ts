import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  boardBoundaryReports,
  busLengthReports,
  pairLengthReports,
  type SimpleRouteJson,
} from "../lib"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { distance } from "../lib/geometry"
import { checkSignalSelfShorts } from "./check-signal-self-shorts"

/** Independent pad-to-pad acceptance; missing paths cannot count as matching. */
export function validateG350Am3352Sample(
  input: SimpleRouteJson,
  output: SimpleRouteJson,
) {
  const fixedCount = input.traces?.length ?? 0
  const traces = (output.traces ?? []).slice(fixedCount)
  const fixedPreserved =
    JSON.stringify(output.traces?.slice(0, fixedCount)) ===
    JSON.stringify(input.traces ?? [])
  const geometryPreserved =
    JSON.stringify({ ...output, traces: undefined }) ===
    JSON.stringify({ ...input, traces: undefined })
  const connectedNames = input.connections
    .filter((connection) => {
      const matches = traces.filter(
        (t) => t.connection_name === connection.name,
      )
      if (matches.length !== 1 || matches[0].route.length < 2) return false
      const ends = [matches[0].route[0], matches[0].route.at(-1)!]
      return (
        ends.every(
          (end) =>
            end.route_type === "wire" &&
            connection.pointsToConnect.some(
              (point) =>
                point.layer === end.layer && distance(point, end) < 1e-7,
            ),
        ) &&
        connection.pointsToConnect.every((point) =>
          ends.some(
            (end) =>
              end.route_type === "wire" &&
              point.layer === end.layer &&
              distance(point, end) < 1e-7,
          ),
        )
      )
    })
    .map((c) => c.name)
  const complete =
    connectedNames.length === input.connections.length &&
    traces.length === input.connections.length
  // DRC distance comparisons alone cannot reject NaN, Infinity or a trace
  // narrower than the requested manufacturing minimum.
  const routeGeometryValid = traces.every((trace) =>
    trace.route.every(
      (point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        (point.route_type === "wire"
          ? Number.isFinite(point.width) &&
            point.width >= input.minTraceWidth - 1e-7
          : point.route_type === "via" &&
            Number.isFinite(point.via_diameter ?? input.minViaPadDiameter) &&
            Number.isFinite(
              point.via_hole_diameter ?? input.minViaHoleDiameter,
            )),
    ),
  )
  const allowedLayers = traces.every((trace) =>
    trace.route.every((point) =>
      point.route_type === "wire"
        ? ["top", "bottom"].includes(point.layer)
        : [point.from_layer, point.to_layer].every((l) =>
            ["top", "bottom"].includes(l),
          ) &&
          point.from_layer !== point.to_layer &&
          Math.abs((point.via_diameter ?? input.minViaPadDiameter!) - 0.4572) <
            1e-7 &&
          Math.abs(
            (point.via_hole_diameter ?? input.minViaHoleDiameter!) - 0.254,
          ) < 1e-7 &&
          (point.layers === undefined ||
            JSON.stringify(point.layers) ===
              JSON.stringify(["top", "inner1", "inner2", "bottom"])),
    ),
  )
  // The external DRC takes a segment's width from its ending vertex. Use the
  // larger endpoint width so a width transition cannot hide wider copper.
  const drcOutput = {
    ...output,
    traces: output.traces?.map((trace) => ({
      ...trace,
      route: trace.route.map((point, index) => {
        const previous = trace.route[index - 1]
        return point.route_type === "wire" &&
          previous?.route_type === "wire" &&
          previous.layer === point.layer
          ? { ...point, width: Math.max(previous.width, point.width) }
          : point
      }),
    })),
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: drcOutput,
    clearance: input.minTraceToPadEdgeClearance ?? 0.1016,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  const vias = traces.flatMap((trace) =>
    trace.route.filter((point) => point.route_type === "via"),
  )
  const drillSpacingValid = vias.every((via, index) =>
    vias
      .slice(index + 1)
      .every(
        (other) =>
          distance(via, other) >=
          ((via.via_hole_diameter ?? input.minViaHoleDiameter!) +
            (other.via_hole_diameter ?? input.minViaHoleDiameter!)) /
            2 +
            (input.minViaHoleEdgeToViaHoleEdgeClearance ?? 0) -
            1e-7,
      ),
  )
  const selfShorts = routeGeometryValid
    ? checkSignalSelfShorts(
        input,
        traces.map((trace) => ({
          ...trace,
          route: trace.route.map((point) =>
            point.route_type === "via"
              ? {
                  ...point,
                  via_diameter: point.via_diameter ?? input.minViaPadDiameter,
                  via_hole_diameter:
                    point.via_hole_diameter ?? input.minViaHoleDiameter,
                }
              : point,
          ),
        })),
      )
    : []
  const boundary = boardBoundaryReports(input, traces)
  const buses = busLengthReports(input, traces).filter(
    (b) => b.toleranceMm !== null,
  )
  const pairs = pairLengthReports(input, traces)
  // Sampling a non-finite segment could otherwise create an unbounded loop.
  const coupling = routeGeometryValid
    ? exteriorPairSpacingReports(input, traces)
    : (input.differentialPairs ?? []).map((pair) => ({
        connectionNames: pair.connectionNames,
        applicable: false,
        matched: false,
        maxExteriorEdgeGapMm: null,
        maxSamplingErrorMm: null,
        separatedExteriorLengthMm: null,
      }))
  const matched =
    complete &&
    [...buses, ...pairs].every(
      (r) => r.matched && r.withinLengthLimit && r.aboveMinimumLength,
    )
  return {
    valid:
      complete &&
      geometryPreserved &&
      fixedPreserved &&
      routeGeometryValid &&
      allowedLayers &&
      drillSpacingValid &&
      boundary.valid &&
      drc.valid &&
      selfShorts.length === 0 &&
      matched &&
      coupling.every((r) => r.applicable && r.matched),
    complete,
    geometryPreserved,
    fixedPreserved,
    routeGeometryValid,
    allowedLayers,
    drillSpacingValid,
    boundary,
    selfShorts,
    requestedSignals: input.connections.length,
    connectedSignals: connectedNames.length,
    missingSignals: input.connections
      .filter((c) => !connectedNames.includes(c.name))
      .map((c) => c.name),
    drc,
    buses,
    pairs,
    coupling,
    matched,
    supportRoutingVerified: false,
    electricalTimingVerified: false,
    fabricationReady: false,
  }
}
