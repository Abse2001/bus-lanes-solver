import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  loadAm3352Sample,
  type Am3352SampleMetadata,
  type Am3352SampleName,
  type FanoutGeneratorIdentity,
} from "./am3352-samples"
import { SAMPLE_NAMES } from "./pr-benchmark/report"

const TIMEOUT_SECONDS = 3600
const MAX_PIPELINE_ITERATIONS = 8_000_000
const CONFIGURATION_PATHS = ["bun.lock", "bun.lockb", "tsconfig.json"]
const GROUP_PATHS = {
  source: ["lib", "package.json"],
  driver: ["scripts", "benchmark.sh"],
  fixtures: ["tests/fixtures/am3352-ram"],
  runtimeConfiguration: CONFIGURATION_PATHS,
} as const

interface FrozenFile {
  path: string
  gitBlobSha1: string
  sha256: string
  bytes: number
  mode: string
}
interface Manifest {
  frozenFileCount: number
  frozenFilesSha256: string
  files: FrozenFile[]
}
interface InstalledDependency {
  name: string
  specification: string
  version: string
  packageJsonSha256: string
  entryPath: string | null
  entrySha256: string | null
}
export interface FrozenSourceAudit {
  source: Manifest & { commitSha: string; libGitTreeSha1: string }
  driver: Manifest
  fixtures: Manifest
  runtimeConfiguration: Manifest
  repository: string
  frozenDirectory: string
  solverEntry: string
  workerEntry: string
  benchmarkEntry: string
  dependenciesSymlink: string
  freezeVerification: string
}
interface InputCase {
  sample: string
  inputSha256: string
  fixedCopperSha256: string
  fanoutProvenance: Am3352SampleMetadata["provenance"]
  defaultMaxPipelineIterations: number
}
export interface FrozenInputAudit {
  frozenDirectory: string
  bunVersion: string
  installedFanoutGenerator: FanoutGeneratorIdentity
  installedDependencies: InstalledDependency[]
  cases: InputCase[]
  casesSha256: string
}
export interface FrozenExecution {
  revision: string
  libGitTreeSha1: string
  sourceManifestSha256: string
  driverManifestSha256: string
  fixtureManifestSha256: string
  cwd: string
  command: string[]
  concurrency: 1
  timeoutSeconds: number
  maxPipelineIterations: number
  bunVersion: string
  startedAt: string
  endedAt: string | null
  exitCode: number | null
}
export interface FrozenBenchmarkOptions {
  revision: string
  directory: string
  repository?: string
  output?: string
  routesDirectory?: string
  prepareOnly?: boolean
}
export interface PreparedFrozenBenchmark {
  source: FrozenSourceAudit
  inputs: FrozenInputAudit
  command: string[]
  reportPath: string
  routesPath: string
  sourceAuditPath: string
  inputAuditPath: string
  executionPath: string
}
interface Validation {
  valid: boolean
  complete: boolean
  matched: boolean
  combinedDrc: { valid: boolean }
  fixedDrc: { valid: boolean }
}
interface BenchmarkReport {
  sample: string
  status: string
  solved: boolean
  error: unknown
  requestedSignals: number
  routedSignals: number
  fixedPowerDogbones: number
  inputUnchanged: boolean
  fixedPowerPreserved: boolean
  timeoutSeconds: number
  solveMilliseconds: number
  iterations: number
  inputSha256: string
  validation: Validation | null
}
interface RouteCache {
  sample: string
  solved: boolean
  failed: boolean
  error: unknown
  input: unknown
  validation: unknown
}

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex")
const hashJson = (value: unknown) => hash(JSON.stringify(value))
const git = (repository: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repository, maxBuffer: 32 * 1024 * 1024 })
const gitText = (repository: string, ...args: string[]) =>
  git(repository, ...args)
    .toString()
    .trim()
