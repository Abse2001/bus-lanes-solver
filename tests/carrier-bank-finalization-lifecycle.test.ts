import { expect, test } from "bun:test"
import path from "node:path"

// Export doubles remain in a direct-run child process and cannot replace the
// real Grid used by other test files in the ordinary suite.
test("carrier-bank finalization follows the actual queue in an isolated mock worker", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--smol",
      path.join(
        import.meta.dir,
        "fixtures",
        "carrier-bank-finalization-lifecycle.ts",
      ),
    ],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  )
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 20_000)
  try {
    const [exitCode, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
    expect(errors).toBe("")
    const summary = JSON.parse(output.trim().split("\n").at(-1)!)
    expect(summary).toMatchObject({
      mode: "MOCK_ONLY",
      registeredCases: 8,
      completedCases: 8,
      actualGridConstructedOrAdvanced: false,
      actualNegotiationQueue: true,
      realGeometryAndACAndCSPAndFinalization: true,
      nativeCheckerScope: "two supplied toy paths only",
      full43Or49: false,
      positiveCacheAfterCallerEvictionQualified: false,
    })
    expect(summary.assertions).toBeGreaterThan(10_000)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
  }
}, 30_000)
