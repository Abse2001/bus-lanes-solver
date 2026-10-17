import { createHash } from "node:crypto"
import { copyFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  BusLanesPipelineSolver,
  busLengthReports,
  pairLengthReports,
  type BusLanesPipelineOptions,
} from "../lib"
import { g350Am3352Metadata, loadG350Am3352Sample } from "./g350-am3352-sample"
import { validateG350Am3352Sample } from "./validate-g350-am3352-sample"
import {
  deriveG350Am3352DataSwizzle,
  g350OriginalCpuToRamDq,
} from "./g350-am3352-data-swizzle"

export interface G350ReproductionOptions {
  pinMapping?: "original" | "repaired"
  netlistDirectory?: string
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

export async function runG350Am3352Repro(
  timeoutSeconds = 120,
  acceptedOutputPath?: string,
  options: BusLanesPipelineOptions = {},
  reproduction: G350ReproductionOptions = {},
) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
    throw Error("Invalid timeout")
  const pinMapping = reproduction.pinMapping ?? "repaired"
  if (!["original", "repaired"].includes(pinMapping))
    throw Error("Invalid G350 pin mapping")
  const derived = deriveG350Am3352DataSwizzle(
    pinMapping === "original" ? g350OriginalCpuToRamDq : undefined,
  )
  const input =
    pinMapping === "original" ? loadG350Am3352Sample() : derived.input
  if (reproduction.netlistDirectory) {
    await mkdir(reproduction.netlistDirectory, { recursive: true })
    for (const [name, value] of [
      ["native-input.json", input],
      ["circuit.json", derived.circuitJson],
      ["data-bit-mapping.json", derived.manifest],
    ] as const)
      await Bun.write(
        join(reproduction.netlistDirectory, name),
        JSON.stringify(value, null, 2) + "\n",
      )
    await copyFile(
      new URL("../tests/fixtures/g350-am3352/LICENSE", import.meta.url),
      join(reproduction.netlistDirectory, "LICENSE"),
    )
  }
  const before = hash(input)
  const solver = new BusLanesPipelineSolver(input, options)
  const started = performance.now()
  let exception: string | null = null
  let timedOut = false
  try {
    while (
      !solver.solved &&
      !solver.failed &&
      performance.now() - started < timeoutSeconds * 1000
    )
      solver.step()
    timedOut = !solver.solved && !solver.failed
    // A completed, validated routing snapshot may already exist while optional
    // envelope optimization is running. The pipeline can restore only that
    // accepted snapshot; interrupted search prefixes remain unavailable.
    if (timedOut) solver.tryFinalAcceptance()
  } catch (error) {
    exception = error instanceof Error ? error.message : String(error)
  }
  const runtimeMs = performance.now() - started
  // Incomplete solver internals are diagnostics, never accepted routing output.
  const output =
    solver.solved && !solver.failed && !exception ? solver.getOutput() : null
  const validation = output ? validateG350Am3352Sample(input, output) : null
  const inputUnchanged = hash(input) === before
  const passed = validation?.valid === true && inputUnchanged
  const report = {
    sample: "g350-am3352",
    passed,
    status: passed
      ? "passed"
      : exception
        ? "exception"
        : timedOut
          ? "timed_out"
          : solver.failed
            ? "failed"
            : solver.solved
              ? "validation_failed"
              : "timed_out",
    solved: solver.solved,
    error: exception ?? solver.error ?? null,
    failureCode: solver.failureCode,
    phase: solver.phase,
    surfaceRouting: options.surfaceRouting ?? "auto",
    pinMapping,
    dataBitMapping: derived.manifest,
    stats: solver.stats,
    iterations: solver.iterations,
    runtimeMs,
    timeoutSeconds,
    timeoutStoppedOptimization: timedOut && passed,
    inputUnchanged,
    requestedSignals: 49,
    connectedSignals: validation?.connectedSignals ?? null,
    partialTraceCount: solver.traces.length,
    allowedLayers: input.allowedLayers,
    components: g350Am3352Metadata.supportComponents,
    obstacles: input.obstacles.length,
    supportNetsUnrouted: g350Am3352Metadata.supportNetsUnrouted,
    inputSha256: before,
    captureSha256: g350Am3352Metadata.filesSha256["native-input.json"],
    drc: validation?.drc ?? null,
    buses:
      validation?.buses ??
      busLengthReports(input, []).filter((b) => b.toleranceMm !== null),
    pairs: validation?.pairs ?? pairLengthReports(input, []),
    validation,
    fabricationReady: false,
    notVerified: [
      "Power/ground/clock/reset support routing",
      "Electrical timing, impedance and return paths",
      "Via-in-pad fabrication and BGA solderability",
      "Full-board manufacturing qualification",
    ],
  }
  if (passed && acceptedOutputPath)
    await Bun.write(acceptedOutputPath, JSON.stringify(output, null, 2) + "\n")
  return report
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1]
    if (
      ![
        "--timeout-seconds",
        "--report",
        "--output",
        "--surface-strategy",
        "--pin-mapping",
        "--netlist-directory",
      ].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      options.has(flag)
    )
      throw Error(
        "Usage: bun scripts/repro-g350-am3352.ts [--timeout-seconds 120] [--surface-strategy auto|sites|joint] [--pin-mapping original|repaired] [--netlist-directory /tmp/g350-netlist] [--report /tmp/report.json] [--output /tmp/accepted.json]",
      )
    options.set(flag, value)
  }
  const strategy = options.get("--surface-strategy") ?? "auto"
  if (!["auto", "sites", "joint"].includes(strategy))
    throw Error("Invalid surface strategy")
  const pinMapping = options.get("--pin-mapping") ?? "repaired"
  if (!["original", "repaired"].includes(pinMapping))
    throw Error("Invalid G350 pin mapping")
  const report = await runG350Am3352Repro(
    Number(options.get("--timeout-seconds") ?? 120),
    options.get("--output"),
    {
      surfaceRouting: strategy as NonNullable<
        BusLanesPipelineOptions["surfaceRouting"]
      >,
    },
    {
      pinMapping: pinMapping as "original" | "repaired",
      netlistDirectory: options.get("--netlist-directory"),
    },
  )
  if (options.has("--report"))
    await Bun.write(
      options.get("--report")!,
      JSON.stringify(report, null, 2) + "\n",
    )
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.passed ? 0 : 1
}
