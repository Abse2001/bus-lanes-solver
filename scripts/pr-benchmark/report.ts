import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

// This JSON manifest is shared by the trusted workflow and report renderer.
// Importing it never loads code from a PR checkout.
import sampleNames from "./samples.json"
export const SAMPLE_NAMES: readonly string[] = Object.freeze(sampleNames)
export type SampleName = (typeof SAMPLE_NAMES)[number]

export interface PairMetadata {
  order: ["main", "pr"] | ["pr", "main"]
  mainSha: string
  prSha: string
  controllerSha: string
  bunVersion: string
  platform: string
  architecture: string
  runnerName: string
  runnerOS: string
}
export interface WorkerArtifact {
  report: unknown | null
  wallMilliseconds: number
  exitCode: number | null
  error: string | null
  timedOut?: boolean
  /** Explicit placeholder for a revision that never ran. */
  missing?: true
}
export interface SamplePairArtifact {
  sample: SampleName
  timeoutSeconds: number
  main: WorkerArtifact
  pr: WorkerArtifact
  metadata: PairMetadata
}
export interface ComparisonOptions {
  samples: readonly SamplePairArtifact[]
  mainSha: string
  prSha: string
  controllerSha: string
  prNumber: number
  timeoutSeconds: number
  runUrl: string
}
export interface SkewMeasurement {
  name: string
  skewMm: number
  toleranceMm: number
}
export interface SampleResult {
  status:
    | "accepted"
    | "timed_out"
    | "failed"
    | "invalid"
    | "crashed"
    | "missing"
  accepted: boolean
  solveMilliseconds: number | null
  wallMilliseconds: number | null
  budgetedMilliseconds: number
  inputSha256: string | null
  reason: string | null
  busSkews: SkewMeasurement[]
  pairSkews: SkewMeasurement[]
}
export interface SampleComparison {
  sample: SampleName
  main: SampleResult
  pr: SampleResult
  comparable: boolean
}
export interface Percentiles {
  p50: number | null
  p80: number | null
  p90: number | null
  p95: number | null
}
export interface RefSummary {
  accepted: number
  timeouts: number
  failures: number
  budgeted: Percentiles
}
export interface ComparisonSummary {
  samples: SampleComparison[]
  artifactComplete: boolean
  inputComparable: boolean
  metadataComparable: boolean
  main: RefSummary
  pr: RefSummary
  lost: SampleName[]
  gained: SampleName[]
  matched: {
    count: number
    main: Percentiles
    pr: Percentiles
    deltaPercent: Percentiles
  }
}

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
const integer = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value)
const revision = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
const sampleName = (value: unknown): value is SampleName =>
  typeof value === "string" && SAMPLE_NAMES.some((sample) => sample === value)

const validateWorker = (value: unknown): WorkerArtifact => {
  const worker = object(value)
  if (
    !worker ||
    !("report" in worker) ||
    !finite(worker.wallMilliseconds) ||
    !(
      worker.exitCode === null ||
      (typeof worker.exitCode === "number" &&
        Number.isSafeInteger(worker.exitCode))
    ) ||
    !(worker.error === null || typeof worker.error === "string") ||
    !(worker.timedOut === undefined || typeof worker.timedOut === "boolean") ||
    !(worker.missing === undefined || worker.missing === true) ||
    (worker.missing === true &&
      (worker.report !== null ||
        worker.exitCode !== null ||
        worker.wallMilliseconds !== 0 ||
        worker.timedOut === true))
  ) {
    throw Error("Invalid worker artifact envelope")
  }
  return {
    report: worker.report,
    wallMilliseconds: worker.wallMilliseconds,
    exitCode: worker.exitCode,
    error: worker.error,
    ...(worker.timedOut === undefined ? {} : { timedOut: worker.timedOut }),
    ...(worker.missing === true ? { missing: true as const } : {}),
  }
}

const validateMetadata = (value: unknown): PairMetadata => {
  const metadata = object(value)
  if (
    !metadata ||
    !Array.isArray(metadata.order) ||
    metadata.order.length !== 2 ||
    !(
      (metadata.order[0] === "main" && metadata.order[1] === "pr") ||
      (metadata.order[0] === "pr" && metadata.order[1] === "main")
    ) ||
    !revision(metadata.mainSha) ||
    !revision(metadata.prSha) ||
    !revision(metadata.controllerSha) ||
    ["bunVersion", "platform", "architecture", "runnerName", "runnerOS"].some(
      (key) => typeof metadata[key] !== "string" || !metadata[key],
    )
  )
    throw Error("Invalid paired runner metadata")
  return metadata as unknown as PairMetadata
}

