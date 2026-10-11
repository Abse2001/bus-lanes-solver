import { createHash } from "node:crypto"
import {
  BusLanesPipelineSolver,
  busLengthReports,
  pairLengthReports,
} from "../lib"
import { g350Am3352Metadata, loadG350Am3352Sample } from "./g350-am3352-sample"
import { validateG350Am3352Sample } from "./validate-g350-am3352-sample"

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

export async function runG350Am3352Repro(
  timeoutSeconds = 120,
  acceptedOutputPath?: string,
) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
    throw Error("Invalid timeout")
  const input = loadG350Am3352Sample()
  const before = hash(input)
  const solver = new BusLanesPipelineSolver(input)
  const started = performance.now()
  let exception: string | null = null
  try {
    while (
      !solver.solved &&
      !solver.failed &&
      performance.now() - started < timeoutSeconds * 1000
    )
      solver.step()
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
        : solver.failed
          ? "failed"
          : solver.solved
            ? "validation_failed"
            : "timed_out",
    solved: solver.solved,
    error: exception ?? solver.error ?? null,
    failureCode: solver.failureCode,
    phase: solver.phase,
    iterations: solver.iterations,
    runtimeMs,
    timeoutSeconds,
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
      !["--timeout-seconds", "--report", "--output"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      options.has(flag)
    )
      throw Error(
        "Usage: bun scripts/repro-g350-am3352.ts [--timeout-seconds 120] [--report /tmp/report.json] [--output /tmp/accepted.json]",
      )
    options.set(flag, value)
  }
  const report = await runG350Am3352Repro(
    Number(options.get("--timeout-seconds") ?? 120),
    options.get("--output"),
  )
  if (options.has("--report"))
    await Bun.write(
      options.get("--report")!,
      JSON.stringify(report, null, 2) + "\n",
    )
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.passed ? 0 : 1
}
