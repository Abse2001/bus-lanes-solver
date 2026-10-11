import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runBenchmarkProcess, runPair } from "../scripts/pr-benchmark/run-pair"

test("paired benchmarks retain crashes and run the other revision in a fresh process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bus-benchmark-process-"))
  try {
    const worker = join(dir, "worker.ts")
    const outputPath = join(dir, "pair.json")
    await writeFile(
      worker,
      `
      const args = process.argv.slice(2)
      const solver = args[args.indexOf('--solver') + 1]
      if (solver.endsWith('main')) process.exit(2)
      const partial = await Bun.file(${JSON.stringify(outputPath)}).json()
      console.log('REPORT ' + JSON.stringify({
        sample: 'control', pid: process.pid,
        priorExitCode: partial.main.exitCode, pending: partial.pr.missing,
        tokenPresent: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
      }))
    `,
    )
    const pair = await runPair({
      sample: "control",
      timeoutSeconds: 1,
      mainSolverPath: join(dir, "main"),
      prSolverPath: join(dir, "pr"),
      outputPath,
      mainSha: "a".repeat(40),
      prSha: "b".repeat(40),
      controllerSha: "c".repeat(40),
      workerPath: worker,
    })
    expect(pair.main.exitCode).toBe(2)
    expect(pair.main.report).toBeNull()
    expect(pair.pr.exitCode).toBe(0)
    expect(pair.pr.report).toMatchObject({
      sample: "control",
      priorExitCode: 2,
      pending: true,
      tokenPresent: false,
    })
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(pair)
    expect(await readFile(outputPath + ".pr.stdout.log", "utf8")).toContain(
      "REPORT ",
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("hung and malformed workers stay visible as unsuccessful measurements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bus-benchmark-timeout-"))
  try {
    const hung = join(dir, "hung.ts")
    await writeFile(hung, "while (true) {}")
    const timeout = await runBenchmarkProcess([hung], dir, 100)
    expect(timeout.timedOut).toBe(true)
    expect(timeout.report).toBeNull()
    expect(timeout.error).toContain("deadline")
    const malformed = join(dir, "malformed.ts")
    await writeFile(malformed, "console.log('REPORT malformed')")
    const invalid = await runBenchmarkProcess([malformed], dir, 1000)
    expect(invalid.exitCode).toBe(0)
    expect(invalid.report).toBeNull()
    expect(invalid.error).toContain("malformed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