export function validateSamplePair(value: unknown): SamplePairArtifact {
  const pair = object(value)
  if (
    !pair ||
    !sampleName(pair.sample) ||
    !finite(pair.timeoutSeconds) ||
    pair.timeoutSeconds <= 0 ||
    !Number.isFinite(pair.timeoutSeconds * 1000)
  )
    throw Error("Invalid sample artifact or timeout budget")
  return {
    sample: pair.sample,
    timeoutSeconds: pair.timeoutSeconds,
    main: validateWorker(pair.main),
    pr: validateWorker(pair.pr),
    metadata: validateMetadata(pair.metadata),
  }
}

export function validateSamplePairs(values: unknown): SamplePairArtifact[] {
  if (!Array.isArray(values))
    throw Error("Expected an array of sample artifacts")
  const pairs = values.map(validateSamplePair)
  const seen = new Set<SampleName>()
  for (const pair of pairs) {
    if (seen.has(pair.sample))
      throw Error(`Duplicate sample artifact: ${pair.sample}`)
    seen.add(pair.sample)
  }
  return pairs
}

/** Reads runner artifacts, never imports or evaluates benchmark checkout code. */
export async function loadSamplePairs(
  directory: string,
): Promise<SamplePairArtifact[]> {
  const values: unknown[] = []
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const filename = join(path, entry.name)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile() && entry.name.endsWith(".json"))
        values.push(JSON.parse(await readFile(filename, "utf8")))
    }
  }
  await visit(directory)
  return validateSamplePairs(values)
}

/** Linear interpolation at sorted index (n - 1) * p; milliseconds in/out. */
export function percentile(
  values: readonly number[],
  probability: number,
): number | null {
  if (
    !finite(probability) ||
    probability > 1 ||
    values.some((value) => !finite(value))
  )
    throw Error(
      "Percentiles require finite nonnegative values and a probability in [0, 1]",
    )
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  return (
    sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)
  )
}
const percentiles = (values: readonly number[]): Percentiles => ({
  p50: percentile(values, 0.5),
  p80: percentile(values, 0.8),
  p90: percentile(values, 0.9),
  p95: percentile(values, 0.95),
})
const BUS_TOLERANCES = { DDR_BYTE0: 0.635, DDR_BYTE1: 0.635 }
const PAIR_TOLERANCES = { pair_0: 0.127, pair_1: 0.127, pair_2: 0.127 }
const measurements = (
  value: unknown,
  expected: Readonly<Record<string, number>>,
): SkewMeasurement[] | null => {
  if (!Array.isArray(value) || value.length !== Object.keys(expected).length)
    return null
  const result: SkewMeasurement[] = []
  const names = new Set<string>()
  for (const entry of value) {
    const measurement = object(entry)
    if (
      !measurement ||
      typeof measurement.busId !== "string" ||
      !Object.hasOwn(expected, measurement.busId) ||
      names.has(measurement.busId) ||
      measurement.matched !== true ||
      !finite(measurement.skewMm) ||
      measurement.toleranceMm !== expected[measurement.busId] ||
      measurement.skewMm > expected[measurement.busId] + 1e-7
    )
      return null
    names.add(measurement.busId)
    result.push({
      name: measurement.busId,
      skewMm: measurement.skewMm,
      toleranceMm: expected[measurement.busId],
    })
  }
  return result
}

