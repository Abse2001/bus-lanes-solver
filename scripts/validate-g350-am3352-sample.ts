import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  busLengthReports,
  pairLengthReports,
  type SimpleRouteJson,
} from "../lib"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { distance } from "../lib/geometry"
import { validateG350LengthConstraints } from "./g350-hardware-recommendations"

/** Independent pad-to-pad acceptance; missing paths cannot count as matching. */
export function validateG350Am3352Sample(
  input: SimpleRouteJson,
  output: SimpleRouteJson,
) {
  const lengthConstraints = validateG350LengthConstraints(input)
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
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: output,
    clearance: input.minTraceToPadEdgeClearance ?? 0.1016,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  const buses = busLengthReports(input, traces).filter(
    (b) => b.toleranceMm !== null,
  )
  const pairs = pairLengthReports(input, traces)
  const coupling = exteriorPairSpacingReports(input, traces)
  const matched =
    complete &&
    [...buses, ...pairs].every(
      (r) => r.matched && r.withinLengthLimit && r.aboveMinimumLength,
    )
  return {
    valid:
      lengthConstraints.valid &&
      complete &&
      geometryPreserved &&
      fixedPreserved &&
      allowedLayers &&
      drc.valid &&
      matched &&
      coupling.every((r) => r.applicable && r.matched),
    complete,
    lengthConstraints,
    geometryPreserved,
    fixedPreserved,
    allowedLayers,
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
