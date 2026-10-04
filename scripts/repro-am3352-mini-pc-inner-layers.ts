import { createHash } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { gunzipSync } from "node:zlib"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  BusLanesPipelineSolver,
  busLengthReports,
  pairLengthReports,
  type BusLanesPipelineOptions,
  type SimpleRouteJson,
  type Trace,
} from "../lib"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { checkSignalSelfShorts } from "./check-signal-self-shorts"
import { measureAm3352RoutingQuality } from "./measure-am3352-routing-quality"

const root = resolve(import.meta.dir, "..")
const fixture = "tests/fixtures/am3352-mini-pc-inner-layers/input.json.gz"
type RunArguments = {
  input: string
  output: string
  options: string | null
  timeoutSeconds: number
  worker: boolean
}
type Progress = {
  elapsedMs: number
  phase: string
  iterations: number
  solved: boolean
  failed: boolean
  failureCode: string | null
  acceptedSignals: number
  reportedTraceCount: number
  error: string | null
  stats: unknown
}

export function validateMiniPcInput(input: SimpleRouteJson): void {
  const layers = ["inner1", "inner2"]
  if (
    input.layerCount !== 4 ||
    JSON.stringify(input.allowedLayers) !== JSON.stringify(layers) ||
    input.connections.length !== 50 ||
    new Set(input.connections.map((connection) => connection.name)).size !==
      50 ||
    input.connections.some(
      (connection) => connection.pointsToConnect.length !== 2,
    ) ||
    (input.traces?.length ?? 0) !== 0 ||
    input.buses?.length !== 4 ||
    input.differentialPairs?.length !== 3
  )
    throw Error(
      "Expected the fresh four-layer, 50-signal mini-PC input with only inner carriers and no saved copper",
    )
  const expected = new Map([
    ["DDR_BYTE0", 11],
    ["DDR_BYTE1", 11],
    ["DDR_ADDR_COMMAND_CLOCK", 27],
    ["LAYER_DDR_RESETn", 1],
  ])
  const members: string[] = []
  for (const bus of input.buses) {
    if (
      bus.connectionNames.length !== expected.get(bus.busId) ||
      JSON.stringify(bus.allowedLayers) !== JSON.stringify(layers) ||
      (bus.busId !== "LAYER_DDR_RESETn" && bus.maxLengthSkew !== 0.635)
    )
      throw Error(
        `Changed mini-PC bus membership, layer permission, or timing bound: ${bus.busId}`,
      )
    members.push(...bus.connectionNames)
  }
  const names = new Set(input.connections.map((connection) => connection.name))
  if (new Set(members).size !== 50 || members.some((name) => !names.has(name)))
    throw Error(
      "The four original buses must partition all 50 signal connections",
    )
  const tolerances = input.differentialPairs
    .map((pair) => pair.lengthTolerance)
    .sort()
  if (JSON.stringify(tolerances) !== JSON.stringify([0.1, 0.127, 0.127]))
    throw Error("The clock/strobe timing bounds changed")
  for (const pair of input.differentialPairs)
    if (
      pair.connectionNames.length !== 2 ||
      pair.connectionNames.some((name) => !names.has(name))
    )
      throw Error("A differential pair references a missing connection")
}

export function inspectMiniPcRoutes(input: SimpleRouteJson, traces: Trace[]) {
  const endpointIssues: string[] = []
  const carrierIssues: string[] = []
  const layerCounts: Record<string, number> = {}
  for (const connection of input.connections) {
    const matching = traces.filter(
      (trace) => trace.connection_name === connection.name,
    )
    if (matching.length !== 1) {
      endpointIssues.push(
        `${connection.name}: expected exactly one complete route, found ${matching.length}`,
      )
      continue
    }
    const route = matching[0].route
    const ends = [route[0], route.at(-1)]
    for (const terminal of connection.pointsToConnect)
      if (
        !ends.some(
          (point) =>
            point?.route_type === "wire" &&
            Math.hypot(point.x - terminal.x, point.y - terminal.y) <= 1e-7 &&
            (terminal.layers ?? [terminal.layer]).includes(point.layer),
        )
      )
        endpointIssues.push(
          `${connection.name}: disconnected native pad endpoint`,
        )
    const vias = route.flatMap((point, index) =>
      point.route_type === "via" ? [index] : [],
    )
    const carrier = vias.length === 2 ? route.slice(vias[0] + 1, vias[1]) : []
    const first = carrier[0]
    if (
      first?.route_type !== "wire" ||
      !["inner1", "inner2"].includes(first.layer) ||
      carrier.some(
        (point) => point.route_type !== "wire" || point.layer !== first.layer,
      )
    )
      carrierIssues.push(
        `${connection.name}: expected two local dogbones and one inner-layer carrier`,
      )
    else layerCounts[first.layer] = (layerCounts[first.layer] ?? 0) + 1
  }
  if (traces.length !== 50)
    endpointIssues.push(`Expected 50 routes; found ${traces.length}`)
  return {
    complete: endpointIssues.length === 0,
    innerCarriersOnly: traces.length === 50 && carrierIssues.length === 0,
    endpointIssues,
    carrierIssues,
    layerCounts,
  }
}

