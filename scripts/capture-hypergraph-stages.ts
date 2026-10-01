import { mkdir } from "node:fs/promises"
import { getPngBufferFromGraphicsObject } from "graphics-debug"
import { HypergraphBusLanesSolver, type RoutingStageSnapshot } from "../lib"
import { RoutingStageSolver } from "../lib/routing-stage-solver"
import { loadAm3352Sample } from "./am3352-samples"
import { validateAm3352Sample } from "./validate-am3352-sample"

// User-requested intermediate diagnostics, explicitly separate from solved-board
// artifacts. Capture live boundaries and publish only after the full run passes.
const { input, metadata } = await loadAm3352Sample("control")
const snapshots: RoutingStageSnapshot[] = []
const solver = new HypergraphBusLanesSolver(input, {
  onStage: (snapshot) => snapshots.push(snapshot),
})
solver.solve()
if (!solver.solved) throw Error(solver.error ?? "Pipeline did not solve")
const audit = await validateAm3352Sample(input, metadata, solver.traces)
if (!audit.valid)
  throw Error("Completed recording failed the independent audit")
const finalAttempt = snapshots.at(-1)!.attempt
const stages = snapshots.filter((s) => s.attempt === finalAttempt)
const inputs: RoutingStageSnapshot["input"][] = []
const keys: string[] = []
const recording = {
  sample: "control",
  audit,
  input,
  inputs,
  stages: stages.map(({ input, ...stage }) => {
    const key = JSON.stringify(input)
    let inputIndex = keys.indexOf(key)
    if (inputIndex < 0) {
      inputIndex = inputs.length
      inputs.push(input)
      keys.push(key)
    }
    return { ...stage, inputIndex }
  }),
}
await mkdir("work", { recursive: true })
await Bun.write(
  "work/hypergraph-control-stages.json",
  JSON.stringify(recording),
)
const directory = process.argv[2] ?? "work/hypergraph-stages"
await mkdir(directory, { recursive: true })
for (const [i, snapshot] of stages.entries()) {
  const png = await getPngBufferFromGraphicsObject(
    new RoutingStageSolver(snapshot, "inner1").visualize(),
    {
      pngWidth: 1000,
      pngHeight: 1000,
      includeTextLabels: false,
      backgroundColor: "white",
    },
  )
  await Bun.write(
    `${directory}/${String(i + 1).padStart(2, "0")}-${snapshot.routingStage}-${snapshot.stage}.png`,
    png,
  )
}
console.log(
  JSON.stringify(
    stages.map((s) => ({
      stage: s.stage,
      group: s.routingStage,
      routes: s.traces.length,
      ...s.stats,
    })),
    null,
    2,
  ),
)
console.log(
  `Saved ${stages.length} stage snapshots from an independently validated 47/47 run`,
)
