import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type { BusLanesPipelineSolver, SimpleRouteJson } from "../lib"

const args = process.argv.slice(2)
const inputPath = args[0]
if (!inputPath)
  throw Error(
    "Usage: bun scripts/benchmark-pipeline.ts <input.json> [--solver <module>] [--output <completed.json>]",
  )
const option = (name: string) => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw Error(`Missing value for ${name}`)
  return args[index + 1]
}
const modulePath = option("--solver")
const module = await import(
  modulePath ? resolve(modulePath) : resolve(import.meta.dir, "../lib/index.ts")
)
const inputText = await Bun.file(inputPath).text()
const input: SimpleRouteJson = JSON.parse(inputText)
const solver: BusLanesPipelineSolver = new module.BusLanesPipelineSolver(input)
const phases: Record<string, number> = {}
const start = performance.now()
const cpuStart = process.cpuUsage()
while (!solver.solved && !solver.failed) {
  if (performance.now() - start > 120_000)
    throw Error("Pipeline benchmark exceeded 120 seconds")
  const phase = solver.phase
  const before = performance.now()
  solver.step()
  phases[phase] = (phases[phase] ?? 0) + performance.now() - before
}
const solveMilliseconds = performance.now() - start
const cpu = process.cpuUsage(cpuStart)
if (!solver.solved) throw Error(solver.error ?? "Pipeline failed")
if (
  solver.traces.length !== input.connections.length ||
  input.connections.some(
    (connection) =>
      solver.traces.filter((trace) => trace.connection_name === connection.name)
        .length !== 1,
  )
)
  throw Error("Pipeline did not complete every connection exactly once")
const output = JSON.stringify(solver.getOutput())
const outputPath = option("--output")
if (outputPath) await Bun.write(outputPath, output)
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex")
console.log(
  JSON.stringify({
    solveMilliseconds,
    cpuMilliseconds: (cpu.user + cpu.system) / 1000,
    phaseMilliseconds: phases,
    iterations: solver.iterations,
    routedConnections: solver.traces.length,
    inputSha256: sha256(inputText),
    outputSha256: sha256(output),
  }),
)