function sampleResult(
  worker: WorkerArtifact | undefined,
  sample: SampleName,
  timeoutSeconds: number,
): SampleResult {
  const budget = timeoutSeconds * 1000
  const report = object(worker?.report)
  const result: SampleResult = {
    status: "missing",
    accepted: false,
    solveMilliseconds: null,
    wallMilliseconds: worker?.wallMilliseconds ?? null,
    budgetedMilliseconds: budget,
    inputSha256: hash(report?.inputSha256)
      ? (report!.inputSha256 as string).toLowerCase()
      : null,
    reason: "Missing sample artifact",
    busSkews: [],
    pairSkews: [],
  }
  if (!worker || worker.missing) {
    result.wallMilliseconds = null
    result.reason = worker?.error ?? result.reason
    return result
  }
  if (finite(report?.solveMilliseconds))
    result.solveMilliseconds = report!.solveMilliseconds as number
  if (
    worker.timedOut === true ||
    report?.status === "timed_out" ||
    (finite(report?.solveMilliseconds) && report.solveMilliseconds >= budget)
  ) {
    result.status = "timed_out"
    result.reason = worker.error ?? "Worker exceeded the timeout budget"
    return result
  }
  if (worker.exitCode !== 0) {
    result.status = "crashed"
    result.reason =
      worker.error ??
      `Worker exited ${worker.exitCode ?? "without an exit code"}`
    return result
  }
  if (
    !report ||
    report.sample !== sample ||
    report.timeoutSeconds !== timeoutSeconds ||
    !finite(report.solveMilliseconds) ||
    !finite(report.milliseconds) ||
    !integer(report.requestedSignals) ||
    report.requestedSignals <= 0 ||
    !integer(report.routedSignals) ||
    !hash(report.inputSha256) ||
    worker.error !== null
  ) {
    result.status = "invalid"
    result.reason =
      worker.error ?? "Missing, malformed, or inconsistent benchmark report"
    return result
  }
  const validation = object(report.validation)
  const fixedDrc = object(validation?.fixedDrc)
  const combinedDrc = object(validation?.combinedDrc)
  const busSkews = measurements(
    validation?.busLengths,
    sample === "inner-layers-complete-ca"
      ? { ...BUS_TOLERANCES, DDR_ADDR_CTRL_CK: 0.635 }
      : BUS_TOLERANCES,
  )
  const pairSkews = measurements(validation?.pairLengths, PAIR_TOLERANCES)
  if (
    report.status !== "solved" ||
    report.solved !== true ||
    report.error !== null ||
    validation?.valid !== true ||
    validation.complete !== true ||
    validation.matched !== true ||
    fixedDrc?.valid !== true ||
    combinedDrc?.valid !== true ||
    report.inputUnchanged !== true ||
    report.fixedPowerPreserved !== true ||
    report.requestedSignals !== 47 ||
    report.routedSignals !== 47 ||
    report.fixedPowerDogbones !== 161 ||
    validation.fixedPowerTraces !== 161 ||
    validation.fixedPowerVias !== 161 ||
    validation.fixedPowerPadJoins !== 161 ||
    !busSkews ||
    !pairSkews
  ) {
    result.status = "failed"
    result.reason =
      typeof report.error === "string"
        ? report.error
        : "Routing did not pass complete connectivity, matching, DRC, and fixed-power preservation"
    return result
  }
  result.status = "accepted"
  result.accepted = true
  result.budgetedMilliseconds = Math.min(report.solveMilliseconds, budget)
  result.reason = null
  result.busSkews = busSkews
  result.pairSkews = pairSkews
  return result
}

function validateOptions(options: ComparisonOptions) {
  if (
    !revision(options.mainSha) ||
    !revision(options.prSha) ||
    !revision(options.controllerSha) ||
    !integer(options.prNumber) ||
    options.prNumber <= 0 ||
    !finite(options.timeoutSeconds) ||
    options.timeoutSeconds <= 0 ||
    !Number.isFinite(options.timeoutSeconds * 1000) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/.test(
      options.runUrl,
    )
  )
    throw Error(
      "Invalid pinned revisions, PR number, timeout, or workflow run URL",
    )
}

