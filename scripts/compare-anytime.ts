import { cp, mkdir, rm, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  getPngBufferFromGraphicsObject,
  type GraphicsObject,
} from "graphics-debug"
import {
  AnytimeBusLanesSolver,
  BusLanesSolver,
  type SimpleRouteJson,
  type Trace,
} from "../lib"
import { layerColor } from "../lib/layer-colors"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { channelInput } from "../examples/vector-channel"
import {
  am3352Hash,
  am3352SamplePlacements,
  loadAm3352Sample,
  type Am3352SampleMetadata,
} from "./am3352-samples"
import {
  exportAm3352RoutedSnapshots,
  type Am3352SnapshotCandidate,
} from "./snapshot-routed-am3352"
import {
  validateAm3352OutputShape,
  validateAm3352Sample,
} from "./validate-am3352-sample"
import {
  validateTwoFanoutSample,
  type FanoutMetadata,
} from "./validate-two-fanout-sample"
import type { AnytimeComparisonReport } from "./anytime-report"
import {
  createAnytimePhysicalProbe,
  measureAnytimePhysicalMetrics,
} from "./anytime-physical-metrics"
import {
  createFrozenComparisonWorkspace,
  fingerprintComparisonSources,
  runComparisonJobs,
  type ComparisonSourceFingerprint,
} from "./anytime-comparison-runner"

const efforts = [1, 2, 5] as const
const ddrNames = [
  "ddr_left_io_right",
  "ddr_right_io_left",
  "ddr_top_io_bottom",
  "ddr_bottom_io_top",
]
type Sample = AnytimeComparisonReport["samples"][number]
type Checkpoint = Sample["checkpoints"][number]
interface LoadedSample {
  id: string
  title: string
  family: Sample["family"]
  input: SimpleRouteJson
  am3352?: Am3352SampleMetadata
  ddr?: FanoutMetadata
}

/** The physical viewport is shared by all effort checkpoints for a sample. */
function commonBounds(input: SimpleRouteJson, checkpoints: Checkpoint[]) {
  const points = [
    ...checkpoints.flatMap((c) =>
      (c.output.traces ?? []).flatMap((t) =>
        t.route.flatMap((p) => {
          const radius =
            p.route_type === "wire" ? p.width / 2 : (p.via_diameter ?? 0.3) / 2
          return [
            { x: p.x - radius, y: p.y - radius },
            { x: p.x + radius, y: p.y + radius },
          ]
        }),
      ),
    ),
    // Ignore conservative fixed-copper rasterization when drawing AM62L pads.
    ...input.obstacles
      .filter((p) => input.layerCount < 8 || p.componentId)
      .flatMap((p) => [
        { x: p.center.x - p.width / 2, y: p.center.y - p.height / 2 },
        { x: p.center.x + p.width / 2, y: p.center.y + p.height / 2 },
      ]),
  ]
  if (!points.length) return input.bounds
  return {
    minX: Math.min(...points.map((p) => p.x)) - 1,
    maxX: Math.max(...points.map((p) => p.x)) + 1,
    minY: Math.min(...points.map((p) => p.y)) - 1,
    maxY: Math.max(...points.map((p) => p.y)) + 1,
  }
}

export async function loadAnytimeComparisonSamples(): Promise<LoadedSample[]> {
  const samples: LoadedSample[] = []
  for (const placement of am3352SamplePlacements) {
    const { input, metadata } = await loadAm3352Sample(placement.name)
    samples.push({
      id: `am3352-${placement.name}`,
      title: `AM3352 · ${placement.name}`,
      family: "AM3352",
      input,
      am3352: metadata,
    })
  }
  for (const name of ddrNames) {
    const input = await Bun.file(
      new URL(`../tests/fixtures/two-fanouts/${name}.json`, import.meta.url),
    ).json()
    const ddr = await Bun.file(
      new URL(
        `../tests/fixtures/two-fanouts/${name}.meta.json`,
        import.meta.url,
      ),
    ).json()
    samples.push({
      id: `am62l-${name}`,
      title: `AM62L · ${name.replaceAll("_", " ")}`,
      family: "AM62L",
      input,
      ddr,
    })
  }
  samples.push({
    id: "obstacle-channel",
    title: "Three-lane obstacle channel",
    family: "channel",
    input: channelInput(),
  })
  samples.push({
    id: "skew-tolerance",
    title: "Skew tolerance · 0.5 mm",
    family: "channel",
    input: {
      layerCount: 2,
      minTraceWidth: 0.075,
      bounds: { minX: -2, maxX: 14, minY: -5, maxY: 7 },
      obstacles: [],
      connections: [
        {
          name: "DATA0",
          pointsToConnect: [
            { x: 0, y: 0, layer: "top" },
            { x: 10, y: 0, layer: "top" },
          ],
        },
        {
          name: "DATA1",
          pointsToConnect: [
            { x: 0, y: 3, layer: "top" },
            { x: 8, y: 3, layer: "top" },
          ],
        },
      ],
      buses: [
        {
          busId: "DATA",
          connectionNames: ["DATA0", "DATA1"],
          maxLengthSkew: 0.5,
          traceWidth: 0.15,
        },
      ],
    },
  })
  return samples
}

