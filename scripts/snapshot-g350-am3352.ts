import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  getPngBufferFromGraphicsObject,
  getSvgFromGraphicsObject,
} from "graphics-debug"
import type { SimpleRouteJson } from "../lib"
import { loadG350Am3352Sample } from "./g350-am3352-sample"
import { validateG350Am3352Sample } from "./validate-g350-am3352-sample"
import { routedGraphics } from "./snapshot-routed-am3352"
import type { Am3352SampleMetadata } from "./am3352-samples"

/** Review images require complete, independently accepted pad-to-pad copper. */
export async function exportG350Snapshot(
  output: SimpleRouteJson,
  directory: string,
) {
  const input = loadG350Am3352Sample()
  const report = validateG350Am3352Sample(input, output)
  if (!report.valid || report.connectedSignals !== 49)
    throw Error(
      "Refusing a G350 snapshot without 49/49, unchanged geometry, DRC, all bus/pair matching and coupling",
    )
  const traces = output.traces!.slice(input.traces?.length ?? 0)
  const metadata = {
    name: "g350-am3352",
    placement: { cpu: { x: 0, y: 20 }, ram: { x: 0, y: 6 } },
    fixedFanoutTraces: input.traces ?? [],
  } as unknown as Am3352SampleMetadata
  const { graphics, width, height } = routedGraphics(
    {
      metadata,
      solver: {
        solved: true,
        failed: false,
        error: null,
        input,
        traces,
        getOutput: () => ({ ...output, traces: output.traces! }),
      },
    },
    {
      title: "G350 · AM3352 / RAM270 · 49/49 DDR · top/bottom",
      status:
        "194 components · 854 real pads · complete DDR connectivity and copper DRC passed",
      skew: "All three bus skews ≤0.635 mm; all three pairs ≤0.127 mm. Support routing and electrical timing remain unverified.",
    },
  )
  graphics.title =
    "G350 / AM3352 · 49/49 DDR · DRC, bus matching and pair coupling passed"
  const pngWidth = 3300,
    pngHeight = Math.round((pngWidth * height) / width)
  const options = { includeTextLabels: false, backgroundColor: "#10151b" }
  const svg = getSvgFromGraphicsObject(graphics, {
    ...options,
    svgWidth: pngWidth,
    svgHeight: pngHeight,
  }).replace(/[ \t]+$/gm, "")
  const png = await getPngBufferFromGraphicsObject(graphics, {
    ...options,
    pngWidth,
    pngHeight,
    yFlip: true,
  })
  await mkdir(directory, { recursive: true })
  await Bun.write(join(directory, "g350-solved.svg"), svg)
  await Bun.write(join(directory, "g350-solved.png"), png)
  await Bun.write(
    join(directory, "g350-validation.json"),
    JSON.stringify(report, null, 2) + "\n",
  )
  return report
}

if (import.meta.main) {
  const [file, directory, ...extra] = process.argv.slice(2)
  if (!file || !directory || extra.length)
    throw Error(
      "Usage: bun scripts/snapshot-g350-am3352.ts accepted.json output-directory",
    )
  await exportG350Snapshot(await Bun.file(file).json(), directory)
}
