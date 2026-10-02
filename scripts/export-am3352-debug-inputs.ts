import { mkdir } from "node:fs/promises"
import { am3352SamplePlacements, loadAm3352Sample } from "./am3352-samples"
await mkdir("pages/data", { recursive: true })
for (const { name } of am3352SamplePlacements) {
  const { input } = await loadAm3352Sample(name)
  await Bun.write(
    `pages/data/am3352-ram-${name === "control" ? "below" : name}.json`,
    JSON.stringify(input),
  )
}