export async function validateAnytimeComparisonCheckpoint(
  sample: LoadedSample,
  traces: Trace[],
  output: SimpleRouteJson,
) {
  const { input } = sample
  if (sample.am3352) {
    validateAm3352OutputShape(input, sample.am3352, traces, output)
    const validation = await validateAm3352Sample(input, sample.am3352, traces)
    if (!validation.valid)
      throw Error(
        `${sample.id}: independent AM3352 validation failed: ${validation.issues.join("; ") || validation.combinedDrc?.issues[0]?.message}`,
      )
    return validation
  }
  // This mode validates immutable routes, without repair or length tuning.
  const validator = BusLanesSolver.forValidation(input, traces, {
    smoothTuning: true,
  })
  validator.solve()
  if (!validator.solved || validator.failed)
    throw Error(`${sample.id}: final geometry validator: ${validator.error}`)
  if (
    traces.length !== input.connections.length ||
    input.connections.some(
      (c) => traces.filter((t) => t.connection_name === c.name).length !== 1,
    ) ||
    am3352Hash(output.traces?.slice(0, input.traces?.length ?? 0)) !==
      am3352Hash(input.traces ?? []) ||
    am3352Hash({ ...output, traces: undefined }) !==
      am3352Hash({ ...input, traces: undefined })
  )
    throw Error(`${sample.id}: incomplete connectivity or changed fixed input`)
  const busLengths = busLengthReports(input, traces)
  const pairLengths = pairLengthReports(input, traces)
  if (
    [...busLengths, ...pairLengths].some(
      (b) => b.toleranceMm !== null && !b.matched,
    )
  )
    throw Error(`${sample.id}: complete-copper length matching failed`)
  const fanout = sample.ddr
    ? validateTwoFanoutSample(input, sample.ddr, traces)
    : null
  return {
    valid: true,
    complete: true,
    matched: true,
    routedSignals: traces.length,
    requestedSignals: input.connections.length,
    geometryValidated: true,
    fanout,
    busLengths,
    pairLengths,
  }
}

