import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { gunzipSync } from "node:zlib"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  BusLanesPipelineSolver,
  type SimpleRouteJson,
  type Trace,
} from "../lib"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { am3352Hash } from "./am3352-samples"
import { checkSignalSelfShorts } from "./check-signal-self-shorts"
import { measureAm3352RoutingQuality } from "./measure-am3352-routing-quality"
import provenance from "../tests/fixtures/am3352-mini-pc-inner-layers/provenance.json"

export async function loadMiniPcInput(): Promise<SimpleRouteJson> {
  const bytes = await Bun.file(
    new URL(
      "../tests/fixtures/am3352-mini-pc-inner-layers/input.json.gz",
      import.meta.url,
    ),
  ).arrayBuffer()
  const text = gunzipSync(Buffer.from(bytes)).toString("utf8")
  if (
    createHash("sha256").update(text).digest("hex") !== provenance.inputSha256
  )
    throw Error("Mini-PC fixture differs from its recorded capture")
  return JSON.parse(text)
}

export function hasCompleteInnerRoutes(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  return (
    traces.length === input.connections.length &&
    input.connections.every((connection) => {
      const matches = traces.filter(
        (trace) => trace.connection_name === connection.name,
      )
      if (matches.length !== 1) return false
      const route = matches[0].route
      const ends = [route[0], route.at(-1)]
      if (
        !connection.pointsToConnect.every((terminal) =>
          ends.some(
            (point) =>
              point?.route_type === "wire" &&
              Math.hypot(point.x - terminal.x, point.y - terminal.y) < 1e-7 &&
              (terminal.layers ?? [terminal.layer]).includes(point.layer),
          ),
        )
      )
        return false
      const vias = route.flatMap((point, index) =>
        point.route_type === "via" ? [index] : [],
      )
      const carrier = vias.length === 2 ? route.slice(vias[0] + 1, vias[1]) : []
      const first = carrier[0]
      return (
        first?.route_type === "wire" &&
        ["inner1", "inner2"].includes(first.layer) &&
        carrier.every(
          (point) => point.route_type === "wire" && point.layer === first.layer,
        )
      )
    })
  )
}

export async function runMiniPcCase(timeoutSeconds: number) {
  const input = await loadMiniPcInput()
  const before = am3352Hash(input)
  const solver = new BusLanesPipelineSolver(input)
  const start = performance.now()
  while (
    !solver.solved &&
    !solver.failed &&
    performance.now() - start < timeoutSeconds * 1000
  )
    solver.step()
  const budgetExpired = !solver.solved && !solver.failed
  if (budgetExpired) solver.tryFinalAcceptance()
  const solved = solver.solved && !solver.failed
  const traces = solved ? solver.traces : []
  const complete = solved && hasCompleteInnerRoutes(input, traces)
  const buses = busLengthReports(input, traces)
  const pairs = pairLengthReports(input, traces)
  const matched =
    solved &&
    buses.every(
      (bus) =>
        (bus.toleranceMm === null || bus.matched) &&
        bus.aboveMinimumLength &&
        bus.withinLengthLimit,
    ) &&
    pairs.every((pair) => pair.matched)
  const drc = solved
    ? validateRoutedCopperDrc({
        inputSrj: input as Parameters<
          typeof validateRoutedCopperDrc
        >[0]["inputSrj"],
        routedSrj: solver.getOutput() as Parameters<
          typeof validateRoutedCopperDrc
        >[0]["routedSrj"],
        clearance: input.minTraceToPadEdgeClearance ?? 0.1,
        allowBlindAndBuriedVias: false,
      })
    : null
  const selfShorts = solved ? checkSignalSelfShorts(input, traces) : null
  const quality = solved ? measureAm3352RoutingQuality(input, traces) : null
  const inputUnchanged =
    before === am3352Hash(input) && before === am3352Hash(solver.input)
  const passed =
    complete &&
    matched &&
    inputUnchanged &&
    drc?.valid === true &&
    selfShorts?.length === 0 &&
    quality?.issues.length === 0
  return {
    passed,
    status: passed
      ? "passed"
      : solved
        ? "validation_failed"
        : budgetExpired
          ? "timed_out"
          : "failed",
    solved,
    error: solver.error,
    failureCode: solver.failureCode,
    phase: solver.phase,
    iterations: solver.iterations,
    runtimeMs: performance.now() - start,
    timeoutSeconds,
    requestedSignals: input.connections.length,
    routedSignals: traces.length,
    inputUnchanged,
    inputSha256: provenance.inputSha256,
    complete,
    matched,
    buses,
    pairs,
    drc,
    selfShorts,
    quality,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    if (index < 0) return fallback
    if (!args[index + 1] || args[index + 1].startsWith("--"))
      throw Error(`Missing ${name}`)
    return args[index + 1]
  }
  const timeout = Number(value("--timeout-seconds", "240"))
  if (!(timeout > 0) || !Number.isFinite(timeout))
    throw Error("Invalid timeout")
  const output = value(
    "--output",
    ".cache/am3352-mini-pc-inner-layers/repro.json",
  )
  for (let i = 0; i < args.length; i++) {
    if (["--output", "--timeout-seconds"].includes(args[i])) i++
    else if (args[i] !== "--worker") throw Error(`Unknown option: ${args[i]}`)
  }
  if (args.includes("--worker")) {
    console.log("REPORT " + JSON.stringify(await runMiniPcCase(timeout)))
  } else {
    const child = Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        "--worker",
        "--timeout-seconds",
        String(timeout),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    let killed = false
    const timer = setTimeout(
      () => {
        killed = true
        child.kill()
      },
      (timeout + 15) * 1000,
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timer)
    const line = stdout.split("\n").find((line) => line.startsWith("REPORT "))
    const report =
      exitCode === 0 && line
        ? JSON.parse(line.slice(7))
        : {
            passed: false,
            status: killed ? "timed_out" : "worker_failed",
            error: killed
              ? "Process deadline exceeded"
              : stderr || `Worker exited ${exitCode}`,
          }
    await mkdir(dirname(output), { recursive: true })
    await Bun.write(output, JSON.stringify(report, null, 2) + "\n")
    console.log(
      `${report.status}; ${report.routedSignals ?? 0}/50 signals; ${((report.runtimeMs ?? 0) / 1000).toFixed(3)}s`,
    )
    if (!report.passed) process.exitCode = 1
  }
}
