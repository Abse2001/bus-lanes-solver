import { expect, test } from "bun:test"
import { join } from "node:path"

test("Pipeline preserves or rejects named count bounds in an isolated constructor", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--smol",
      join(import.meta.dir, "fixtures", "via-count-options-boundary.ts"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 2500)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    // Preserve the exact child stdout protocol in the captured framework log.
    if (stdout) console.log(stdout.trim())
    if (stderr) console.error(stderr.trim())
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    const result = JSON.parse(stdout.trim())
    expect(result).toMatchObject({
      mode: "PROCESS_ISOLATED_MOCK_CONSTRUCTOR_BOUNDARY",
      actualPipelineConstructor: true,
      constructorAttempts: 28,
      successfulConstructors: 12,
      rejectedConstructors: 16,
      unsupportedGoalCases: 4,
      gridConstructors: 0,
      projectorConstructors: 0,
      connectivityConstructors: 0,
      nativeProducerFactories: 0,
      solverOrGridStepCalls: 0,
      inputUnchanged: true,
      physicalRoutingQualified: false,
    })
    expect(result.originalGridRuntimeExportKeys).toEqual([
      "GridHistoryProjector",
      "GridVisibilitySearch",
    ])
    expect(result.assertions).toBeGreaterThan(80)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
  }
})
