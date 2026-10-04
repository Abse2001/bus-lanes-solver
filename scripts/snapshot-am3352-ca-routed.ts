import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getPngBufferFromGraphicsObject } from "graphics-debug"
import { runCaBusCase } from "./repro-am3352-ca-bus"
import { routedGraphics } from "./snapshot-routed-am3352"

const directory = process.argv[2] ?? "docs/routed-am3352-complete-ca"
const timeoutSeconds = Number(process.argv[3] ?? 180)
if (
  process.argv.length > 4 ||
  !Number.isFinite(timeoutSeconds) ||
  timeoutSeconds <= 0
)
  throw Error(
    "Usage: bun scripts/snapshot-am3352-ca-routed.ts [directory] [timeout-seconds]",
  )

const report = await runCaBusCase(true, timeoutSeconds, async (candidate) => {
  // runCaBusCase invokes this only after native connectivity/DRC, immutable
  // fanouts, pair coupling, and all THREE complete timing buses pass.
  const { graphics, width, height } = routedGraphics(candidate)
  const pngWidth = 2200,
    pngHeight = Math.round((pngWidth * height) / width)
  const png = await getPngBufferFromGraphicsObject(graphics, {
    includeTextLabels: false,
    backgroundColor: "#10151b",
    pngWidth,
    pngHeight,
    yFlip: true,
  })
  await mkdir(directory, { recursive: true })
  await Bun.write(join(directory, "complete-ca-solved.png"), png)
})
if (!report.passed)
  throw Error(
    `Refusing routed artifacts: ${report.status}; ${report.error ?? "acceptance checks did not pass"}`,
  )
await Bun.write(
  join(directory, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
)
console.log(
  `47/47 signals, 3 timing buses, 3 differential pairs, native DRC and coupling passed: ${directory}`,
)