const jsonBytes = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T
const manifest = (files: FrozenFile[]): Manifest => ({
  frozenFileCount: files.length,
  frozenFilesSha256: hashJson(files),
  files,
})
const inside = (parent: string, path: string) => {
  const subpath = relative(parent, path)
  return (
    subpath === "" ||
    (!isAbsolute(subpath) &&
      subpath !== ".." &&
      !subpath.startsWith(`..${sep}`))
  )
}

async function assertAbsent(path: string) {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  throw Error(`Refuse to overwrite ${path}`)
}

function treeEntries(
  repository: string,
  revision: string,
  paths: readonly string[],
) {
  return git(repository, "ls-tree", "-r", "-z", revision, "--", ...paths)
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t")
      const [mode, kind, blob] = entry.slice(0, tab).split(" ")
      const path = entry.slice(tab + 1)
      if (kind !== "blob" || !["100644", "100755"].includes(mode))
        throw Error(`${path}: only regular Git blobs can be frozen`)
      if (!path || isAbsolute(path) || path.split("/").includes(".."))
        throw Error("Unsafe Git path in frozen closure")
      return { path, mode, blob }
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"))
}

/** Audit every protected directory, including unexpected files and symlinks. */
export async function verifyFrozenSource(audit: FrozenSourceAudit) {
  const { repository, frozenDirectory } = audit
  if (
    gitText(repository, "rev-parse", `${audit.source.commitSha}:lib`) !==
    audit.source.libGitTreeSha1
  )
    throw Error("Frozen library tree differs from declared Git revision")
  for (const section of Object.keys(GROUP_PATHS) as Array<
    keyof typeof GROUP_PATHS
  >) {
    const recorded = audit[section]
    const expected = treeEntries(
      repository,
      audit.source.commitSha,
      GROUP_PATHS[section],
    )
    if (
      !Array.isArray(recorded.files) ||
      recorded.frozenFileCount !== recorded.files.length ||
      hashJson(recorded.files) !== recorded.frozenFilesSha256 ||
      new Set(recorded.files.map((file) => file.path)).size !==
        expected.length ||
      recorded.files.length !== expected.length ||
      expected.some(
        (file) => !recorded.files.some((item) => item.path === file.path),
      )
    )
      throw Error(`${section}: incomplete frozen source manifest`)
    for (const entry of expected) {
      const file = recorded.files.find((item) => item.path === entry.path)!
      const path = join(frozenDirectory, file.path)
      const stats = await lstat(path)
      const bytes = await readFile(path)
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        file.gitBlobSha1 !== entry.blob ||
        file.mode !== entry.mode ||
        (stats.mode & 0o777) !== (Number.parseInt(entry.mode, 8) & 0o777) ||
        bytes.length !== file.bytes ||
        hash(bytes) !== file.sha256 ||
        hash(git(repository, "cat-file", "blob", entry.blob)) !== file.sha256
      )
        throw Error(`${file.path}: frozen bytes or mode differ from Git`)
    }
    for (const root of GROUP_PATHS[section]) {
      const wanted = expected.filter(
        (file) => file.path === root || file.path.startsWith(`${root}/`),
      )
      if (!wanted.length) continue
      const actual: string[] = []
      const visit = async (path: string) => {
        const stats = await lstat(path)
        if (stats.isDirectory())
          for (const entry of await readdir(path))
            await visit(join(path, entry))
        else actual.push(relative(frozenDirectory, path).split(sep).join("/"))
      }
      await visit(join(frozenDirectory, root))
      if (
        actual.length !== wanted.length ||
        actual.some((path) => !wanted.some((file) => file.path === path))
      )
        throw Error(`${section}: unexpected files in frozen closure`)
    }
  }
  const dependencies = join(frozenDirectory, "node_modules")
  if (
    !(await lstat(dependencies)).isSymbolicLink() ||
    (await realpath(dependencies)) !==
      (await realpath(audit.dependenciesSymlink))
  )
    throw Error("Frozen dependency symlink changed")
}

