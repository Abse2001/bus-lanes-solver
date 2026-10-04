import { expect, test } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const repository = resolve(import.meta.dir, "..")
const placements = [
  { sample: "control", ram: { x: 0, y: -27 } },
  { sample: "right", ram: { x: 27, y: 0 } },
  { sample: "left", ram: { x: -27, y: 0 } },
  { sample: "above", ram: { x: 0, y: 27 } },
  { sample: "inner-layers", ram: { x: 0, y: -27 } },
  { sample: "inner-layers-right", ram: { x: 27, y: 0 } },
  { sample: "inner-layers-left", ram: { x: -27, y: 0 } },
  { sample: "inner-layers-above", ram: { x: 0, y: 27 } },
  { sample: "inner-layers-complete-ca", ram: { x: 0, y: -27 } },
]

interface Report {
  sample: string
  cpu: { x: number; y: number }
  ram: { x: number; y: number }
  allowedLayers: string[] | null
  carrierLayerCounts: Record<string, number>
  status: string
  solved: boolean
  requestedSignals: number
  routedSignals: number
  fixedPowerDogbones: number
  inputUnchanged: boolean
  fixedPowerPreserved: boolean
  error: string | null
  validation: { fixedDrc: { valid: boolean } } | null
}

async function invokeBenchmark(options: {
  strict?: boolean
  missingFixtures?: boolean
}) {
  const directory = mkdtempSync(join(tmpdir(), "am3352-benchmark-cli-"))
  try {
    let runner = repository
    if (options.missingFixtures) {
      // Execute the production CLI and modules with real missing files. Keep
      // the installed geometry implementation, but never mutate real fixtures.
      runner = join(directory, "missing-fixtures")
      mkdirSync(join(runner, "scripts"), { recursive: true })
      for (const file of [
        "benchmark.ts",
        "am3352-samples.ts",
        "am3352-ca-bus.ts",
        "validate-am3352-sample.ts",
        "measure-am3352-routing-quality.ts",
        "measure-routing-footprint.ts",
        "measure-envelope-vacancy.ts",
      ])
        copyFileSync(
          join(repository, "scripts", file),
          join(runner, "scripts", file),
        )
      for (const file of ["benchmark.sh", "tsconfig.json"])
        copyFileSync(join(repository, file), join(runner, file))
      for (const directory of ["lib", "node_modules"])
        symlinkSync(join(repository, directory), join(runner, directory), "dir")
    }
    const output = join(directory, "results.json")
    const child = Bun.spawn(
      [
        "bash",
        join(runner, "benchmark.sh"),
        "--timeout-seconds",
        "0.000001",
        "--output",
        output,
        ...(options.strict ? ["--require-all-solved"] : []),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    let exceededDeadline = false
    const deadline = setTimeout(() => {
      exceededDeadline = true
      child.kill()
    }, 70_000)
    let result
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exceededDeadline)
        throw Error(`Bounded benchmark exceeded its deadline: ${stderr}`)
      if (!existsSync(output))
        throw Error(
          `Benchmark did not retain its reports: ${stdout}\n${stderr}`,
        )
      result = {
        stdout,
        stderr,
        exitCode,
        reports: (await Bun.file(output).json()) as Report[],
      }
    } finally {
      clearTimeout(deadline)
    }
    // --output must isolate the real benchmark results even when called from
    // another working directory (benchmark.sh itself changes directories).
    expect(existsSync(join(directory, "benchmark-results.json"))).toBe(false)
    if (runner !== repository)
      expect(existsSync(join(runner, "benchmark-results.json"))).toBe(false)
    return result
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function expectManifest(reports: Report[]) {
  expect(reports).toHaveLength(9)
  expect(reports.map(({ sample, ram }) => ({ sample, ram }))).toEqual(
    placements,
  )
  for (const report of reports) {
    expect(report.allowedLayers).toEqual(
      report.sample.startsWith("inner-layers") ? ["inner1", "inner2"] : null,
    )
    expect(report.carrierLayerCounts).toEqual({})
    expect(report.cpu).toEqual({ x: 0, y: 0 })
    expect(report.requestedSignals).toBe(47)
    expect(report.solved).toBe(false)
    expect(report.routedSignals).toBe(0)
  }
}

for (const strict of [false, true])
  test(`${strict ? "strict" : "measurement"} benchmark retains all nine timed-out AM3352 placements`, async () => {
    const result = await invokeBenchmark({ strict })
    expect(result.exitCode).toBe(strict ? 1 : 0)
    expectManifest(result.reports)
    expect(result.stdout).toContain("AM3352 placements completed: 0/9")
    const powerCount = result.reports[0].fixedPowerDogbones
    expect(powerCount).toBeGreaterThan(0)
    for (const report of result.reports) {
      expect(report.status).toBe("timed_out")
      expect(report.fixedPowerDogbones).toBe(powerCount)
      expect(report.inputUnchanged).toBe(true)
      expect(report.fixedPowerPreserved).toBe(true)
      expect(report.validation?.fixedDrc.valid).toBe(true)
    }
  }, 75_000)

test("fixture crashes fail measurement mode and retain every AM3352 placement", async () => {
  const result = await invokeBenchmark({ missingFixtures: true })
  expect(result.exitCode).toBe(1)
  expectManifest(result.reports)
  for (const report of result.reports) {
    expect(report.status).toBe("validation_failed")
    expect(report.validation).toBeNull()
    expect(report.error).toBeTruthy()
  }
}, 75_000)