export function summarizeComparison(
  options: ComparisonOptions,
): ComparisonSummary {
  validateOptions(options)
  const artifacts = validateSamplePairs(options.samples)
  for (const artifact of artifacts)
    if (artifact.timeoutSeconds !== options.timeoutSeconds)
      throw Error("Sample timeout differs from the comparison budget")
  const bySample = new Map(
    artifacts.map((artifact) => [artifact.sample, artifact]),
  )
  let inputComparable = true
  let metadataComparable = true
  const samples = SAMPLE_NAMES.map((sample): SampleComparison => {
    const pair = bySample.get(sample)
    const main = sampleResult(pair?.main, sample, options.timeoutSeconds)
    const pr = sampleResult(pair?.pr, sample, options.timeoutSeconds)
    const inputMismatch =
      main.inputSha256 !== null &&
      pr.inputSha256 !== null &&
      main.inputSha256 !== pr.inputSha256
    const metadata = pair?.metadata
    const metadataMismatch =
      metadata !== undefined &&
      (metadata.mainSha.toLowerCase() !== options.mainSha.toLowerCase() ||
        metadata.prSha.toLowerCase() !== options.prSha.toLowerCase() ||
        metadata.controllerSha.toLowerCase() !==
          options.controllerSha.toLowerCase())
    if (inputMismatch || metadataMismatch) {
      if (inputMismatch) inputComparable = false
      if (metadataMismatch) metadataComparable = false
      for (const result of [main, pr]) {
        result.status = "invalid"
        result.accepted = false
        result.budgetedMilliseconds = options.timeoutSeconds * 1000
        result.reason = inputMismatch
          ? "Main and PR fixture input hashes differ; comparison unavailable"
          : "Artifact revision metadata differs from pinned revisions; comparison unavailable"
        result.busSkews = []
        result.pairSkews = []
      }
    }
    return { sample, main, pr, comparable: !inputMismatch && !metadataMismatch }
  })
  const summarizeRef = (ref: "main" | "pr"): RefSummary => ({
    accepted: samples.filter((sample) => sample[ref].accepted).length,
    timeouts: samples.filter((sample) => sample[ref].status === "timed_out")
      .length,
    failures: samples.filter(
      (sample) => !sample[ref].accepted && sample[ref].status !== "timed_out",
    ).length,
    budgeted: percentiles(
      samples.map((sample) => sample[ref].budgetedMilliseconds),
    ),
  })
  const artifactComplete =
    artifacts.length === SAMPLE_NAMES.length &&
    artifacts.every((pair) => !pair.main.missing && !pair.pr.missing)
  const matchedSamples = samples.filter(
    (sample) => sample.main.accepted && sample.pr.accepted && sample.comparable,
  )
  const mainMatched = percentiles(
    artifactComplete && inputComparable && metadataComparable
      ? matchedSamples.map((sample) => sample.main.solveMilliseconds!)
      : [],
  )
  const prMatched = percentiles(
    artifactComplete && inputComparable && metadataComparable
      ? matchedSamples.map((sample) => sample.pr.solveMilliseconds!)
      : [],
  )
  const delta = (before: number | null, after: number | null) =>
    before === null || after === null || before === 0
      ? null
      : Number.isFinite(((after - before) / before) * 100)
        ? ((after - before) / before) * 100
        : null
  return {
    samples,
    artifactComplete,
    inputComparable,
    metadataComparable,
    main: summarizeRef("main"),
    pr: summarizeRef("pr"),
    lost: samples
      .filter((sample) => sample.main.accepted && !sample.pr.accepted)
      .map((sample) => sample.sample),
    gained: samples
      .filter((sample) => !sample.main.accepted && sample.pr.accepted)
      .map((sample) => sample.sample),
    matched: {
      count: matchedSamples.length,
      main: mainMatched,
      pr: prMatched,
      deltaPercent: {
        p50: delta(mainMatched.p50, prMatched.p50),
        p80: delta(mainMatched.p80, prMatched.p80),
        p90: delta(mainMatched.p90, prMatched.p90),
        p95: delta(mainMatched.p95, prMatched.p95),
      },
    },
  }
}