async function installedDependencies(audit: FrozenSourceAudit) {
  const pkg = await readJson<{ devDependencies: Record<string, string> }>(
    join(audit.frozenDirectory, "package.json"),
  )
  const result: InstalledDependency[] = []
  for (const [name, specification] of Object.entries(pkg.devDependencies).sort(
    ([a], [b]) => a.localeCompare(b, "en"),
  )) {
    const root = join(audit.dependenciesSymlink, name)
    const packageBytes = await readFile(join(root, "package.json"))
    const installed = JSON.parse(packageBytes.toString()) as {
      name: string
      version: string
      main?: string
      module?: string
      exports?: unknown
    }
    if (
      installed.name !== name ||
      !installed.version ||
      (/^\d+\.\d+\.\d+$/.test(specification) &&
        installed.version !== specification)
    )
      throw Error(`${name}: installed dependency differs from frozen pin`)
    let entryPath: string | null = null
    let entrySha256: string | null = null
    let entry: string | undefined
    try {
      entry = Bun.resolveSync(name, audit.frozenDirectory)
    } catch (error) {
      if (
        !name.startsWith("@types/") &&
        (installed.main || installed.module || installed.exports)
      )
        throw error
    }
    if (entry) {
      if (!inside(await realpath(root), await realpath(entry)))
        throw Error(`${name}: dependency entry escapes installed package`)
      entryPath = relative(root, entry).split(sep).join("/")
      entrySha256 = hash(await readFile(entry))
    }
    result.push({
      name,
      specification,
      version: installed.version,
      packageJsonSha256: hash(packageBytes),
      entryPath,
      entrySha256,
    })
  }
  return result
}

async function auditFrozenInputs(
  audit: FrozenSourceAudit,
): Promise<FrozenInputAudit> {
  const loader = (await import(
    join(audit.frozenDirectory, "scripts/am3352-samples.ts")
  )) as typeof import("./am3352-samples")
  const solverModule = (await import(
    audit.solverEntry
  )) as typeof import("../lib")
  const declared = await readJson<string[]>(
    join(audit.frozenDirectory, "scripts/pr-benchmark/samples.json"),
  )
  if (
    declared.length !== 11 ||
    hashJson(declared) !== hashJson(SAMPLE_NAMES) ||
    hashJson(
      loader.am3352SamplePlacements.map((placement) => placement.name),
    ) !== hashJson(declared)
  )
    throw Error(
      "Frozen benchmark must declare the exact eleven trusted samples",
    )
  const installedFanoutGenerator =
    await loader.getAm3352FanoutGeneratorIdentity()
  const cases: InputCase[] = []
  for (const name of declared) {
    const { input, metadata } = await loader.loadAm3352Sample(
      name as Am3352SampleName,
    )
    const trusted = await loadAm3352Sample(name as Am3352SampleName)
    if (
      hashJson(input) !== hashJson(trusted.input) ||
      hashJson(metadata.fixedFanoutTraces) !==
        hashJson(trusted.metadata.fixedFanoutTraces) ||
      input.connections.length !== 47 ||
      metadata.fixedFanoutTraces.length !== 161 ||
      Object.values(metadata.provenance).some(
        (reference) =>
          hashJson(reference.generator) !== hashJson(installedFanoutGenerator),
      )
    )
      throw Error(
        `${name}: trusted input, immutable fixed copper or installed fanout generator mismatch`,
      )
    // Constructor inspection never steps or solves a route and uses the exact driver options.
    const pipeline = new solverModule.BusLanesPipelineSolver(input, {
      singleCarrier: { fixedConnections: metadata.powerConnections },
    })
    if (
      !Number.isSafeInteger(pipeline.MAX_ITERATIONS) ||
      pipeline.MAX_ITERATIONS <= 0 ||
      pipeline.MAX_ITERATIONS > MAX_PIPELINE_ITERATIONS
    )
      throw Error(
        `${name}: default pipeline budget exceeds the unchanged 8M ceiling`,
      )
    cases.push({
      sample: name,
      inputSha256: hashJson(input),
      fixedCopperSha256: hashJson(metadata.fixedFanoutTraces),
      fanoutProvenance: metadata.provenance,
      defaultMaxPipelineIterations: pipeline.MAX_ITERATIONS,
    })
  }
  return {
    frozenDirectory: audit.frozenDirectory,
    bunVersion: Bun.version,
    installedFanoutGenerator,
    installedDependencies: await installedDependencies(audit),
    cases,
    casesSha256: hashJson(cases),
  }
}

