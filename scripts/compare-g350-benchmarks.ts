import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  am3352Hash,
  loadAm3352Sample,
  type Am3352SampleName,
} from "./am3352-samples"
import { SAMPLE_NAMES, percentile } from "./pr-benchmark/report"
import {
  validateAm3352SnapshotCandidates,
  type Am3352SnapshotCandidate,
} from "./snapshot-routed-am3352"

const [
  baselineReportPath,
  candidateReportPath,
  baselineRoutesPath,
  candidateRoutesPath,
  baselineSha,
  candidateSha,
  outputArgument,
  ...extra
] = process.argv.slice(2)
if (
  !outputArgument ||
  extra.length ||
  !/^[a-f0-9]{40}$/i.test(baselineSha ?? "") ||
  !/^[a-f0-9]{40}$/i.test(candidateSha ?? "")
)
  throw Error(
    "Usage: bun scripts/compare-g350-benchmarks.ts BASELINE_REPORT FIX_REPORT BASELINE_ROUTES FIX_ROUTES BASELINE_SHA FIX_SHA OUTPUT_DIR; each report requires REPORT.provenance.json",
  )

const reportBytes = await Promise.all(
  [baselineReportPath, candidateReportPath].map(async (path) =>
    readFile(resolve(path)),
  ),
)
const reportSets = reportBytes.map((bytes) =>
  JSON.parse(bytes.toString()),
) as Array<Array<Record<string, any>>>
const baselineReports = reportSets[0]
const candidateReports = reportSets[1]
const reportPaths = [baselineReportPath, candidateReportPath]
const revisions = [baselineSha, candidateSha]
const provenanceSets: Array<Record<string, any>> = []
// Each report requires REPORT.provenance.json with the frozen Git source
// manifest, the exact report hash, and all eleven trusted input/cache hashes.
// Revision labels alone are not evidence of which library a run used.
for (const [index, reportPath] of reportPaths.entries()) {
  const provenance = JSON.parse(
    await readFile(resolve(reportPath) + ".provenance.json", "utf8"),
  )
  const source = provenance.source
  const expectedRevision = revisions[index]
  const bytes = reportBytes[index]
  const hash = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex")
  if (
    source?.commitSha !== expectedRevision ||
    provenance.benchmarkReportSha256 !== hash(bytes) ||
    !Array.isArray(source.files) ||
    source.frozenFileCount !== source.files.length ||
    source.frozenFilesSha256 !== hash(JSON.stringify(source.files))
  )
    throw Error(
      "Run provenance revision, report hash, or source manifest mismatch",
    )
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: resolve(import.meta.dir, "..") })
  if (
    source.libGitTreeSha1 !==
    git("rev-parse", `${expectedRevision}:lib`).toString().trim()
  )
    throw Error(
      "Run provenance library tree differs from the declared Git revision",
    )
  const expectedFiles = git(
    "ls-tree",
    "-r",
    "-z",
    expectedRevision,
    "--",
    "lib",
    "package.json",
  )
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [info, path] = entry.split("\t")
      return { path, blob: info.split(" ")[2] }
    })
  if (
    expectedFiles.length !== source.files.length ||
    new Set(source.files.map((file: any) => file.path)).size !==
      expectedFiles.length
  )
    throw Error(
      "Run provenance does not include the complete library and package",
    )
  for (const expected of expectedFiles) {
    const file = source.files.find((entry: any) => entry.path === expected.path)
    const contents = git("cat-file", "blob", expected.blob)
    if (
      !file ||
      file.gitBlobSha1 !== expected.blob ||
      file.sha256 !== hash(contents) ||
      file.bytes !== contents.length
    )
      throw Error(`${expected.path}: run source manifest differs from Git`)
  }
  if (
    !Array.isArray(provenance.cases) ||
    provenance.cases.length !== SAMPLE_NAMES.length ||
    new Set(provenance.cases.map((entry: any) => entry.sample)).size !==
      SAMPLE_NAMES.length ||
    SAMPLE_NAMES.some(
      (name) => !provenance.cases.some((entry: any) => entry.sample === name),
    )
  )
    throw Error("Run provenance must contain all eleven input/cache records")
  provenanceSets.push(provenance)
}
const recordedConcurrency = provenanceSets.map((provenance) => {
  const concurrency = provenance.concurrency
  if (concurrency !== undefined && ![1, 2].includes(concurrency))
    throw Error("Run provenance has an unsupported concurrency record")
  return concurrency as number | undefined
})
const baselineConcurrency = recordedConcurrency[0]
let candidateConcurrency = recordedConcurrency[1]
let candidateWorkers: Record<string, any> | undefined
try {
  const workers = JSON.parse(
    await readFile(resolve(candidateReportPath) + ".workers.json", "utf8"),
  )
  if (
    workers.solverSha !== candidateSha ||
    ![1, 2].includes(workers.concurrency) ||
    (candidateConcurrency !== undefined &&
      candidateConcurrency !== workers.concurrency)
  )
    throw Error("Candidate worker metadata differs from frozen revision")
  candidateConcurrency = workers.concurrency
  candidateWorkers = workers
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
}
if (candidateWorkers) {
  if (
    !Array.isArray(candidateReports) ||
    candidateWorkers.timeoutSeconds !== candidateReports[0]?.timeoutSeconds ||
    !Array.isArray(candidateWorkers.workers) ||
    candidateWorkers.workers.length !== SAMPLE_NAMES.length ||
    new Set(candidateWorkers.workers.map((worker: any) => worker.sample))
      .size !== SAMPLE_NAMES.length
  )
    throw Error(
      "Candidate worker metadata has an inconsistent budget or samples",
    )
  for (const name of SAMPLE_NAMES) {
    const worker = candidateWorkers.workers.find(
      (entry: any) => entry.sample === name,
    )
    const report = candidateReports.find((entry) => entry.sample === name)
    if (
      !worker ||
      !report ||
      worker.exitCode !== 0 ||
      worker.error !== null ||
      worker.timedOut !== false ||
      !Number.isFinite(worker.wallMilliseconds) ||
      worker.wallMilliseconds < report.solveMilliseconds ||
      am3352Hash(worker.report) !== am3352Hash(report)
    )
      throw Error(`${name}: candidate worker metadata/report mismatch`)
  }
}
let timeoutSeconds: number | undefined
const auditedRuns: Array<Map<string, any>> = []
const candidateSets: Am3352SnapshotCandidate[][] = []

