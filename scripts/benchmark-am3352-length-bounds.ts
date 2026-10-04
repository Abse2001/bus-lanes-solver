import { writeFile } from "node:fs/promises"
import { BusLanesPipelineSolver } from "../lib"
import { loadAm3352Sample } from "./am3352-samples"
import { validateAm3352Sample } from "./validate-am3352-sample"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { measureAm3352RoutingQuality } from "./measure-am3352-routing-quality"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"

// TI AM335x Table 7-69 project geometry policy: DQLM includes DQ/DM,
// CA nominal is longest Manhattan + 7.62 mm, ±1.27 mm and ≤63.5 mm.
// A trial allowance is reported separately and never changes strict acceptance.
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const allowance = Number(option("--allowance-mm", "0"))
const seconds = Number(option("--timeout-seconds", "300"))
const output = option("--output", "am3352-length-bounds.json")
if (
  !Number.isFinite(allowance) ||
  allowance < 0 ||
  !Number.isFinite(seconds) ||
  seconds <= 0
)
  throw Error("Expected a nonnegative allowance and positive timeout")
const { input, metadata } = await loadAm3352Sample("inner-layers-complete-ca")
// Audit the source fixture before applying the rigid native-package transform.
await validateAm3352Sample(input, metadata)
const rotated = process.argv.includes("--rotated-sbc")
if (rotated) {
  const ramId = metadata.powerPadManifest.find(
    (p) => p.component === "ram",
  )!.componentId
  const ports = new Set(
    input.obstacles
      .filter((o) => o.componentId === ramId)
      .map((o) => (o as any).circuitJsonMetadata?.pcb_port_id),
  )
  const power = new Set(
    metadata.powerPadManifest
      .filter((p) => p.component === "ram")
      .map((p) => p.connectionName),
  )
  const move = (p: { x: number; y: number }) => {
    const x = p.x,
      y = p.y + 27
    p.x = -10 + y
    p.y = -32 - x
  }
  for (const obstacle of input.obstacles)
    if (obstacle.componentId === ramId) {
      move(obstacle.center)
      ;[obstacle.width, obstacle.height] = [obstacle.height, obstacle.width]
      for (const p of obstacle.points ?? []) move(p)
    }
  for (const c of input.connections)
    for (const p of c.pointsToConnect) if (ports.has(p.pcb_port_id)) move(p)
  for (const t of input.traces ?? [])
    if (power.has(t.connection_name!)) for (const p of t.route) move(p)
  for (const c of metadata.powerConnections)
    if (power.has(c.name)) for (const p of c.pointsToConnect) move(p)
  input.bounds = { minX: -50, maxX: 50, minY: -40, maxY: 40 }
}
const strict = structuredClone(input)
for (const bus of strict.buses!) {
  const ca = bus.busId === "DDR_ADDR_CTRL_CK"
  const members = strict.connections.filter(
    (c) =>
      bus.connectionNames.includes(c.name) &&
      (ca || !/^DDR_DQSn?/.test(metadata.signalNames[c.name])),
  )
  const manhattan = Math.max(
    ...members.map((c) => {
      const [a, b] = c.pointsToConnect
      return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    }),
  )
  bus.minLength = ca ? manhattan + 6.35 : 0
  bus.maxLength = ca ? Math.min(manhattan + 8.89, 63.5) : manhattan
  bus.allowedLayers = ["inner1", "inner2"]
}
const trial = structuredClone(strict)
for (const bus of trial.buses!) bus.maxLength! += allowance
const solver = new BusLanesPipelineSolver(trial, {
  maxSearchIterations: 2_000_000,
  maxLaneIterations: 1_000_000,
})
const start = performance.now()
while (
  !solver.solved &&
  !solver.failed &&
  performance.now() - start < seconds * 1000
)
  solver.step()
solver.tryFinalAcceptance()
const native = {
  ...input,
  connections: [...input.connections, ...metadata.powerConnections],
}
const same = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y) < 1e-7
const complete =
  solver.solved &&
  solver.traces.length === 47 &&
  input.connections.every((c) => {
    const routes = solver.traces.filter((t) => t.connection_name === c.name)
    return (
      routes.length === 1 &&
      c.pointsToConnect.every((p) =>
        [routes[0].route[0], routes[0].route.at(-1)!].some(
          (q) => q.route_type === "wire" && q.layer === p.layer && same(p, q),
        ),
      )
    )
  })
const routing =
  solver.solved &&
  solver.traces.every((t) => {
    const vias = t.route.flatMap((p, i) => (p.route_type === "via" ? [i] : []))
    if (vias.length !== 2) return false
    const carrier = t.route.slice(vias[0] + 1, vias[1]),
      layer = (carrier[0] as any)?.layer
    return (
      ["inner1", "inner2"].includes(layer) &&
      carrier.every(
        (p) =>
          p.route_type === "wire" &&
          p.layer === layer &&
          Math.abs(p.width - 0.1) < 1e-8,
      ) &&
      tuningPathIsSelfClear(carrier, 0.2)
    )
  })
const copper = solver.solved
  ? validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: { ...native, traces: [...input.traces!, ...solver.traces] },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as any)
  : null
const pairs = solver.solved ? pairLengthReports(input, solver.traces) : []
const quality = solver.solved
  ? measureAm3352RoutingQuality(input, solver.traces)
  : null
const fixedPowerPreserved =
  solver.solved &&
  JSON.stringify(solver.getOutput().traces?.slice(0, input.traces!.length)) ===
    JSON.stringify(input.traces)
const validation = {
  valid:
    complete &&
    routing &&
    !!copper?.valid &&
    pairs.length === 3 &&
    pairs.every((p) => p.matched) &&
    fixedPowerPreserved &&
    quality?.issues.length === 0,
  complete,
  routing,
  copper,
  pairs,
  fixedPowerPreserved,
  quality,
}
const coupling = solver.solved
  ? exteriorPairSpacingReports(input, solver.traces)
  : null
// Full pad-to-pad output already contains escapes. Do not count fixed escapes twice.
const strictLengths = solver.solved
  ? busLengthReports(strict, solver.traces)
  : null
const lengthsPass =
  strictLengths?.every(
    (b) => b.matched && b.aboveMinimumLength && b.withinLengthLimit,
  ) ?? false
const physicalPass =
  !!validation?.valid && !!coupling?.every((p) => p.applicable && p.matched)
const report = {
  sample: rotated ? "rotated-sbc" : metadata.name,
  allowanceMm: allowance,
  solved: solver.solved,
  error: String(solver.error ?? ""),
  elapsedMs: performance.now() - start,
  phase: solver.phase,
  iterations: solver.iterations,
  signalCount: solver.traces.length,
  trialPassed: solver.solved && physicalPass,
  strictGeometryPassed: solver.solved && physicalPass && lengthsPass,
  validation,
  coupling,
  strictLengths,
  limitations: [
    "Controlled impedance, stackup, reference continuity and electrical SI are separate checks.",
  ],
}
await writeFile(output, JSON.stringify(report, null, 2) + "\n")
if (report.trialPassed) {
  await writeFile(
    output.replace(/\.json$/, "") + ".srj.json",
    JSON.stringify(trial),
  )
  await writeFile(
    output.replace(/\.json$/, "") + ".routes.json",
    JSON.stringify(solver.traces),
  )
}
console.log(
  JSON.stringify({
    ...report,
    validation: validation?.valid,
    coupling: coupling?.map((p) => p.matched),
  }),
)
if (!report.strictGeometryPassed) process.exitCode = 3
