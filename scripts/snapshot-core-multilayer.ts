import { mkdir } from "node:fs/promises"
import {
  getPngBufferFromGraphicsObject,
  getSvgFromGraphicsObject,
} from "graphics-debug"
import { BusLanesPipelineSolver } from "../lib"
import {
  coreMultilayerInput,
  validateCoreMultilayer,
} from "./core-multilayer-sample"
import { loadAm3352Sample } from "./am3352-samples"
import { routedGraphics } from "./snapshot-routed-am3352"

const input = coreMultilayerInput()
const solver = new BusLanesPipelineSolver(input)
const start = performance.now()
solver.solve()
const seconds = (performance.now() - start) / 1000
// Validate successful routing, pad-to-pad matching, native copper/self-short
// checks, fixed carrier layers and actual multilayer command membership BEFORE
// writing any artifact. No saved route geometry is used by the solver.
const report = validateCoreMultilayer(solver)
const { metadata } = await loadAm3352Sample("control")
const { graphics, width, height } = routedGraphics(
  { solver, metadata: { ...metadata, fixedFanoutTraces: [] } },
  {
    title: "AM3352 / RAM - byte + address/clock matching across signal layers",
    status:
      "47/47 connected - native copper DRC passed - automatic local dogbones",
    skew: "Byte skew <= 0.635 mm - address/clock <= 2.54 mm - pairs <= 0.127 mm",
  },
)
const directory = "docs/routed-am3352-multilayer"
const pngWidth = 2200
const png = await getPngBufferFromGraphicsObject(graphics, {
  includeTextLabels: false,
  backgroundColor: "#10151b",
  pngWidth,
  pngHeight: Math.round((pngWidth * height) / width),
  yFlip: true,
})
const svg = getSvgFromGraphicsObject(graphics, {
  includeTextLabels: false,
  backgroundColor: "#10151b",
  svgWidth: pngWidth,
  svgHeight: Math.round((pngWidth * height) / width),
})
await mkdir(directory, { recursive: true })
await Bun.write(`${directory}/core-multilayer-solved.png`, png)
await Bun.write(`${directory}/core-multilayer-solved.svg`, svg)
await Bun.write(
  `${directory}/report.json`,
  JSON.stringify({ seconds, ...report }, null, 2) + "\n",
)
console.log(
  JSON.stringify({
    seconds,
    layerCounts: report.layerCounts,
    totalPlanarLengthMm: report.quality.totalPlanarLengthMm,
  }),
)