for (const [index, reports] of reportSets.entries()) {
  if (
    !Array.isArray(reports) ||
    reports.length !== SAMPLE_NAMES.length ||
    new Set(reports.map((report) => report.sample)).size !==
      SAMPLE_NAMES.length ||
    SAMPLE_NAMES.some(
      (name) => !reports.some((report) => report.sample === name),
    )
  )
    throw Error("Each run must report exactly the eleven declared samples")
  const routesDirectory = resolve(
    index === 0 ? baselineRoutesPath : candidateRoutesPath,
  )
  const candidates: Am3352SnapshotCandidate[] = []
  const bySample = new Map<string, any>()
  for (const name of SAMPLE_NAMES) {
    const report = reports.find((entry) => entry.sample === name)!
    timeoutSeconds ??= report.timeoutSeconds
    if (
      !Number.isFinite(report.timeoutSeconds) ||
      report.timeoutSeconds <= 0 ||
      report.timeoutSeconds !== timeoutSeconds ||
      !Number.isFinite(report.solveMilliseconds) ||
      report.solveMilliseconds <= 0 ||
      report.solveMilliseconds >= timeoutSeconds! * 1000 ||
      !Number.isSafeInteger(report.iterations) ||
      report.iterations < 0 ||
      report.status !== "solved" ||
      report.solved !== true ||
      report.error !== null ||
      report.requestedSignals !== 47 ||
      report.routedSignals !== 47 ||
      report.fixedPowerDogbones !== 161 ||
      report.inputUnchanged !== true ||
      report.fixedPowerPreserved !== true
    )
      throw Error(
        `${index === 0 ? "baseline" : "fix"}/${name}: incomplete or inconsistent benchmark acceptance`,
      )
    const cachedBytes = await readFile(join(routesDirectory, `${name}.json`))
    const cached = JSON.parse(cachedBytes.toString())
    const runCase = provenanceSets[index].cases.find(
      (entry: any) => entry.sample === name,
    )
    const acceptedCacheSha256 = createHash("sha256")
      .update(cachedBytes)
      .digest("hex")
    const { input, metadata } = await loadAm3352Sample(name as Am3352SampleName)
    if (
      cached.sample !== name ||
      cached.solved !== true ||
      cached.failed !== false ||
      cached.error !== null ||
      am3352Hash(cached.input) !== am3352Hash(input) ||
      report.inputSha256 !== am3352Hash(input) ||
      runCase.inputSha256 !== am3352Hash(input) ||
      runCase.acceptedCacheSha256 !== acceptedCacheSha256 ||
      am3352Hash(report.validation) !== am3352Hash(cached.validation)
    )
      throw Error(
        `${index === 0 ? "baseline" : "fix"}/${name}: cache/report/trusted fixture mismatch`,
      )
    candidates.push({
      solver: {
        solved: cached.solved,
        failed: cached.failed,
        error: cached.error,
        input: cached.input,
        traces: cached.traces,
        getOutput: () => cached.output,
      },
      metadata,
    })
    bySample.set(name, {
      report,
      inputSha256: am3352Hash(input),
      acceptedCacheSha256,
      tracesSha256: am3352Hash(cached.traces),
      physicalRoutesSha256: am3352Hash(
        cached.traces
          .map((trace: any) => ({
            connection_name: trace.connection_name,
            route: trace.route,
          }))
          .sort((a: any, b: any) =>
            a.connection_name.localeCompare(b.connection_name),
          ),
      ),
    })
  }
  candidateSets.push(candidates)
  auditedRuns.push(bySample)
}

