import { expect, test } from "bun:test"
import path from "node:path"

// Grid/module doubles and the passive splice observer stay in a separate
// child process. The ordinary suite retains its real routing modules.
test("the actual carrier bank readmits an evicted cached positive in an isolated mock worker", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--smol",
      path.join(
        import.meta.dir,
        "fixtures",
        "carrier-bank-cache-eviction-lifecycle.ts",
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
    expect(errors).toBe("")
    expect(exitCode).toBe(0)
    const summary = JSON.parse(output.trim().split("\n").at(-1)!)
    expect(summary).toMatchObject({
      mode: "MOCK_ONLY",
      done: true,
      returnedRoutes: 3,
      nativeSiteCounts: [
        ["A", 8],
        ["B", 1],
        ["C", 1],
      ],
      maxPool: 48,
      actualGridConstructedOrAdvanced: false,
      realQueueCopperACAndCSPAndHelper: true,
      actualCacheEvictionReofferAndAdmission: true,
      full43Or49: false,
    })
    expect(summary.assertions).toBeGreaterThanOrEqual(1000)
    expect(summary.evictions).toBeGreaterThan(0)
    expect(summary.regeneratedId).toBeGreaterThan(summary.pending.originalId)
    expect(summary.admittedId).toBeGreaterThan(summary.reoffer.originalId)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
  }
}, 30_000)