/** Native copper renderer for AM62L and channel review images. */
function graphicsForCheckpoint(sample: Sample, checkpoint: Checkpoint) {
  const { bounds, input } = sample
  const traces = checkpoint.output.traces ?? []
  const physicalLayers = Array.from({ length: input.layerCount }, (_, i) =>
    i === 0 ? "top" : i === input.layerCount - 1 ? "bottom" : `inner${i}`,
  )
  const viaLayers = (
    p: Extract<Trace["route"][number], { route_type: "via" }>,
  ) => {
    if (p.layers) return p.layers
    const from = physicalLayers.indexOf(p.from_layer)
    const to = physicalLayers.indexOf(p.to_layer)
    return physicalLayers.slice(Math.min(from, to), Math.max(from, to) + 1)
  }
  const layers = [
    ...new Set(
      traces.flatMap((t) =>
        t.route.flatMap((p) => (p.route_type === "wire" ? [p.layer] : [])),
      ),
    ),
  ]
    .filter((l) => l !== "top" || sample.family === "channel")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const totalWidth = layers.length * width + (layers.length - 1) * 3
  const graphics: GraphicsObject = {
    coordinateSystem: "cartesian",
    title: `${sample.title} · ${checkpoint.effort}x · complete routing and matching passed`,
    lines: [],
    circles: [],
    rects: [],
    texts: [],
  }
  for (const [index, layer] of layers.entries()) {
    const dx = index * (width + 3)
    graphics.rects!.push({
      center: {
        x: (bounds.minX + bounds.maxX) / 2 + dx,
        y: (bounds.minY + bounds.maxY) / 2,
      },
      width,
      height,
      fill: "none",
      stroke: "#354150",
    })
    for (const obstacle of input.obstacles.filter(
      (o) => sample.family !== "AM62L" || o.componentId,
    )) {
      const fill = obstacle.layers.includes(layer)
        ? "#4c3134"
        : "rgba(76,49,52,0.25)"
      if (obstacle.shape === "circle")
        graphics.circles!.push({
          center: { x: obstacle.center.x + dx, y: obstacle.center.y },
          radius: obstacle.width / 2,
          fill,
          stroke: "none",
        })
      else
        graphics.rects!.push({
          center: { x: obstacle.center.x + dx, y: obstacle.center.y },
          width: obstacle.width,
          height: obstacle.height,
          ccwRotationDegrees: obstacle.ccwRotationDegrees,
          fill,
          stroke: "none",
        })
    }
    for (const trace of traces) {
      for (let i = 1; i < trace.route.length; i++) {
        const a = trace.route[i - 1],
          b = trace.route[i]
        const wire =
          a.route_type === "wire" ? a : b.route_type === "wire" ? b : null
        const onLayer = (p: Trace["route"][number]) =>
          p.route_type === "wire"
            ? p.layer === layer
            : viaLayers(p).includes(layer)
        if (wire && wire.layer === layer && onLayer(a) && onLayer(b))
          graphics.lines!.push({
            points: [
              { x: a.x + dx, y: a.y },
              { x: b.x + dx, y: b.y },
            ],
            strokeWidth: wire.width,
            strokeColor: layerColor(layer),
          })
      }
      for (const p of trace.route)
        if (p.route_type === "via" && viaLayers(p).includes(layer)) {
          graphics.circles!.push({
            center: { x: p.x + dx, y: p.y },
            radius: (p.via_diameter ?? 0.3) / 2,
            fill: layerColor(layer),
            stroke: "none",
          })
          graphics.circles!.push({
            center: { x: p.x + dx, y: p.y },
            radius: (p.via_hole_diameter ?? 0.15) / 2,
            fill: "#10151b",
            stroke: "none",
          })
        }
    }
    graphics.texts!.push({
      x: bounds.minX + dx,
      y: bounds.maxY + 1.3,
      text: layer,
      color: layerColor(layer),
      fontSize: Math.min(1.1, width / 15),
      anchorSide: "bottom_left",
    })
  }
  const title = `${sample.title} · ${checkpoint.effort}x · ${input.connections.length}/${input.connections.length} signals · DRC + matching passed`
  graphics.texts!.push({
    x: bounds.minX,
    y: bounds.maxY + 3,
    text: title,
    color: "#ffffff",
    fontSize: Math.min(1.4, totalWidth / (title.length * 1.05)),
    anchorSide: "bottom_left",
  })
  return { graphics, width: totalWidth, height: height + 5 }
}

/** Publish exact, fully audited data before the slower native image exports. */
async function saveValidatedComparisonData(
  report: AnytimeComparisonReport,
  directory: string,
  html: string,
) {
  await mkdir(join(directory, "outputs"), { recursive: true })
  for (const sample of report.samples)
    for (const checkpoint of sample.checkpoints) {
      await Bun.write(
        join(
          directory,
          "outputs",
          `${sample.id}-${checkpoint.effort}x.json.gz`,
        ),
        Bun.gzipSync(JSON.stringify(checkpoint.output) + "\n", { level: 9 }),
      )
      await rm(
        join(directory, "outputs", `${sample.id}-${checkpoint.effort}x.json`),
        { force: true },
      )
    }
  const measurements = {
    ...report,
    samples: report.samples.map(({ input, checkpoints, ...sample }) => ({
      ...sample,
      inputSha256: am3352Hash(input),
      requestedSignals: input.connections.length,
      fixedTraces: input.traces?.length ?? 0,
      checkpoints: checkpoints.map(({ output, ...checkpoint }) => ({
        ...checkpoint,
        outputSha256: am3352Hash(output),
        outputFile: `outputs/${sample.id}-${checkpoint.effort}x.json.gz`,
      })),
    })),
  }
  await Bun.write(
    join(directory, "measurements.json"),
    JSON.stringify(measurements, null, 2) + "\n",
  )
  await Bun.write(join(directory, "index.html"), html)
  console.log(
    `All ${report.samples.length * 3} native checkpoints passed; validated report data saved before snapshot export.`,
  )
}

