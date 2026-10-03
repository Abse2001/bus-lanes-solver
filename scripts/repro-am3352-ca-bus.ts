import { BusLanesPipelineSolver, type SimpleRouteJson } from "../lib"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { am3352Hash, loadAm3352Sample } from "./am3352-samples"
import {
  validateAm3352OutputShape,
  validateAm3352Sample,
} from "./validate-am3352-sample"

/** Add only the missing clocked address/control timing group. Native pads,
 * signal identities, byte/pair rules, and fixed power fanouts stay identical.
 * This requests geometric skew matching, not full TI DDR electrical signoff.
 */
export function withAm3352CaBus(
  input: SimpleRouteJson,
  signalNames: Record<string, string>,
): SimpleRouteJson {
  const result = structuredClone(input)
  const signals = new Set([
    ...Array.from({ length: 13 }, (_, i) => `DDR_A${i}`),
    "DDR_BA0",
    "DDR_BA1",
    "DDR_BA2",
    "DDR_CSn0",
    "DDR_CASn",
    "DDR_RASn",
    "DDR_WEn",
    "DDR_CKE",
    "DDR_ODT",
    "DDR_CK",
    "DDR_CKn",
  ])
  const connections = result.connections.filter((c) =>
    signals.has(signalNames[c.name]),
  )
  if (
    connections.length !== 24 ||
    new Set(connections.map((c) => signalNames[c.name])).size !== 24
  )
    throw Error("Expected all 24 AM3352 address/control/clock signals")
  if (result.buses?.some((b) => b.busId === "DDR_ADDR_CTRL_CK"))
    throw Error("Address/control/clock bus already exists")
  result.buses = [
    ...(result.buses ?? []),
    {
      busId: "DDR_ADDR_CTRL_CK",
      name: "DDR_ADDR_CTRL_CK",
      connectionNames: connections.map((c) => c.name),
      maxLengthSkew: 0.635,
      allowedLayers: ["inner1", "inner2"],
    },
  ]
  return result
}

export async function runCaBusCase(
  completeCa: boolean,
  timeoutSeconds: number,
) {
  const { input: baseline, metadata } = await loadAm3352Sample("inner-layers")
  // The benchmark validator deliberately requires exactly its two original
  // buses. Validate that immutable fixture first, then check the extra bus
  // independently; never change the benchmark validator to accept bad inputs.
  const initialValidation = await validateAm3352Sample(baseline, metadata)
  if (!initialValidation.fixedDrc.valid)
    throw Error("Invalid baseline power copper")
  const input = completeCa
    ? withAm3352CaBus(baseline, metadata.signalNames)
    : baseline
  const before = am3352Hash(input)
  const solver = new BusLanesPipelineSolver(input)
  const start = performance.now()
  while (
    !solver.solved &&
    !solver.failed &&
    performance.now() - start < timeoutSeconds * 1000
  )
    solver.step()
  const runtimeMs = performance.now() - start
  const buses = busLengthReports(input, solver.traces)
  const pairs = pairLengthReports(input, solver.traces)
  let validation: Awaited<ReturnType<typeof validateAm3352Sample>> | null = null
  let fixedPowerPreserved =
    am3352Hash(solver.input.traces) === am3352Hash(baseline.traces)
  if (solver.solved) {
    // All copper/connectivity/byte/pair/coupling audits use the unchanged
    // reference. The added CA skew bound is included in `buses` below.
    validation = await validateAm3352Sample(baseline, metadata, solver.traces)
    const output = solver.getOutput()
    validateAm3352OutputShape(input, metadata, solver.traces, output)
    fixedPowerPreserved &&=
      am3352Hash(output.traces!.slice(0, baseline.traces!.length)) ===
      am3352Hash(baseline.traces)
  }
  const inputUnchanged = am3352Hash(input) === before
  const passed =
    solver.solved &&
    !solver.failed &&
    validation?.valid === true &&
    inputUnchanged &&
    fixedPowerPreserved &&
    [...buses, ...pairs].every((b) => b.matched)
  const report = {
    case: completeCa ? "complete-ca" : "baseline",
    passed,
    status: passed
      ? "passed"
      : solver.failed
        ? "failed"
        : solver.solved
          ? "validation_failed"
          : "timed_out",
    solved: solver.solved,
    error: solver.error,
    phase: solver.phase,
    iterations: solver.iterations,
    runtimeMs,
    timeoutSeconds,
    requestedSignals: input.connections.length,
    routedSignals: solver.traces.length,
    allowedLayers: input.allowedLayers,
    fixedPowerDogbones: baseline.traces!.length,
    inputUnchanged,
    fixedPowerPreserved,
    geometryAndFixedCopperHash: am3352Hash({ ...input, buses: undefined }),
    busMembership: input.buses!.map((b) => ({
      name: b.busId,
      count: b.connectionNames.length,
      maxLengthSkew: b.maxLengthSkew,
    })),
    buses,
    pairs,
    fixedDrcValid: initialValidation.fixedDrc.valid,
    validation,
    notVerified: [
      "TI absolute-length limits",
      "Stackup/impedance, reference planes, package/via delays and signal integrity",
    ],
  }
  if (!solver.solved && !solver.failed) solver.tryFinalAcceptance()
  return report
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
  const timeout = Number(value("--timeout-seconds", "120"))
  if (!(timeout > 0) || !Number.isFinite(timeout))
    throw Error("Invalid timeout")
  const worker = value("--worker", "")
  const output = value("--output", "am3352-ca-repro.json")
  for (let i = 0; i < args.length; i++) {
    if (["--worker", "--output", "--timeout-seconds"].includes(args[i])) i++
    else throw Error(`Unknown option: ${args[i]}`)
  }
  if (worker) {
    if (!["baseline", "complete-ca"].includes(worker))
      throw Error("Unknown case")
    console.log(
      "REPORT " +
        JSON.stringify(await runCaBusCase(worker === "complete-ca", timeout)),
    )
  } else {
    const reports = []
    for (const name of ["baseline", "complete-ca"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          import.meta.path,
          "--worker",
          name,
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
              case: name,
              passed: false,
              status: killed ? "timed_out" : "worker_failed",
              error: killed
                ? "Process deadline exceeded"
                : stderr || `Worker exited ${exitCode}`,
            }
      reports.push(report)
      console.log(
        `${name}: ${report.status}; ${report.routedSignals ?? 0}/47 signals; ${((report.runtimeMs ?? 0) / 1000).toFixed(3)}s`,
      )
      await Bun.write(output, JSON.stringify(reports, null, 2) + "\n")
    }
    // This is a reproduction, not an expected-failure test: it turns green
    // only when both complete outputs pass the independent acceptance gates.
    if (reports.some((r) => !r.passed)) process.exitCode = 1
  }
}
