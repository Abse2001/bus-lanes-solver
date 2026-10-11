import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  am3352Hash,
  am3352SamplePlacements,
  loadAm3352Sample,
} from "./am3352-samples"
import {
  exportAm3352RoutedSnapshots,
  type Am3352SnapshotCandidate,
} from "./snapshot-routed-am3352"

const [routesArgument, snapshotsArgument, ...extra] = process.argv.slice(2)
if (!routesArgument || !snapshotsArgument || extra.length)
  throw Error(
    "Usage: bun scripts/snapshot-cached-am3352.ts ROUTES_DIR SNAPSHOTS_DIR",
  )
const routesDirectory = resolve(routesArgument)
const snapshotsDirectory = resolve(snapshotsArgument)
const candidates: Am3352SnapshotCandidate[] = []
const sourceHashes: Record<string, string> = {}
for (const placement of am3352SamplePlacements) {
  const filename = join(routesDirectory, `${placement.name}.json`)
  const bytes = await readFile(filename)
  const candidate = JSON.parse(bytes.toString())
  if (
    candidate.sample !== placement.name ||
    candidate.solved !== true ||
    candidate.failed !== false ||
    candidate.error !== null ||
    candidate.validation?.valid !== true
  )
    throw Error(`${placement.name}: refusing unfinished or unaudited route`)
  const { input, metadata } = await loadAm3352Sample(placement.name)
  if (am3352Hash(candidate.input) !== am3352Hash(input))
    throw Error(
      `${placement.name}: cached routing input differs from trusted fixture`,
    )
  sourceHashes[placement.name] = createHash("sha256")
    .update(bytes)
    .digest("hex")
  candidates.push({
    solver: {
      solved: candidate.solved,
      failed: candidate.failed,
      error: candidate.error,
      input: candidate.input,
      traces: candidate.traces,
      getOutput: () => candidate.output,
    },
    metadata,
  })
}
const validations = await exportAm3352RoutedSnapshots(
  candidates,
  snapshotsDirectory,
)
await Bun.write(
  join(snapshotsDirectory, "validated-source-manifest.json"),
  JSON.stringify({ sourceHashes, validations }, null, 2) + "\n",
)