interface CachedBaseline {
  inputSha256: string
  traces: Trace[]
  routingMilliseconds: number
}
interface ComparisonSampleJob {
  sample: LoadedSample
  iterationsPerX: number
  reuseBaselines: boolean
  physicalOptions: { enabled?: boolean; pitchMm?: number }
  baselineDirectory: string
  diagnosticDirectory: string
  resultFile: string
  inputSha256: string
  seedSha256: string | null
  sourceFingerprint: ComparisonSourceFingerprint
}
interface ComparisonSampleResult {
  loaded: LoadedSample
  comparison: Sample
  sourceFingerprint: ComparisonSourceFingerprint
  inputSha256: string
  seedSha256: string | null
}
interface ComparisonRenderJob {
  kind: "am3352" | "other"
  effort?: 1 | 2 | 5
  sampleResultFiles: string[]
  directory: string
  sourceFingerprint: ComparisonSourceFingerprint
  nativeManifestFile: string
}
export interface CompareAnytimeExecutionOptions {
  /** Independent sample processes; each retains its own effort continuation. */
  concurrency?: number
  /** Stage fully validated assets for visual inspection before publishing. */
  publish?: boolean
}

async function assertWorkerGeneration(expected: ComparisonSourceFingerprint) {
  const actual = await fingerprintComparisonSources(
    resolve(import.meta.dir, ".."),
  )
  if (actual.sha256 !== expected.sha256)
    throw Error(
      "Frozen comparison source fingerprint changed; refusing artifacts",
    )
}

async function readComparisonSampleResult(file: string) {
  return JSON.parse(
    new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await Bun.file(file).arrayBuffer())),
    ),
  ) as ComparisonSampleResult
}

