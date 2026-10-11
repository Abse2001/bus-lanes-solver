import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  parseFrozenBenchmarkArguments,
  prepareFrozenBenchmark,
  runFrozenBenchmark,
  validateFrozenBenchmarkCache,
  validateFrozenBenchmarkReports,
  verifyFrozenSource,
  writeFrozenBenchmarkProvenance,
  type FrozenExecution,
  type PreparedFrozenBenchmark,
} from "../scripts/benchmark-frozen-g350"
import {
  loadAm3352Sample,
  type Am3352SampleName,
} from "../scripts/am3352-samples"

const repository = resolve(import.meta.dir, "..")
let root: string
let prepared: PreparedFrozenBenchmark
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
type Report = Parameters<typeof validateFrozenBenchmarkReports>[2][number]
function completedExecution(): FrozenExecution {
  return {
    revision: prepared.source.source.commitSha,
    libGitTreeSha1: prepared.source.source.libGitTreeSha1,
    sourceManifestSha256: prepared.source.source.frozenFilesSha256,
    driverManifestSha256: prepared.source.driver.frozenFilesSha256,
    fixtureManifestSha256: prepared.source.fixtures.frozenFilesSha256,
    cwd: prepared.source.frozenDirectory,
    command: prepared.command,
    concurrency: 1,
    timeoutSeconds: 3600,
    maxPipelineIterations: 8_000_000,
    bunVersion: prepared.inputs.bunVersion,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    exitCode: 0,
  }
}
function reportEnvelopes(): Report[] {
  // Deliberately no routing/cached copper: these envelopes exercise rejection guards.
  return prepared.inputs.cases.map((entry) => ({
    sample: entry.sample,
    status: "solved",
    solved: true,
    error: null,
    requestedSignals: 47,
    routedSignals: 47,
    fixedPowerDogbones: 161,
    inputUnchanged: true,
    fixedPowerPreserved: true,
    timeoutSeconds: 3600,
    solveMilliseconds: 1,
    iterations: 1,
    inputSha256: entry.inputSha256,
    validation: {
      valid: true,
      complete: true,
      matched: true,
      combinedDrc: { valid: true },
      fixedDrc: { valid: true },
    },
  }))
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "g350-frozen-tool-test-"))
  prepared = await prepareFrozenBenchmark({
    revision: "HEAD",
    directory: join(root, "prepared"),
    repository,
  })
})
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

