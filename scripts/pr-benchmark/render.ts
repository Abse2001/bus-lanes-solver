import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { loadSamplePairs, renderComparison } from "./report"

const args = process.argv.slice(2)
const names = [
  "--reports",
  "--main-sha",
  "--pr-sha",
  "--controller-sha",
  "--pr-number",
  "--timeout-seconds",
  "--run-url",
  "--output",
]
const values = new Map<string, string>()
for (let i = 0; i < args.length; i += 2) {
  if (!names.includes(args[i]) || !args[i + 1] || values.has(args[i]))
    throw Error("Invalid benchmark report arguments")
  values.set(args[i], args[i + 1])
}
if (names.some((name) => !values.has(name)))
  throw Error("Missing report arguments")
const body = renderComparison({
  samples: await loadSamplePairs(resolve(values.get("--reports")!)),
  mainSha: values.get("--main-sha")!,
  prSha: values.get("--pr-sha")!,
  controllerSha: values.get("--controller-sha")!,
  prNumber: Number(values.get("--pr-number")),
  timeoutSeconds: Number(values.get("--timeout-seconds")),
  runUrl: values.get("--run-url")!,
})
const output = resolve(values.get("--output")!)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, body)