// Reject bad reports, provenance, or caches from either revision before running
// the more expensive physical validation on both complete cache sets.
for (const [index, candidates] of candidateSets.entries()) {
  const validations = await validateAm3352SnapshotCandidates(candidates)
  for (const { candidate, validation } of validations)
    auditedRuns[index].get(candidate.metadata.name).validation = validation
}

const samples = SAMPLE_NAMES.map((name) => {
  const baseline = auditedRuns[0].get(name)
  const fix = auditedRuns[1].get(name)
  if (baseline.inputSha256 !== fix.inputSha256)
    throw Error(`${name}: differing inputs`)
  return {
    sample: name,
    inputSha256: baseline.inputSha256,
    baselineSeconds: baseline.report.solveMilliseconds / 1000,
    fixSeconds: fix.report.solveMilliseconds / 1000,
    baselineIterations: baseline.report.iterations,
    fixIterations: fix.report.iterations,
    changePercent:
      100 *
      (fix.report.solveMilliseconds / baseline.report.solveMilliseconds - 1),
    routesIdentical: baseline.physicalRoutesSha256 === fix.physicalRoutesSha256,
    traceRecordsIdentical: baseline.tracesSha256 === fix.tracesSha256,
    acceptedCachesIdentical:
      baseline.acceptedCacheSha256 === fix.acceptedCacheSha256,
    baselineAcceptedCacheSha256: baseline.acceptedCacheSha256,
    fixAcceptedCacheSha256: fix.acceptedCacheSha256,
    baselineTracesSha256: baseline.tracesSha256,
    fixTracesSha256: fix.tracesSha256,
    baselinePhysicalRoutesSha256: baseline.physicalRoutesSha256,
    fixPhysicalRoutesSha256: fix.physicalRoutesSha256,
    baselineBusLengths: baseline.validation.busLengths,
    fixBusLengths: fix.validation.busLengths,
    baselinePairLengths: baseline.validation.pairLengths,
    fixPairLengths: fix.validation.pairLengths,
  }
})
const percentiles = [0.5, 0.8, 0.9, 0.95].map((probability) => {
  const baselineSeconds = percentile(
    samples.map((sample) => sample.baselineSeconds),
    probability,
  )!
  const fixSeconds = percentile(
    samples.map((sample) => sample.fixSeconds),
    probability,
  )!
  return {
    percentile: `P${probability * 100}`,
    baselineSeconds,
    fixSeconds,
    changePercent: 100 * (fixSeconds / baselineSeconds - 1),
  }
})
const describeConcurrency = (label: string, concurrency?: number) =>
  concurrency === undefined
    ? `${label} concurrency metadata unavailable`
    : concurrency === 1
      ? `Serial ${label}`
      : `${label} used up to ${concurrency} concurrent workers`