export function parseFrozenBenchmarkArguments(
  args: string[],
): FrozenBenchmarkOptions {
  const values = new Map<string, string>()
  let prepareOnly = false
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === "--prepare-only") {
      if (prepareOnly) throw Error("Duplicate --prepare-only")
      prepareOnly = true
    } else if (
      ["--revision", "--directory", "--output", "--routes-directory"].includes(
        flag,
      )
    ) {
      if (
        values.has(flag) ||
        !args[index + 1] ||
        args[index + 1].startsWith("--")
      )
        throw Error(`Missing or duplicate value for ${flag}`)
      values.set(flag, args[++index])
    } else throw Error(`Unknown option: ${flag}`)
  }
  const revision = values.get("--revision"),
    directory = values.get("--directory")
  if (!revision || revision.startsWith("-") || !directory)
    throw Error(
      "Usage: bun scripts/benchmark-frozen-g350.ts --revision REF --directory NEW_DIR [--output REPORT --routes-directory DIR --prepare-only]",
    )
  return {
    revision,
    directory,
    output: values.get("--output"),
    routesDirectory: values.get("--routes-directory"),
    prepareOnly,
  }
}

export async function prepareFrozenBenchmark(
  options: FrozenBenchmarkOptions,
): Promise<PreparedFrozenBenchmark> {
  const repository = gitText(
    resolve(options.repository ?? join(import.meta.dir, "..")),
    "rev-parse",
    "--show-toplevel",
  )
  if (!options.revision || options.revision.startsWith("-"))
    throw Error("Revision must identify a Git commit")
  const revision = gitText(
    repository,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${options.revision}^{commit}`,
  )
  const directory = resolve(options.directory),
    reportPath = resolve(options.output ?? join(directory, "report.json")),
    routesPath = resolve(options.routesDirectory ?? join(directory, "routes"))
  const protectedPaths = [...Object.values(GROUP_PATHS).flat(), "node_modules"]
  if (protectedPaths.some((path) => inside(join(repository, path), directory)))
    throw Error(
      "Frozen directory cannot be placed inside repository source or dependencies",
    )
  await assertAbsent(directory)
  await assertAbsent(reportPath)
  await assertAbsent(`${reportPath}.provenance.json`)
  await assertAbsent(routesPath)
  if (reportPath === routesPath || inside(routesPath, reportPath))
    throw Error("Report and route cache paths must be separate")
  for (const path of [reportPath, routesPath])
    if (
      protectedPaths.some(
        (protectedPath) =>
          inside(join(directory, protectedPath), path) ||
          inside(join(repository, protectedPath), path),
      ) ||
      [
        "benchmark-source.json",
        "benchmark-inputs.json",
        "benchmark-execution.json",
      ].some((metadata) => inside(join(directory, metadata), path))
    )
      throw Error(
        "Report/cache output cannot overwrite the frozen source closure",
      )
  const dependencyPath = join(repository, "node_modules")
  await realpath(dependencyPath)
  const entries = treeEntries(repository, revision, [
    ...Object.values(GROUP_PATHS).flat(),
  ])
  for (const required of [
    "lib/index.ts",
    "package.json",
    "benchmark.sh",
    "scripts/benchmark.ts",
    "scripts/am3352-samples.ts",
    "scripts/pr-benchmark/samples.json",
    "tests/fixtures/am3352-ram/native-input.json",
    "tsconfig.json",
  ])
    if (!entries.some((entry) => entry.path === required))
      throw Error(`Missing frozen runtime closure: ${required}`)
  await mkdir(directory, { recursive: true })
  const files: FrozenFile[] = []
  for (const entry of entries) {
    const bytes = git(repository, "cat-file", "blob", entry.blob)
    const path = join(directory, entry.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: "wx" })
    await chmod(path, Number.parseInt(entry.mode, 8) & 0o777)
    files.push({
      path: entry.path,
      gitBlobSha1: entry.blob,
      sha256: hash(bytes),
      bytes: bytes.length,
      mode: entry.mode,
    })
  }
  await symlink(dependencyPath, join(directory, "node_modules"), "dir")
  const section = (name: keyof typeof GROUP_PATHS) =>
    manifest(
      files.filter((file) =>
        GROUP_PATHS[name].some(
          (path) => file.path === path || file.path.startsWith(`${path}/`),
        ),
      ),
    )
  const source: FrozenSourceAudit = {
    source: {
      ...section("source"),
      commitSha: revision,
      libGitTreeSha1: gitText(repository, "rev-parse", `${revision}:lib`),
    },
    driver: section("driver"),
    fixtures: section("fixtures"),
    runtimeConfiguration: section("runtimeConfiguration"),
    repository,
    frozenDirectory: directory,
    solverEntry: join(directory, "lib/index.ts"),
    workerEntry: join(directory, "scripts/benchmark.ts"),
    benchmarkEntry: join(directory, "benchmark.sh"),
    dependenciesSymlink: dependencyPath,
    freezeVerification:
      "Every protected file was byte- and mode-verified against its exact Git blob; the full directory closure was checked before and after execution.",
  }
  await verifyFrozenSource(source)
  const inputs = await auditFrozenInputs(source)
  const sourceAuditPath = join(directory, "benchmark-source.json"),
    inputAuditPath = join(directory, "benchmark-inputs.json"),
    executionPath = join(directory, "benchmark-execution.json")
  const command = [
    "./benchmark.sh",
    "--solver",
    source.solverEntry,
    "--timeout-seconds",
    String(TIMEOUT_SECONDS),
    "--routes-directory",
    routesPath,
    "--output",
    reportPath,
    "--require-all-solved",
  ]
  await writeFile(sourceAuditPath, jsonBytes(source), { flag: "wx" })
  await writeFile(inputAuditPath, jsonBytes(inputs), { flag: "wx" })
  return {
    source,
    inputs,
    command,
    reportPath,
    routesPath,
    sourceAuditPath,
    inputAuditPath,
    executionPath,
  }
}

const exactSamples = (
  values: Array<{ sample: string }>,
  names: readonly string[],
) =>
  Array.isArray(values) &&
  values.length === names.length &&
  new Set(values.map((entry) => entry.sample)).size === names.length &&
  names.every((name) => values.some((entry) => entry.sample === name))

/** Validate the completed execution and report envelope before reading caches. */
export function validateFrozenBenchmarkReports(
  prepared: PreparedFrozenBenchmark,
  execution: FrozenExecution,
  reports: BenchmarkReport[],
) {
  const { source, inputs } = prepared
  if (
    execution.revision !== source.source.commitSha ||
    execution.libGitTreeSha1 !== source.source.libGitTreeSha1 ||
    execution.sourceManifestSha256 !== source.source.frozenFilesSha256 ||
    execution.driverManifestSha256 !== source.driver.frozenFilesSha256 ||
    execution.fixtureManifestSha256 !== source.fixtures.frozenFilesSha256 ||
    execution.cwd !== source.frozenDirectory ||
    inputs.frozenDirectory !== source.frozenDirectory ||
    source.solverEntry !== join(source.frozenDirectory, "lib/index.ts") ||
    source.benchmarkEntry !== join(source.frozenDirectory, "benchmark.sh") ||
    execution.maxPipelineIterations !== MAX_PIPELINE_ITERATIONS ||
    execution.bunVersion !== inputs.bunVersion ||
    hashJson(execution.command) !== hashJson(prepared.command) ||
    hashJson(prepared.command) !==
      hashJson([
        "./benchmark.sh",
        "--solver",
        source.solverEntry,
        "--timeout-seconds",
        "3600",
        "--routes-directory",
        prepared.routesPath,
        "--output",
        prepared.reportPath,
        "--require-all-solved",
      ]) ||
    !Number.isFinite(Date.parse(execution.startedAt)) ||
    !Number.isFinite(Date.parse(execution.endedAt ?? "")) ||
    Date.parse(execution.endedAt!) <= Date.parse(execution.startedAt)
  )
    throw Error(
      "Execution must bind exact frozen source, driver, fixtures, command paths and completed runtime",
    )
  if (
    !exactSamples(inputs.cases, SAMPLE_NAMES) ||
    hashJson(inputs.cases) !== inputs.casesSha256
  )
    throw Error("Input audit must bind the exact unique eleven trusted cases")
  if (
    !exactSamples(reports, SAMPLE_NAMES) ||
    execution.concurrency !== 1 ||
    execution.timeoutSeconds !== TIMEOUT_SECONDS ||
    execution.exitCode !== 0
  )
    throw Error(
      "A successful serial eleven-case benchmark execution is required",
    )
  for (const reference of inputs.cases) {
    const report = reports.find((entry) => entry.sample === reference.sample)!
    if (
      report.status !== "solved" ||
      report.solved !== true ||
      report.error !== null ||
      report.requestedSignals !== 47 ||
      report.routedSignals !== 47 ||
      report.fixedPowerDogbones !== 161 ||
      report.inputUnchanged !== true ||
      report.fixedPowerPreserved !== true ||
      report.timeoutSeconds !== TIMEOUT_SECONDS ||
      !Number.isFinite(report.solveMilliseconds) ||
      report.solveMilliseconds <= 0 ||
      report.solveMilliseconds >= TIMEOUT_SECONDS * 1000 ||
      !Number.isSafeInteger(report.iterations) ||
      report.iterations < 0 ||
      report.iterations > MAX_PIPELINE_ITERATIONS ||
      report.iterations > reference.defaultMaxPipelineIterations ||
      report.validation?.valid !== true ||
      report.validation.complete !== true ||
      report.validation.matched !== true ||
      report.validation.combinedDrc?.valid !== true ||
      report.validation.fixedDrc?.valid !== true ||
      report.inputSha256 !== reference.inputSha256
    )
      throw Error(
        `${reference.sample}: complete native acceptance under unchanged budgets is required`,
      )
  }
}

export function validateFrozenBenchmarkCache(
  reference: InputCase,
  report: BenchmarkReport,
  cache: RouteCache,
) {
  if (
    cache.sample !== reference.sample ||
    cache.solved !== true ||
    cache.failed !== false ||
    cache.error !== null ||
    hashJson(cache.input) !== reference.inputSha256 ||
    hashJson(cache.validation) !== hashJson(report.validation)
  )
    throw Error(`${reference.sample}: cache/input/validation mismatch`)
}

/** Accepted provenance is written last, only after every invariant succeeds. */
export async function writeFrozenBenchmarkProvenance(
  prepared: PreparedFrozenBenchmark,
  execution: FrozenExecution,
) {
  const provenancePath = `${prepared.reportPath}.provenance.json`
  await assertAbsent(provenancePath)
  const [reportBytes, sourceBytes, inputBytes, executionBytes] =
    await Promise.all([
      readFile(prepared.reportPath),
      readFile(prepared.sourceAuditPath),
      readFile(prepared.inputAuditPath),
      readFile(prepared.executionPath),
    ])
  if (
    hashJson(JSON.parse(sourceBytes.toString())) !==
      hashJson(prepared.source) ||
    hashJson(JSON.parse(inputBytes.toString())) !== hashJson(prepared.inputs) ||
    hashJson(JSON.parse(executionBytes.toString())) !== hashJson(execution)
  )
    throw Error("Recorded source/input/execution audit changed")
  await verifyFrozenSource(prepared.source)
  const after = await auditFrozenInputs(prepared.source)
  if (hashJson(after) !== hashJson(prepared.inputs))
    throw Error(
      "Trusted inputs or installed dependencies changed during execution",
    )
  const reports = JSON.parse(reportBytes.toString()) as BenchmarkReport[]
  validateFrozenBenchmarkReports(prepared, execution, reports)
  const cases = []
  for (const reference of prepared.inputs.cases) {
    const cacheBytes = await readFile(
      join(prepared.routesPath, `${reference.sample}.json`),
    )
    const cache = JSON.parse(cacheBytes.toString()) as RouteCache
    validateFrozenBenchmarkCache(
      reference,
      reports.find((entry) => entry.sample === reference.sample)!,
      cache,
    )
    cases.push({
      sample: reference.sample,
      inputSha256: reference.inputSha256,
      acceptedCacheSha256: hash(cacheBytes),
      fixedCopperSha256: reference.fixedCopperSha256,
    })
  }
  const result = {
    ...prepared.source,
    benchmarkReportSha256: hash(reportBytes),
    sourceAuditSha256: hash(sourceBytes),
    inputAuditSha256: hash(inputBytes),
    executionRecordSha256: hash(executionBytes),
    concurrency: 1,
    timeoutSeconds: TIMEOUT_SECONDS,
    maxPipelineIterations: MAX_PIPELINE_ITERATIONS,
    bunVersion: prepared.inputs.bunVersion,
    installedFanoutGenerator: prepared.inputs.installedFanoutGenerator,
    installedDependencies: prepared.inputs.installedDependencies,
    execution,
    accepted: cases.length,
    acceptanceScope:
      "Acceptance recorded by the exact frozen benchmark; compare-g350-benchmarks.ts and snapshot export independently revalidate cached physical copper before publication.",
    cases,
  }
  await writeFile(provenancePath, jsonBytes(result), { flag: "wx" })
  return result
}

export async function runFrozenBenchmark(options: FrozenBenchmarkOptions) {
  const prepared = await prepareFrozenBenchmark(options)
  if (options.prepareOnly) {
    console.log(
      JSON.stringify(
        {
          prepared: true,
          benchmarkRun: false,
          revision: prepared.source.source.commitSha,
          directory: prepared.source.frozenDirectory,
          sourceAudit: prepared.sourceAuditPath,
          inputAudit: prepared.inputAuditPath,
          command: prepared.command,
        },
        null,
        2,
      ),
    )
    return prepared
  }
  await mkdir(dirname(prepared.reportPath), { recursive: true })
  await verifyFrozenSource(prepared.source)
  const execution: FrozenExecution = {
    revision: prepared.source.source.commitSha,
    libGitTreeSha1: prepared.source.source.libGitTreeSha1,
    sourceManifestSha256: prepared.source.source.frozenFilesSha256,
    driverManifestSha256: prepared.source.driver.frozenFilesSha256,
    fixtureManifestSha256: prepared.source.fixtures.frozenFilesSha256,
    cwd: prepared.source.frozenDirectory,
    command: prepared.command,
    concurrency: 1,
    timeoutSeconds: TIMEOUT_SECONDS,
    maxPipelineIterations: MAX_PIPELINE_ITERATIONS,
    bunVersion: prepared.inputs.bunVersion,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
  }
  await writeFile(prepared.executionPath, jsonBytes(execution), { flag: "wx" })
  const child = Bun.spawn(prepared.command, {
    cwd: execution.cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  execution.exitCode = await child.exited
  execution.endedAt = new Date().toISOString()
  await writeFile(prepared.executionPath, jsonBytes(execution))
  await verifyFrozenSource(prepared.source)
  if (execution.exitCode !== 0)
    throw Error(
      `Frozen benchmark exited ${execution.exitCode}; no accepted provenance was written`,
    )
  await writeFrozenBenchmarkProvenance(prepared, execution)
  console.log(`Accepted provenance: ${prepared.reportPath}.provenance.json`)
  return prepared
}

if (import.meta.main)
  await runFrozenBenchmark(parseFrozenBenchmarkArguments(process.argv.slice(2)))