function parseArguments(): RunArguments {
  const args = process.argv.slice(2)
  const values: RunArguments = {
    input: resolve(root, fixture),
    output: resolve(
      root,
      ".cache/am3352-mini-pc-inner-layers/defaults-report.json",
    ),
    options: resolve(
      root,
      "tests/fixtures/am3352-mini-pc-inner-layers/default-options.json",
    ),
    timeoutSeconds: Number(process.env.MINI_PC_REPRO_SECONDS ?? "240"),
    worker: false,
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--worker") {
      values.worker = true
      continue
    }
    if (
      !["--input", "--output", "--options", "--timeout-seconds"].includes(
        args[i],
      )
    )
      throw Error(`Unknown argument: ${args[i]}`)
    const value = args[++i]
    if (!value || value.startsWith("--"))
      throw Error(`Missing value after ${args[i - 1]}`)
    if (args[i - 1] === "--input") values.input = resolve(value)
    if (args[i - 1] === "--output") values.output = resolve(value)
    if (args[i - 1] === "--options") values.options = resolve(value)
    if (args[i - 1] === "--timeout-seconds")
      values.timeoutSeconds = Number(value)
  }
  if (!(values.timeoutSeconds > 0) || !Number.isFinite(values.timeoutSeconds))
    throw Error("Expected a positive routing timeout")
  return values
}

