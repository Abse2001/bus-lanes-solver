import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  busLengthReports,
  pairLengthReports,
  type SimpleRouteJson,
} from "../lib"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { boardOutlineViolations } from "../lib/board-outline"
import { distance } from "../lib/geometry"
import { validateG350PathIntegrity } from "./g350-path-integrity"

/** Independent pad-to-pad acceptance; missing paths cannot count as matching. */
export function validateG350Am3352Sample(
  input: SimpleRouteJson,
  output: SimpleRouteJson,
) {
  const fixedCount = input.traces?.length ?? 0
  const traces = (output.traces ?? []).slice(fixedCount)
  const pathIntegrity = validateG350PathIntegrity(input, traces)
  // Malformed serialized primitives must not reach the geometric audit loops.
  const auditedTraces = pathIntegrity.structurallyValid ? traces : []
  const fixedPreserved =
    JSON.stringify(output.traces?.slice(0, fixedCount)) ===
    JSON.stringify(input.traces ?? [])
  const geometryPreserved =
    JSON.stringify({ ...output, traces: undefined }) ===
    JSON.stringify({ ...input, traces: undefined })
  const connectedNames = input.connections
    .filter((connection) => {
      const matches = auditedTraces.filter(
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
    pathIntegrity.structurallyValid &&
    connectedNames.length === input.connections.length &&
    traces.length === input.connections.length
  const wireWidthsValid =
    pathIntegrity.structurallyValid &&
    auditedTraces.every((trace) =>
      trace.route.every(
        (point) =>
          point.route_type !== "wire" ||
          (Number.isFinite(point.width) &&
            Math.abs(point.width - 0.1016) < 1e-7),
      ),
    )
  const allowedLayers =
    pathIntegrity.structurallyValid &&
    auditedTraces.every((trace) =>
      trace.route.every((point) =>
        point.route_type === "wire"
          ? ["top", "bottom"].includes(point.layer)
          : [point.from_layer, point.to_layer].every((l) =>
              ["top", "bottom"].includes(l),
            ) &&
            point.from_layer !== point.to_layer &&
            Math.abs(
              (point.via_diameter === undefined
                ? input.minViaPadDiameter!
                : point.via_diameter) - 0.4572,
            ) < 1e-7 &&
            Math.abs(
              (point.via_hole_diameter === undefined
                ? input.minViaHoleDiameter!
                : point.via_hole_diameter) - 0.254,
            ) < 1e-7 &&
            (point.layers === undefined ||
              JSON.stringify(point.layers) ===
                JSON.stringify(["top", "inner1", "inner2", "bottom"])),
      ),
    )
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: pathIntegrity.structurallyValid
      ? output
      : { ...output, traces: [] },
    clearance: input.minTraceToPadEdgeClearance ?? 0.1016,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  if (!pathIntegrity.structurallyValid) drc.valid = false
  const outlineIssues = pathIntegrity.structurallyValid
    ? boardOutlineViolations(input, output.traces ?? [])
    : []
  const outline = {
    valid: pathIntegrity.structurallyValid && outlineIssues.length === 0,
    issues: outlineIssues,
  }
  const buses = busLengthReports(input, auditedTraces).filter(
    (b) => b.toleranceMm !== null,
  )
  const pairs = pairLengthReports(input, auditedTraces)
  const coupling = exteriorPairSpacingReports(input, auditedTraces)
  const matched =
    complete &&
    pathIntegrity.valid &&
    [...buses, ...pairs].every(
      (r) => r.matched && r.withinLengthLimit && r.aboveMinimumLength,
    )
  return {
    valid:
      complete &&
      geometryPreserved &&
      fixedPreserved &&
      pathIntegrity.valid &&
      wireWidthsValid &&
      allowedLayers &&
      drc.valid &&
      outline.valid &&
      matched &&
      coupling.every((r) => r.applicable && r.matched),
    complete,
    geometryPreserved,
    fixedPreserved,
    pathIntegrity,
    wireWidthsValid,
    allowedLayers,
    requestedSignals: input.connections.length,
    connectedSignals: connectedNames.length,
    missingSignals: input.connections
      .filter((c) => !connectedNames.includes(c.name))
      .map((c) => c.name),
    drc,
    outline,
    buses,
    pairs,
    coupling,
    matched,
    supportRoutingVerified: false,
    electricalTimingVerified: false,
    fabricationReady: false,
  }
}
