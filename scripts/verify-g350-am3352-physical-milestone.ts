import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { SimpleRouteJson, Trace } from "../lib/types"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { loadG350Am3352RepairedSample } from "./g350-am3352-repaired-sample"
import { g350Am3352Metadata } from "./g350-am3352-sample"
import { validateG350Am3352Sample } from "./validate-g350-am3352-sample"

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url))
const expectedNativeSha256 =
  "fd0050cc1e3323d862be324fedc456cacaf195e81550dc1bccf574d69b365e5d"
const canonicalSavedEscapesSha256 =
  "f4602ca38a6aae7fb6fcb4a30d6adf0141efe933357800b94d55763a065e97d2"
const defaultRoutedPath = resolve(
  repositoryRoot,
  "docs/g350-am3352-physical-milestone/routed.json",
)
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex")

/** Sort object keys only. Coordinates and all other field values stay exact. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${stableJson(field)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}

function savedEscapeIsPreserved(escape: Trace, joined: Trace): boolean {
  const joinedPoints = joined.route.map(stableJson)
  const joinedCurves = new Set(joined.curvedSegments ?? [])
  for (const reverse of [false, true]) {
    const points = reverse
      ? escape.route.toReversed().map((point) =>
          point.route_type === "via"
            ? {
                ...point,
                from_layer: point.to_layer,
                to_layer: point.from_layer,
              }
            : point,
        )
      : escape.route
    if (!points.length) return false
    const expected = points.map(stableJson)
    for (let start = 0; start + points.length <= joinedPoints.length; start++) {
      if (
        !expected.every((point, index) => point === joinedPoints[start + index])
      )
        continue
      const expectedCurves = new Set(
        (escape.curvedSegments ?? []).map(
          (index) => start + (reverse ? points.length - index : index),
        ),
      )
      // Each fixed chord retains exactly its original permission to curve.
      if (
        points
          .slice(1)
          .every(
            (_, index) =>
              joinedCurves.has(start + index + 1) ===
              expectedCurves.has(start + index + 1),
          )
      )
        return true
    }
  }
  return false
}

/** Verify saved experimental copper. This does not run or certify a solver. */
export async function verifyG350Am3352PhysicalMilestone(
  routedPath = defaultRoutedPath,
) {
  const started = performance.now()
  const input = loadG350Am3352RepairedSample()
  const nativeSha256 = sha256(JSON.stringify(input))
  if (nativeSha256 !== expectedNativeSha256)
    throw Error(
      "Trusted repaired native input changed; review this milestone explicitly",
    )
  const routedBytes = await readFile(routedPath)
  const output = JSON.parse(routedBytes.toString("utf8")) as SimpleRouteJson
  const traces = (output.traces ?? []).slice(input.traces?.length ?? 0)
  const savedEscapesBytes = await readFile(
    resolve(dirname(routedPath), "fixed-escapes.json"),
  )
  const savedEscapes = JSON.parse(savedEscapesBytes.toString("utf8")) as Trace[]
  const savedEscapesSha256 = sha256(savedEscapesBytes)
  const missingSavedEscapes = savedEscapes
    .filter(
      (escape) =>
        !traces.some(
          (trace) =>
            escape.connection_name !== undefined &&
            trace.connection_name === escape.connection_name &&
            savedEscapeIsPreserved(escape, trace),
        ),
    )
    .map((escape) => escape.pcb_trace_id)
  const validation = validateG350Am3352Sample(input, output)
  const sharedPairSpacing = validation.routeGeometryValid
    ? sharedPairSpacingReports(input, traces)
    : []
  const pairCount = input.differentialPairs?.length ?? 0
  const gates = {
    exactCanonicalSavedEscapes:
      savedEscapes.length === 98 &&
      savedEscapesSha256 === canonicalSavedEscapesSha256,
    all98SavedEscapePathsPreserved:
      savedEscapes.length === 98 && missingSavedEscapes.length === 0,
    all49Connected:
      validation.complete &&
      validation.requestedSignals === 49 &&
      validation.connectedSignals === 49,
    all49ExactlyOneJoinedTrace:
      traces.length === 49 &&
      input.connections.every(
        ({ name }) =>
          traces.filter((trace) => trace.connection_name === name).length === 1,
      ),
    originalGeometryPreserved: validation.geometryPreserved,
    originalFixedCopperPreserved: validation.fixedPreserved,
    routeGeometryValid: validation.routeGeometryValid,
    onlyTopBottomSignals: validation.allowedLayers,
    zeroNativeDrcIssues:
      validation.drc.valid && validation.drc.issues.length === 0,
    drillSpacingValid: validation.drillSpacingValid,
    zeroSelfShorts: validation.selfShorts.length === 0,
    boardBoundaryValid: validation.boundary.valid,
    conventionalAngles: routeAnglesAreConventional(traces),
    differentialPairsMatched:
      validation.pairs.length === pairCount &&
      validation.pairs.every(
        (pair) =>
          pair.matched && pair.withinLengthLimit && pair.aboveMinimumLength,
      ),
    exteriorPairCouplingValid:
      validation.coupling.length === pairCount &&
      validation.coupling.every((pair) => pair.applicable && pair.matched),
    sharedPairSpacingValid:
      sharedPairSpacing.length === pairCount &&
      sharedPairSpacing.every(
        (pair) => pair.sharedSectionPresent && pair.matched,
      ),
  }
  const sourceFiles = [
    "scripts/verify-g350-am3352-physical-milestone.ts",
    "scripts/validate-g350-am3352-sample.ts",
    "scripts/g350-am3352-repaired-sample.ts",
    "scripts/g350-am3352-sample.ts",
    "scripts/check-signal-self-shorts.ts",
    "lib/route-angle-validation.ts",
    "lib/shared-pair-spacing.ts",
    "lib/exterior-pair-spacing.ts",
  ]
  const sourceFilesSha256 = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        sha256(await readFile(resolve(repositoryRoot, path))),
      ]),
    ),
  )
  return {
    physicalRoutingAccepted: Object.values(gates).every(Boolean),
    ddrTimingAccepted: validation.matched,
    overallNativeAcceptance:
      validation.valid &&
      gates.sharedPairSpacingValid &&
      gates.conventionalAngles,
    supportRoutingVerified: false,
    electricalTimingVerified: false,
    fabricationReady: false,
    stage: "experimental-saved-layout-physical-milestone",
    freshSolverGeneration: false,
    sourceLayoutDescription:
      "Previously generated experimental complete layout, freshly checked against the trusted repaired native input. This command does not run a solver.",
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    sourceFilesSha256,
    nativeSha256,
    routedFileSha256: sha256(routedBytes),
    fixedEscapes: {
      expectedCount: 98,
      count: savedEscapes.length,
      canonicalSavedEscapesSha256,
      savedEscapesSha256,
      missingSavedEscapes,
    },
    scope: {
      signals: input.connections.length,
      excludedSupportNets: g350Am3352Metadata.supportNetsUnrouted,
      physicalLayers: input.layerCount,
      signalLayers: input.allowedLayers,
      reservedInnerLayers: ["ground", "power/reference"],
      padObstacles: input.obstacles.length,
      components: new Set(
        input.obstacles.map((obstacle) => obstacle.componentId),
      ).size,
    },
    traceCount: traces.length,
    viaCount: traces.reduce(
      (count, trace) =>
        count +
        trace.route.filter((point) => point.route_type === "via").length,
      0,
    ),
    rules: {
      traceWidthMm: input.minTraceWidth,
      clearanceMm: input.minTraceToPadEdgeClearance,
      viaPadDiameterMm: input.minViaPadDiameter,
      viaHoleDiameterMm: input.minViaHoleDiameter,
      viaHoleEdgeClearanceMm: input.minViaHoleEdgeToViaHoleEdgeClearance,
    },
    gates,
    validation,
    sharedPairSpacing,
    verificationRuntimeSeconds: (performance.now() - started) / 1000,
  }
}

if (import.meta.main) {
  try {
    let routedPath: string | undefined
    let reportPath: string | undefined
    const args = process.argv.slice(2)
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === "--report" && args[index + 1] && !reportPath) {
        reportPath = args[++index]
      } else if (!arg.startsWith("--") && !routedPath) {
        routedPath = arg
      } else {
        throw Error(
          "Usage: bun scripts/verify-g350-am3352-physical-milestone.ts [routed.json] [--report report.json]",
        )
      }
    }
    const report = await verifyG350Am3352PhysicalMilestone(routedPath)
    const json = JSON.stringify(report, null, 2) + "\n"
    if (reportPath) {
      await mkdir(dirname(resolve(reportPath)), { recursive: true })
      await writeFile(reportPath, json)
    }
    process.stdout.write(json)
    process.exitCode = report.physicalRoutingAccepted ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