test("prepare freezes exact Git bytes and all eleven trusted inputs without accepted artifacts", async () => {
  expect(prepared.source.source.commitSha).toMatch(/^[a-f0-9]{40}$/)
  expect(prepared.source.source.files.length).toBeGreaterThan(100)
  expect(prepared.inputs.cases).toHaveLength(11)
  for (const item of prepared.inputs.cases) {
    expect(item.inputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(item.fixedCopperSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(item.defaultMaxPipelineIterations).toBeGreaterThan(0)
    expect(item.defaultMaxPipelineIterations).toBeLessThanOrEqual(8_000_000)
  }
  const expected = execFileSync(
    "git",
    ["show", `${prepared.source.source.commitSha}:benchmark.sh`],
    { cwd: repository },
  )
  expect(await readFile(prepared.source.benchmarkEntry)).toEqual(expected)
  expect(
    await realpath(join(prepared.source.frozenDirectory, "node_modules")),
  ).toBe(await realpath(join(repository, "node_modules")))
  expect(prepared.command).toEqual([
    "./benchmark.sh",
    "--solver",
    prepared.source.solverEntry,
    "--timeout-seconds",
    "3600",
    "--routes-directory",
    prepared.routesPath,
    "--output",
    prepared.reportPath,
    "--require-all-solved",
  ])
  expect(await Bun.file(prepared.reportPath).exists()).toBe(false)
  expect(
    await Bun.file(`${prepared.reportPath}.provenance.json`).exists(),
  ).toBe(false)
  expect(await Bun.file(prepared.executionPath).exists()).toBe(false)
})

test("prepare-only never spawns a benchmark or writes accepted provenance", async () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw Error("No process may be benchmarked in prepare-only")
  })
  const output = spyOn(console, "log").mockImplementation(() => {})
  try {
    const result = await runFrozenBenchmark({
      revision: prepared.source.source.commitSha,
      directory: join(root, "prepare-only"),
      repository,
      prepareOnly: true,
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(await Bun.file(result.reportPath).exists()).toBe(false)
    expect(
      await Bun.file(`${result.reportPath}.provenance.json`).exists(),
    ).toBe(false)
  } finally {
    spawn.mockRestore()
    output.mockRestore()
  }
})

test("arguments reject unknown budgets, duplicate flags and missing commit/directory", () => {
  for (const args of [
    [],
    ["--revision", "HEAD"],
    ["--revision", "HEAD", "--directory", "x", "--timeout-seconds", "60"],
    ["--revision", "HEAD", "--revision", "main", "--directory", "x"],
    ["--revision", "--directory", "x"],
    [
      "--revision",
      "HEAD",
      "--directory",
      "x",
      "--prepare-only",
      "--prepare-only",
    ],
  ])
    expect(() => parseFrozenBenchmarkArguments(args)).toThrow()
})

test("freeze refuses overwrite, source output aliases and invalid revisions before mutation", async () => {
  await expect(
    prepareFrozenBenchmark({
      revision: "HEAD",
      directory: prepared.source.frozenDirectory,
      repository,
    }),
  ).rejects.toThrow("Refuse to overwrite")
  const folder = join(root, "protected-output")
  await expect(
    prepareFrozenBenchmark({
      revision: "HEAD",
      directory: folder,
      repository,
      output: join(folder, "lib", "result.json"),
    }),
  ).rejects.toThrow("source closure")
  await expect(
    prepareFrozenBenchmark({
      revision: "HEAD",
      directory: folder,
      repository,
      output: join(folder, "benchmark-source.json"),
    }),
  ).rejects.toThrow("source closure")
  await expect(
    prepareFrozenBenchmark({
      revision: "not-a-real-git-ref",
      directory: folder,
      repository,
    }),
  ).rejects.toThrow()
  expect(await Bun.file(join(folder, "package.json")).exists()).toBe(false)
  await verifyFrozenSource(prepared.source)
})

test("complete Git manifests reject omitted, changed and injected runtime files", async () => {
  const missing = structuredClone(prepared.source)
  missing.driver.files.pop()
  missing.driver.frozenFileCount = missing.driver.files.length
  missing.driver.frozenFilesSha256 = sha(missing.driver.files)
  await expect(verifyFrozenSource(missing)).rejects.toThrow(
    "incomplete frozen source manifest",
  )
  const original = await readFile(prepared.source.benchmarkEntry)
  try {
    await writeFile(
      prepared.source.benchmarkEntry,
      Buffer.concat([original, Buffer.from("# changed\n")]),
    )
    await expect(verifyFrozenSource(prepared.source)).rejects.toThrow(
      "frozen bytes",
    )
  } finally {
    await writeFile(prepared.source.benchmarkEntry, original)
  }
  const injected = join(prepared.source.frozenDirectory, "lib", "injected.ts")
  try {
    await writeFile(injected, "export {}\n")
    await expect(verifyFrozenSource(prepared.source)).rejects.toThrow(
      "unexpected files",
    )
  } finally {
    await rm(injected)
  }
})

test("execution records reject wrong revision, command paths, budgets and unsuccessful exits", () => {
  for (const change of [
    { revision: "0".repeat(40) },
    { command: ["./benchmark.sh"] },
    { timeoutSeconds: 60 },
    { maxPipelineIterations: 9_000_000 },
    { exitCode: 1 },
    { endedAt: null },
  ])
    expect(() =>
      validateFrozenBenchmarkReports(
        prepared,
        { ...completedExecution(), ...change },
        reportEnvelopes(),
      ),
    ).toThrow()
})

test("reports reject duplicate/unknown cases, numeric strings, missing DRC and expanded budgets", () => {
  const changes: Array<(reports: Report[]) => void> = [
    (reports) => {
      reports[1].sample = reports[0].sample
    },
    (reports) => {
      reports[0].sample = "unknown"
    },
    (reports) => {
      reports.pop()
    },
    (reports) => {
      reports[0].solveMilliseconds = "1" as unknown as number
    },
    (reports) => {
      reports[0].solveMilliseconds = Infinity
    },
    (reports) => {
      reports[0].iterations = 8_000_001
    },
    (reports) => {
      reports[0].validation!.fixedDrc = undefined as unknown as {
        valid: boolean
      }
    },
    (reports) => {
      reports[0].validation!.combinedDrc.valid = false
    },
    (reports) => {
      reports[0].validation!.matched = false
    },
    (reports) => {
      reports[0].validation!.complete = false
    },
  ]
  for (const change of changes) {
    const reports = reportEnvelopes()
    change(reports)
    expect(() =>
      validateFrozenBenchmarkReports(prepared, completedExecution(), reports),
    ).toThrow()
  }
})

test("cache identity and validation must match the exact trusted input and raw report", async () => {
  const reference = prepared.inputs.cases[0],
    report = reportEnvelopes()[0]
  const { input } = await loadAm3352Sample(reference.sample as Am3352SampleName)
  const cache = {
    sample: reference.sample,
    solved: true,
    failed: false,
    error: null,
    input,
    validation: report.validation,
  }
  expect(() =>
    validateFrozenBenchmarkCache(reference, report, {
      ...cache,
      sample: "wrong",
    }),
  ).toThrow("cache/input/validation mismatch")
  expect(() =>
    validateFrozenBenchmarkCache(reference, report, {
      ...cache,
      validation: { ...report.validation, complete: false },
    }),
  ).toThrow("cache/input/validation mismatch")
})

test("an unsuccessful run cannot publish a sidecar and preserves raw report bytes", async () => {
  const execution = { ...completedExecution(), exitCode: 1 }
  const rawReport = `${JSON.stringify(reportEnvelopes())}\n`
  await writeFile(prepared.reportPath, rawReport)
  await writeFile(prepared.executionPath, `${JSON.stringify(execution)}\n`)
  await expect(
    writeFrozenBenchmarkProvenance(prepared, execution),
  ).rejects.toThrow("successful serial eleven-case")
  expect(
    await Bun.file(`${prepared.reportPath}.provenance.json`).exists(),
  ).toBe(false)
  expect(await readFile(prepared.reportPath, "utf8")).toBe(rawReport)
})