/** One worker owns the entire deterministic 1x→2x→5x continuation. */
async function runAnytimeComparisonSample(job: ComparisonSampleJob) {
  await assertWorkerGeneration(job.sourceFingerprint)
  const loaded = [job.sample]
  const iterationsPerX = job.iterationsPerX
  const reuseBaselines = job.reuseBaselines
  const physicalOptions = job.physicalOptions
  const baselineDirectory = job.baselineDirectory
  const diagnosticDirectory = job.diagnosticDirectory
  if (am3352Hash(job.sample.input) !== job.inputSha256)
    throw Error(`${job.sample.id}: frozen original input hash mismatch`)
  const report: AnytimeComparisonReport = {
    generatedAt: new Date().toISOString(),
    iterationsPerX,
    samples: [],
  }
  for (const sample of loaded) {
    const hash = am3352Hash(sample.input)
    const started = performance.now()
    const options = {
      effort: 1 as const,
      fanout:
        sample.family === "AM3352" ? ("auto" as const) : ("none" as const),
      iterationsPerX,
    }
    const baselineFile = Bun.file(join(baselineDirectory, `${sample.id}.json`))
    const cached =
      reuseBaselines && (await baselineFile.exists())
        ? ((await baselineFile.json()) as {
            inputSha256: string
            traces: Trace[]
            routingMilliseconds: number
          })
        : null
    if (reuseBaselines && cached?.inputSha256 !== hash)
      throw Error(`${sample.id}: frozen pristine baseline input mismatch`)
    if (cached && am3352Hash(cached.traces) !== job.seedSha256)
      throw Error(`${sample.id}: frozen pristine seed hash mismatch`)
    const baselineReused = cached?.inputSha256 === hash
    const solver = baselineReused
      ? AnytimeBusLanesSolver.fromCompleted(
          sample.input,
          cached.traces,
          options,
        )
      : new AnytimeBusLanesSolver(sample.input, options)
    const routingStarted = performance.now()
    while (!solver.solved && !solver.exhausted) solver.step()
    const baselineMilliseconds = baselineReused
      ? cached.routingMilliseconds
      : performance.now() - routingStarted
    if (solver.solved && !baselineReused)
      await Bun.write(
        baselineFile,
        JSON.stringify({
          inputSha256: hash,
          traces: solver.traces,
          routingMilliseconds: baselineMilliseconds,
        }) + "\n",
      )
    let solveMilliseconds = baselineMilliseconds
    // Freeze one physical domain from the genuine completed initial route.
    // Extra effort cannot gain free space by changing its ROI, layers or pitch.
    const physicalProbe =
      physicalOptions.enabled === false
        ? undefined
        : createAnytimePhysicalProbe(sample.input, solver.traces, {
            pitchMm: physicalOptions.pitchMm ?? 0.1,
          })
    const physicalBaseline = physicalProbe
      ? measureAnytimePhysicalMetrics(
          sample.input,
          solver.traces,
          physicalProbe,
        )
      : undefined
    const checkpoints: Checkpoint[] = []
    for (const effort of efforts) {
      const solving = performance.now()
      if (effort === 1) solver.solve()
      else solver.improve(effort)
      solveMilliseconds += performance.now() - solving
      const result = structuredClone(solver.getResult())
      const traces = structuredClone(solver.traces)
      // Keep diagnostic checkpoints outside the review-artifact directory so
      // failed validators remain inspectable without exporting invalid copper.
      await Bun.write(
        join(diagnosticDirectory, `${sample.id}-${effort}x.json`),
        JSON.stringify({ result, traces, input: sample.input }) + "\n",
      )
      if (am3352Hash(sample.input) !== hash)
        throw Error(`${sample.id}: solver changed its immutable input`)
      if (result.status !== "valid" || !solver.solved || solver.failed)
        throw Error(
          `${sample.id} ${effort}x: refusing best-effort review artifacts: ${solver.error ?? JSON.stringify(result.violations)}`,
        )
      const validation = await validateAnytimeComparisonCheckpoint(
        sample,
        traces,
        result.output,
      )
      const checkpoint: Checkpoint = {
        effort,
        solveMilliseconds,
        baselineMilliseconds,
        baselineReused,
        optimizationMilliseconds: solveMilliseconds - baselineMilliseconds,
        totalMilliseconds:
          performance.now() -
          started +
          (baselineReused ? baselineMilliseconds : 0),
        optimizationIterations: result.optimizationIterations,
        iterations: result.iterations,
        acceptedImprovements: result.acceptedImprovements,
        exhausted: result.exhausted,
        status: result.status,
        valid: true,
        validation,
        diagnostics: structuredClone(solver.stats),
        physical: physicalProbe
          ? measureAnytimePhysicalMetrics(sample.input, traces, physicalProbe)
          : undefined,
        score: result.score,
        output: result.output,
      }
      const previous = checkpoints.at(-1)
      if (
        previous &&
        checkpoint.score.objective > previous.score.objective + 1e-7
      )
        throw Error(`${sample.id}: objective worsened at ${effort}x`)
      checkpoints.push(checkpoint)
      console.log(
        `${sample.id} ${effort}x: complete + DRC + matching; objective=${result.score.objective.toFixed(6)} envelope=${result.score.envelopeAreaMm2.toFixed(3)}mm² copper=${result.score.totalLengthMm.toFixed(3)}mm time=${(solveMilliseconds / 1000).toFixed(3)}s iterations=${result.optimizationIterations}`,
      )
    }
    report.samples.push({
      id: sample.id,
      title: sample.title,
      family: sample.family,
      input: sample.input,
      bounds: commonBounds(sample.input, checkpoints),
      checkpoints,
      physicalProbe,
      physicalBaseline,
    })
  }
  await assertWorkerGeneration(job.sourceFingerprint)
  const result: ComparisonSampleResult = {
    loaded: job.sample,
    comparison: report.samples[0],
    sourceFingerprint: job.sourceFingerprint,
    inputSha256: job.inputSha256,
    seedSha256: job.seedSha256,
  }
  await Bun.write(
    job.resultFile,
    Bun.gzipSync(JSON.stringify(result), { level: 6 }),
  )
}