// Reports are untrusted data: never permit HTML/Markdown or @mentions in them.
const escape = (value: string) =>
  value.replace(/[&<>"'`*_[\]{}()!#|@\\\r\n]/g, (character) =>
    character === "\r" || character === "\n"
      ? " "
      : `&#${character.charCodeAt(0)};`,
  )
const seconds = (milliseconds: number | null) =>
  milliseconds === null ? "n/a" : `${(milliseconds / 1000).toFixed(3)} s`
const percent = (value: number | null) =>
  value === null ? "n/a" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`
const percentileRows = (
  main: Percentiles,
  pr: Percentiles,
  delta?: Percentiles,
) =>
  (["p50", "p80", "p90", "p95"] as const).map(
    (key) =>
      `| ${key.toUpperCase()} | ${seconds(main[key])} | ${seconds(pr[key])}${delta ? ` | ${percent(delta[key])}` : ""} |`,
  )
const resultCell = (result: SampleResult) =>
  `${result.status.replace("_", " ")}${result.accepted ? " (47/47 signals; DRC passed)" : ""} · solve ${seconds(result.solveMilliseconds)} · wall ${seconds(result.wallMilliseconds)}`
const skews = (measurements: readonly SkewMeasurement[], accepted: boolean) =>
  accepted
    ? measurements
        .map(
          (measurement) =>
            `${escape(measurement.name)}: ${measurement.skewMm.toFixed(4)} / ${measurement.toleranceMm.toFixed(4)}`,
        )
        .join("<br>")
    : "n/a (not accepted)"

export function renderComparison(options: ComparisonOptions): string {
  const summary = summarizeComparison(options)
  const lines = [
    `AM3352 benchmark for PR #${options.prNumber} · [workflow artifacts](${options.runUrl})`,
    "",
    `Main: \`${options.mainSha}\` · PR: \`${options.prSha}\` · timeout budget: ${options.timeoutSeconds} s per sample.`,
    "",
    ...(options.controllerSha
      ? [`Controller: \`${options.controllerSha}\`.`, ""]
      : []),
    `Accepted completions: main **${summary.main.accepted}/${SAMPLE_NAMES.length}**, PR **${summary.pr.accepted}/${SAMPLE_NAMES.length}**. Timeouts: ${summary.main.timeouts} → ${summary.pr.timeouts}. Other failures (including crash, invalid, or missing): ${summary.main.failures} → ${summary.pr.failures}.`,
    "",
    `Lost completions (main accepted, PR not accepted): ${summary.lost.join(", ") || "none"}. Gained completions: ${summary.gained.join(", ") || "none"}.`,
    "",
  ]
  if (!summary.artifactComplete)
    lines.push(
      "**Incomplete artifacts:** missing canonical samples or revision workers receive the full budget penalty. Matched-completion percentiles are unavailable; this run cannot establish no regression.",
      "",
    )
  if (!summary.inputComparable)
    lines.push(
      "**Input mismatch:** at least one main/PR pair has different fixture hashes. Both results receive the full budget penalty, and matched-completion comparisons are unavailable.",
      "",
    )
  if (!summary.metadataComparable)
    lines.push(
      "**Revision mismatch:** at least one artifact has revision metadata that differs from the pinned commits. Both results receive the full budget penalty, and matched-completion comparisons are unavailable.",
      "",
    )
  lines.push(
    "**Budgeted time to valid completion — all 11 canonical samples**",
    "",
    "Acceptance requires solving strictly before the timeout budget. An accepted sample contributes min(actual solve time, timeout budget). Every failure, timeout, crash, missing artifact, or invalid result contributes the full budget. These are completion-aware budgeted values, not percentiles of actual elapsed durations.",
    "",
    "| Percentile | Main | PR |",
    "| --- | ---: | ---: |",
    ...percentileRows(summary.main.budgeted, summary.pr.budgeted),
    "",
    `**Actual solve time on the same ${summary.matched.count} samples accepted on both revisions**`,
    "",
    "| Percentile | Main | PR | PR change |",
    "| --- | ---: | ---: | ---: |",
    ...percentileRows(
      summary.matched.main,
      summary.matched.pr,
      summary.matched.deltaPercent,
    ),
    "",
    "Percentiles use linear interpolation at (n − 1) × p. A PR change has no percentage when the main value is zero.",
    "",
    "| Sample | Main status / actual elapsed | PR status / actual elapsed | Completion |",
    "| --- | --- | --- | --- |",
  )
  for (const sample of summary.samples)
    lines.push(
      `| ${sample.sample} | ${resultCell(sample.main)} | ${resultCell(sample.pr)} | ${!sample.comparable ? "comparison unavailable" : sample.main.accepted && !sample.pr.accepted ? "lost" : !sample.main.accepted && sample.pr.accepted ? "gained" : sample.main.accepted && sample.pr.accepted ? "both accepted" : "neither accepted"} |`,
    )
  lines.push(
    "",
    "**Accepted total-copper bus and differential-pair skews (skew / tolerance, mm)**",
    "",
    "| Sample | Main buses | PR buses | Main pairs | PR pairs |",
    "| --- | --- | --- | --- | --- |",
  )
  for (const sample of summary.samples)
    lines.push(
      `| ${sample.sample} | ${skews(sample.main.busSkews, sample.main.accepted)} | ${skews(sample.pr.busSkews, sample.pr.accepted)} | ${skews(sample.main.pairSkews, sample.main.accepted)} | ${skews(sample.pr.pairSkews, sample.pr.accepted)} |`,
    )
  lines.push(
    "",
    "<details><summary>Fixture input SHA-256 hashes</summary>",
    "",
    "| Sample | Main input | PR input |",
    "| --- | --- | --- |",
  )
  for (const sample of summary.samples)
    lines.push(
      `| ${sample.sample} | ${sample.main.inputSha256 ?? "unavailable"} | ${sample.pr.inputSha256 ?? "unavailable"} |`,
    )
  lines.push("", "</details>")
  const failures = summary.samples.flatMap((sample) =>
    (["main", "pr"] as const).flatMap((ref) =>
      sample[ref].reason
        ? [
            `- ${sample.sample} ${ref}: ${escape(sample[ref].reason!.slice(0, 300))}`,
          ]
        : [],
    ),
  )
  if (failures.length) lines.push("", "Failure details:", "", ...failures)
  return `${lines.join("\n")}\n`
}