async function runWorker(args: RunArguments): Promise<void> {
  const inputBytes = Buffer.from(await Bun.file(args.input).arrayBuffer())
  const inputText = (
    args.input.endsWith(".gz") ? gunzipSync(inputBytes) : inputBytes
  ).toString("utf8")
  const input = JSON.parse(inputText) as SimpleRouteJson
  validateMiniPcInput(input)
  const options: BusLanesPipelineOptions = args.options
    ? await Bun.file(args.options).json()
    : {}
  const before = JSON.stringify(input)
  const solver = new BusLanesPipelineSolver(input, options)
  const started = performance.now()
  let lastProgress = -Infinity
  let lastPhase = ""
  const sourceHash = createHash("sha256")
  const files = Array.from(
    new Bun.Glob("lib/**/*.ts").scanSync({ cwd: root }),
  ).sort()
  for (const file of files)
    sourceHash
      .update(file + "\0")
      .update(Buffer.from(await Bun.file(resolve(root, file)).arrayBuffer()))
  const progress = (): Progress => ({
    elapsedMs: performance.now() - started,
    phase: solver.phase,
    iterations: solver.iterations,
    solved: solver.solved,
    failed: solver.failed,
    failureCode: solver.failureCode,
    acceptedSignals: solver.solved && !solver.failed ? solver.traces.length : 0,
    reportedTraceCount: solver.traces.length,
    error: solver.error == null ? null : String(solver.error),
    stats: solver.stats,
  })
  while (
    !solver.solved &&
    !solver.failed &&
    performance.now() - started < args.timeoutSeconds * 1000
  ) {
    solver.step()
    if (
      solver.phase !== lastPhase ||
      performance.now() - lastProgress >= 5000
    ) {
      await Bun.write(
        args.output + ".progress.json",
        JSON.stringify(progress(), null, 2) + "\n",
      )
      lastPhase = solver.phase
      lastProgress = performance.now()
    }
  }
  const beforeFinalAcceptance = progress()
  const budgetExpired = !solver.solved && !solver.failed
  if (budgetExpired) solver.tryFinalAcceptance()
  const solved = solver.solved && !solver.failed
  const output = solved ? solver.getOutput() : null
  const signals = solved ? solver.traces : []
  const shape = inspectMiniPcRoutes(input, signals)
  const busReports = busLengthReports(input, signals)
  const pairReports = pairLengthReports(input, signals)
  const copperDrc = output
    ? validateRoutedCopperDrc({
        inputSrj: input as Parameters<
          typeof validateRoutedCopperDrc
        >[0]["inputSrj"],
        routedSrj: output as Parameters<
          typeof validateRoutedCopperDrc
        >[0]["routedSrj"],
        clearance: input.minTraceToPadEdgeClearance ?? 0.1,
        allowBlindAndBuriedVias: false,
      })
    : null
  const selfShorts = solved ? checkSignalSelfShorts(input, signals) : null
  const quality = solved ? measureAm3352RoutingQuality(input, signals) : null
  const timingPassed =
    solved &&
    busReports.every(
      (bus) =>
        (bus.toleranceMm === null || bus.matched) &&
        bus.aboveMinimumLength &&
        bus.withinLengthLimit,
    ) &&
    pairReports.every((pair) => pair.matched)
  const inputUnchanged =
    before === JSON.stringify(input) && before === JSON.stringify(solver.input)
  const passed =
    solved &&
    shape.complete &&
    shape.innerCarriersOnly &&
    timingPassed &&
    inputUnchanged &&
    copperDrc?.valid === true &&
    selfShorts?.length === 0 &&
    quality?.issues.length === 0 &&
    routeAnglesAreConventional(signals)
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root })
  if (head.exitCode !== 0) throw Error("Cannot identify repository revision")
  const report = {
    case: "am3352-mini-pc-90deg-inner-layers",
    passed,
    status: passed
      ? "passed"
      : solved
        ? "validation_failed"
        : budgetExpired
          ? "budget_exhausted"
          : "native_failure",
    stopReason: budgetExpired ? "wall_clock_budget" : "native_terminal_state",
    budgetExpired,
    finalAcceptanceRequested: budgetExpired,
    beforeFinalAcceptance,
    ...progress(),
    requestedSignals: input.connections.length,
    inputSha256: createHash("sha256").update(inputText).digest("hex"),
    solverSourceSha256: sourceHash.digest("hex"),
    repositoryRevision: head.stdout.toString().trim(),
    packageVersion: (await Bun.file(resolve(root, "package.json")).json())
      .version,
    bunVersion: Bun.version,
    options,
    timeoutSeconds: args.timeoutSeconds,
    inputUnchanged,
    shape,
    timingPassed,
    busReports,
    pairReports,
    copperDrc,
    selfShorts,
    quality,
    limitations: [
      "This measures routed planar copper. Via depth, propagation delay, impedance, return paths and board power connectivity need separate checks.",
    ],
  }
  await Bun.write(args.output, JSON.stringify(report, null, 2) + "\n")
  if (passed)
    await Bun.write(
      args.output.replace(/\.json$/, "") + ".routes.json",
      JSON.stringify(output, null, 2) + "\n",
    )
  console.log(
    JSON.stringify({
      status: report.status,
      acceptedSignals: report.acceptedSignals,
      requestedSignals: report.requestedSignals,
      phase: report.phase,
      elapsedMs: report.elapsedMs,
      error: report.error,
      output: args.output,
    }),
  )
  if (!passed) process.exitCode = 1
}

if (import.meta.main) {
  const args = parseArguments()
  await mkdir(dirname(args.output), { recursive: true })
  if (args.worker) await runWorker(args)
  else {
    for (const file of [
      args.output,
      args.output + ".progress.json",
      args.output.replace(/\.json$/, "") + ".routes.json",
    ])
      await rm(file, { force: true })
    const child = Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        ...process.argv.slice(2),
        "--worker",
      ],
      { cwd: root, stdout: "inherit", stderr: "pipe" },
    )
    let killed = false
    const timer = setTimeout(
      () => {
        killed = true
        child.kill()
      },
      (args.timeoutSeconds + 30) * 1000,
    )
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    if (stderr) console.error(stderr)
    if (killed || (exitCode !== 0 && !(await Bun.file(args.output).exists()))) {
      const progressFile = Bun.file(args.output + ".progress.json")
      await Bun.write(
        args.output,
        JSON.stringify(
          {
            passed: false,
            status: killed ? "process_deadline_exceeded" : "worker_failed",
            exitCode,
            acceptedSignals: 0,
            timeoutSeconds: args.timeoutSeconds,
            error: stderr,
            lastProgress: (await progressFile.exists())
              ? await progressFile.json()
              : null,
          },
          null,
          2,
        ) + "\n",
      )
    }
    process.exitCode = exitCode === 0 && !killed ? 0 : 1
  }
}