async function renderOtherComparisonSample(sample: Sample, directory: string) {
  for (const checkpoint of sample.checkpoints) {
    const { graphics, width, height } = graphicsForCheckpoint(
      sample,
      checkpoint,
    )
    const pngWidth = 2200
    const pngHeight = Math.max(500, Math.round((pngWidth * height) / width))
    await Bun.write(
      join(directory, `${sample.id}-${checkpoint.effort}x-solved.png`),
      await getPngBufferFromGraphicsObject(graphics, {
        includeTextLabels: false,
        backgroundColor: "#10151b",
        pngWidth,
        pngHeight,
        yFlip: true,
      }),
    )
  }
}

/** AM3352 keeps the native all-eight validation/export gate at every effort. */
async function runComparisonRenderJob(job: ComparisonRenderJob) {
  await assertWorkerGeneration(job.sourceFingerprint)
  const manifest = await Bun.file(job.nativeManifestFile).json()
  if (
    manifest.sourceFingerprint !== job.sourceFingerprint.sha256 ||
    manifest.samples.length !== 14 ||
    new Set(manifest.samples.map((sample: { id: string }) => sample.id))
      .size !== 14 ||
    manifest.samples.some(
      (sample: { checkpoints: Array<{ effort: number; valid: boolean }> }) =>
        sample.checkpoints.length !== 3 ||
        efforts.some(
          (effort) =>
            sample.checkpoints.filter(
              (checkpoint) => checkpoint.effort === effort && checkpoint.valid,
            ).length !== 1,
        ),
    )
  )
    throw Error(
      "All 42 native checkpoints must pass before any snapshot export",
    )
  const results = await Promise.all(
    job.sampleResultFiles.map(readComparisonSampleResult),
  )
  for (const result of results) {
    if (
      result.sourceFingerprint.sha256 !== job.sourceFingerprint.sha256 ||
      result.inputSha256 !== am3352Hash(result.loaded.input) ||
      result.comparison.checkpoints.length !== efforts.length ||
      result.comparison.checkpoints.some(
        (c) => !c.valid || c.status !== "valid",
      )
    )
      throw Error(
        "Snapshot worker requires fully audited comparison checkpoints",
      )
  }
  await mkdir(job.directory, { recursive: true })
  if (job.kind === "am3352") {
    const candidates: Am3352SnapshotCandidate[] = results.map((result) => {
      const checkpoint = result.comparison.checkpoints.find(
        (c) => c.effort === job.effort,
      )!
      const input = result.loaded.input
      return {
        metadata: result.loaded.am3352!,
        solver: {
          input,
          traces: checkpoint.output.traces!.slice(input.traces?.length ?? 0),
          solved: true,
          failed: false,
          error: null,
          getOutput: () => ({
            ...checkpoint.output,
            traces: checkpoint.output.traces!,
          }),
        },
      }
    })
    await exportAm3352RoutedSnapshots(candidates, job.directory)
    for (const placement of am3352SamplePlacements)
      await unlink(join(job.directory, `${placement.name}-solved.svg`))
  } else {
    if (results.length !== 1 || results[0].comparison.family === "AM3352")
      throw Error(
        "Other snapshot worker requires one completed non-AM3352 sample",
      )
    await renderOtherComparisonSample(results[0].comparison, job.directory)
  }
  await assertWorkerGeneration(job.sourceFingerprint)
}