const summary = {
  baselineSha,
  candidateSha,
  timeoutSeconds,
  sourceRevisionsVerifiedAgainstGit: true,
  baselineReportSha256: provenanceSets[0].benchmarkReportSha256,
  candidateReportSha256: provenanceSets[1].benchmarkReportSha256,
  baselineLibraryGitTreeSha1: provenanceSets[0].source.libGitTreeSha1,
  candidateLibraryGitTreeSha1: provenanceSets[1].source.libGitTreeSha1,
  baselineSourceManifestSha256: provenanceSets[0].source.frozenFilesSha256,
  candidateSourceManifestSha256: provenanceSets[1].source.frozenFilesSha256,
  baselineConcurrency: baselineConcurrency ?? null,
  candidateConcurrency: candidateConcurrency ?? null,
  acceptedBaseline: samples.length,
  acceptedFix: samples.length,
  lostCompletions: [],
  gainedCompletions: [],
  allRouteGeometryIdentical: samples.every((sample) => sample.routesIdentical),
  allAcceptedCachesIdentical: samples.every(
    (sample) => sample.acceptedCachesIdentical,
  ),
  execution: `${describeConcurrency("baseline", baselineConcurrency)}; ${describeConcurrency("candidate", candidateConcurrency)}. Both runs shared this cloud machine with separate investigation or G350 validation processes. One run per revision/placement, without alternating paired execution. Timing differences are descriptive; concurrent work limits runtime isolation. This comparison verifies completion, DRC, and matching preservation.`,
  percentiles,
  samples,
}
const timing = (value: number) => value.toFixed(3)
const percent = (value: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`
const skews = (measurements: any[]) =>
  measurements
    .map(
      (measurement) =>
        `${measurement.busId}: ${measurement.skewMm.toFixed(6)} / ${measurement.toleranceMm.toFixed(3)}`,
    )
    .join("; ")
const markdown = [
  "# G350 stacked fix regression comparison",
  "",
  `Baseline: \`${baselineSha}\`. Fix: \`${candidateSha}\`. Budget: ${timeoutSeconds} seconds per sample.`,
  "Both frozen-source manifests were verified against their declared Git revisions; required run provenance binds the exact report, fixture inputs, and accepted cache hashes.",
  "",
  "Both revisions independently accepted all eleven samples with 47/47 signals, unchanged inputs and 161 immutable power dogbones, combined-copper DRC, full-copper bus/pair matching, and coupling. Lost completions: none.",
  "These are the eleven existing 47-signal benchmark cases. The new 49-signal G350 repro requires a separate acceptance result.",
  "",
  `All eleven signal route geometries byte-identical: ${summary.allRouteGeometryIdentical}.`,
  `All eleven complete accepted cache files byte-identical: ${summary.allAcceptedCachesIdentical}.`,
  "",
  summary.execution,
  "",
  "| Percentile | Baseline (s) | Fix (s) | Change |",
  "| --- | ---: | ---: | ---: |",
  ...percentiles.map(
    (entry) =>
      `| ${entry.percentile} | ${timing(entry.baselineSeconds)} | ${timing(entry.fixSeconds)} | ${percent(entry.changePercent)} |`,
  ),
  "",
  "| Sample | Connectivity / DRC | Baseline (s) | Fix (s) | Change | Baseline / fix iterations | Identical routes / cache |",
  "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  ...samples.map(
    (sample) =>
      `| ${sample.sample} | 47/47 / pass | ${timing(sample.baselineSeconds)} | ${timing(sample.fixSeconds)} | ${percent(sample.changePercent)} | ${sample.baselineIterations} / ${sample.fixIterations} | ${sample.routesIdentical} / ${sample.acceptedCachesIdentical} |`,
  ),
  "",
  "Total planar copper skews include any fixed signal fanouts and new interconnect. They do not represent electrical propagation delay.",
  "",
  "| Sample | Baseline bus skew / tolerance (mm) | Fix bus skew / tolerance (mm) | Baseline pair skew / tolerance (mm) | Fix pair skew / tolerance (mm) |",
  "| --- | --- | --- | --- | --- |",
  ...samples.map(
    (sample) =>
      `| ${sample.sample} | ${skews(sample.baselineBusLengths)} | ${skews(sample.fixBusLengths)} | ${skews(sample.baselinePairLengths)} | ${skews(sample.fixPairLengths)} |`,
  ),
  "",
].join("\n")
const outputDirectory = resolve(outputArgument)
await mkdir(outputDirectory, { recursive: true })
await Bun.write(
  join(outputDirectory, "comparison.json"),
  JSON.stringify(summary, null, 2) + "\n",
)
await Bun.write(join(outputDirectory, "comparison.md"), markdown)
console.log(
  `Independently revalidated both eleven-case accepted caches; comparison saved to ${outputDirectory}`,
)