export async function compareAnytime(
  directory = resolve(import.meta.dir, "../docs/anytime"),
  iterationsPerX = 512,
  reuseBaselines = false,
  physicalOptions: { enabled?: boolean; pitchMm?: number } = {},
  executionOptions: CompareAnytimeExecutionOptions = {},
) {
  const concurrency = executionOptions.concurrency ?? 4
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw Error("Comparison concurrency must be an integer from 1 to 4")
  const frozen = await createFrozenComparisonWorkspace(
    resolve(import.meta.dir, ".."),
  )
  const loaded = await loadAnytimeComparisonSamples()
  await frozen.assertUnchanged()
  const scratchDirectory = join(frozen.directory, "comparison-run")
  const baselineDirectory = join(scratchDirectory, "baselines")
  const diagnosticDirectory = join(scratchDirectory, "checkpoints")
  const resultDirectory = join(scratchDirectory, "results")
  const jobDirectory = join(scratchDirectory, "jobs")
  const stagedDirectory = join(scratchDirectory, "validated-artifacts")
  for (const path of [
    baselineDirectory,
    diagnosticDirectory,
    resultDirectory,
    jobDirectory,
  ])
    await mkdir(path, { recursive: true })
  const jobs: ComparisonSampleJob[] = []
  for (const sample of loaded) {
    const inputSha256 = am3352Hash(sample.input)
    let seedSha256: string | null = null
    if (reuseBaselines) {
      const file = Bun.file(
        join("/tmp/bus-lanes-anytime-baselines", `${sample.id}.json`),
      )
      if (!(await file.exists()))
        throw Error(`${sample.id}: missing pristine baseline`)
      const cached = (await file.json()) as CachedBaseline
      if (cached.inputSha256 !== inputSha256)
        throw Error(
          `${sample.id}: pristine baseline input differs from frozen input`,
        )
      seedSha256 = am3352Hash(cached.traces)
      await Bun.write(
        join(baselineDirectory, `${sample.id}.json`),
        JSON.stringify(cached),
      )
    }
    jobs.push({
      sample,
      inputSha256,
      seedSha256,
      iterationsPerX,
      reuseBaselines,
      physicalOptions,
      baselineDirectory,
      diagnosticDirectory,
      resultFile: join(resultDirectory, `${sample.id}.json.gz`),
      sourceFingerprint: frozen.sourceFingerprint,
    })
  }
  const active = new Set<ReturnType<typeof Bun.spawn>>()
  let aborted = false
  const runChild = async (
    flag: "--sample-job" | "--render-job",
    job: ComparisonSampleJob | ComparisonRenderJob,
    index: number,
  ) => {
    const file = join(jobDirectory, `${flag.slice(2)}-${index}.json`)
    await Bun.write(file, JSON.stringify(job))
    if (aborted) throw Error("Comparison worker launch canceled")
    const child = Bun.spawn(
      [
        process.execPath,
        join(frozen.directory, "scripts/compare-anytime.ts"),
        flag,
        file,
      ],
      {
        cwd: frozen.directory,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    active.add(child)
    try {
      const exitCode = await child.exited
      if (exitCode !== 0)
        throw Error(
          `Comparison ${flag} ${index} failed with exit code ${exitCode}`,
        )
    } finally {
      active.delete(child)
    }
  }
  try {
    await runComparisonJobs(jobs, concurrency, (job, index) =>
      runChild("--sample-job", job, index),
    )
    await frozen.assertUnchanged()
    const results = await Promise.all(
      jobs.map((job) => readComparisonSampleResult(job.resultFile)),
    )
    const report: AnytimeComparisonReport = {
      generatedAt: new Date().toISOString(),
      iterationsPerX,
      concurrency,
      sourceFingerprint: frozen.sourceFingerprint,
      baselineSeeds: jobs.map((job) => ({
        sampleId: job.sample.id,
        inputSha256: job.inputSha256,
        seedSha256: job.seedSha256,
      })),
      samples: results.map((result) => result.comparison),
    }
    if (
      report.samples.length !== loaded.length ||
      loaded.length !== 14 ||
      new Set(report.samples.map((sample) => sample.id)).size !==
        loaded.length ||
      results.some(
        (result, i) =>
          result.sourceFingerprint.sha256 !== frozen.sourceFingerprint.sha256 ||
          result.inputSha256 !== jobs[i].inputSha256 ||
          result.seedSha256 !== jobs[i].seedSha256 ||
          result.comparison.id !== jobs[i].sample.id ||
          result.comparison.checkpoints.length !== efforts.length ||
          efforts.some(
            (e) =>
              result.comparison.checkpoints.filter(
                (c) => c.effort === e && c.valid && c.status === "valid",
              ).length !== 1,
          ),
      )
    )
      throw Error(
        "All 14 samples and 42 native checkpoint gates must pass before artifact generation",
      )
    // Data and images are staged only after every native checkpoint succeeds.
    const nativeManifestFile = join(scratchDirectory, "native-checkpoints.json")
    await Bun.write(
      nativeManifestFile,
      JSON.stringify({
        sourceFingerprint: frozen.sourceFingerprint.sha256,
        samples: report.samples.map((sample) => ({
          id: sample.id,
          checkpoints: sample.checkpoints.map((checkpoint) => ({
            effort: checkpoint.effort,
            valid: checkpoint.valid,
            outputSha256: am3352Hash(checkpoint.output),
            validationSha256: am3352Hash(checkpoint.validation),
          })),
        })),
      }),
    )
    const { createAnytimeComparisonHtml } = await import(
      pathToFileURL(join(frozen.directory, "scripts/anytime-report.ts")).href
    )
    await saveValidatedComparisonData(
      report,
      stagedDirectory,
      createAnytimeComparisonHtml(report),
    )
    console.log(
      `Validated report staged at ${join(stagedDirectory, "index.html")}; exporting successful snapshots.`,
    )
    const am3352Files = jobs
      .filter((job) => job.sample.family === "AM3352")
      .map((job) => job.resultFile)
    const renderJobs: ComparisonRenderJob[] = [
      ...efforts.map((effort) => ({
        kind: "am3352" as const,
        effort,
        sampleResultFiles: am3352Files,
        directory: join(stagedDirectory, `am3352-${effort}x`),
        sourceFingerprint: frozen.sourceFingerprint,
        nativeManifestFile,
      })),
      ...jobs
        .filter((job) => job.sample.family !== "AM3352")
        .map((job) => ({
          kind: "other" as const,
          sampleResultFiles: [job.resultFile],
          directory: stagedDirectory,
          sourceFingerprint: frozen.sourceFingerprint,
          nativeManifestFile,
        })),
    ]
    await runComparisonJobs(renderJobs, concurrency, (job, index) =>
      runChild("--render-job", job, index),
    )
    await frozen.assertUnchanged()
    if (executionOptions.publish === false) {
      console.log(
        `Comparison staged for image inspection: ${stagedDirectory} (14 samples × ${iterationsPerX}/${iterationsPerX * 2}/${iterationsPerX * 5} steps; source ${frozen.sourceFingerprint.sha256})`,
      )
      return report
    }
    await mkdir(directory, { recursive: true })
    await cp(stagedDirectory, directory, { recursive: true, force: true })
    // Browser screenshots must be refreshed from this generation's report.
    for (const name of ["comparison.png", "meander-detail.png"])
      await rm(join(directory, name), { force: true })
    console.log(
      `Comparison saved: ${join(directory, "index.html")} (14 samples × 3 fully validated checkpoints; source ${frozen.sourceFingerprint.sha256})`,
    )
    return report
  } catch (error) {
    aborted = true
    for (const child of active) child.kill()
    await Promise.allSettled([...active].map((child) => child.exited))
    throw error
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === "--sample-job") {
    await runAnytimeComparisonSample(await Bun.file(args[1]).json())
  } else if (args[0] === "--render-job") {
    await runComparisonRenderJob(await Bun.file(args[1]).json())
  } else {
    const positional: string[] = []
    let reuseBaselines = false,
      physical = true,
      pitchMm = 0.1,
      concurrency = 4,
      publish = true
    for (let i = 0; i < args.length; i++) {
      const argument = args[i]
      if (argument === "--reuse-baselines") reuseBaselines = true
      else if (argument === "--stage-only") publish = false
      else if (argument === "--no-physical") physical = false
      else if (argument === "--pitch") pitchMm = Number(args[++i])
      else if (argument === "--concurrency") concurrency = Number(args[++i])
      else if (argument.startsWith("--"))
        throw Error(`Unknown comparison flag: ${argument}`)
      else positional.push(argument)
    }
    const iterationsPerX = Number(positional[1] ?? 512)
    if (
      positional.length > 2 ||
      !Number.isSafeInteger(iterationsPerX) ||
      iterationsPerX < 1 ||
      !Number.isFinite(pitchMm) ||
      pitchMm <= 0 ||
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 4
    )
      throw Error(
        "Usage: bun scripts/compare-anytime.ts [directory] [iterations-per-x] [--reuse-baselines] [--no-physical] [--pitch .1] [--concurrency 1..4] [--stage-only]",
      )
    await compareAnytime(
      positional[0] ? resolve(positional[0]) : undefined,
      iterationsPerX,
      reuseBaselines,
      { enabled: physical, pitchMm },
      { concurrency, publish },
    )
  }
}
