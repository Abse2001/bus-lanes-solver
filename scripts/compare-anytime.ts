import { mkdir, rm, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
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

async function validateCheckpoint(
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

export async function compareAnytime(
  directory = resolve(import.meta.dir, "../docs/anytime"),
  iterationsPerX = 128,
  reuseBaselines = false,
) {
  const loaded = await loadAnytimeComparisonSamples()
  const diagnosticDirectory = "/tmp/bus-lanes-anytime-checkpoints"
  await mkdir(diagnosticDirectory, { recursive: true })
  const baselineDirectory = "/tmp/bus-lanes-anytime-baselines"
  await mkdir(baselineDirectory, { recursive: true })
  const report: AnytimeComparisonReport = {
    generatedAt: new Date().toISOString(),
    iterationsPerX,
    samples: [],
  }
  const candidates = new Map<number, Am3352SnapshotCandidate[]>(
    efforts.map((e) => [e, []]),
  )
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
      const validation = await validateCheckpoint(sample, traces, result.output)
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
      if (sample.am3352)
        candidates.get(effort)!.push({
          metadata: sample.am3352,
          solver: {
            input: sample.input,
            traces,
            solved: true,
            failed: false,
            error: null,
            getOutput: () => ({
              ...checkpoint.output,
              traces: checkpoint.output.traces!,
            }),
          },
        })
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
    })
  }
  // Every checkpoint must validate before rendering any review image. In
  // particular, the native AM3352 exporter requires all eight declared cases.
  const { createAnytimeComparisonHtml } = await import("./anytime-report")
  const html = createAnytimeComparisonHtml(report)
  await mkdir(directory, { recursive: true })
  await mkdir(join(directory, "outputs"), { recursive: true })
  for (const effort of efforts) {
    await exportAm3352RoutedSnapshots(
      candidates.get(effort)!,
      join(directory, `am3352-${effort}x`),
    )
    // Exact vector geometry is embedded in the offline report. Keep one review
    // image per checkpoint rather than duplicating the large SVG exports.
    for (const placement of am3352SamplePlacements)
      await unlink(
        join(directory, `am3352-${effort}x`, `${placement.name}-solved.svg`),
      )
  }
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
      if (sample.family === "AM3352") continue
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
      await rm(
        join(directory, `${sample.id}-${checkpoint.effort}x-solved.svg`),
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
    `Comparison saved: ${join(directory, "index.html")} (${report.samples.length} samples × 3 validated effort checkpoints)`,
  )
  return report
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length > 3 || (args[2] && args[2] !== "--reuse-baselines"))
    throw Error(
      "Usage: bun scripts/compare-anytime.ts [directory] [iterations-per-x] [--reuse-baselines]",
    )
  const iterationsPerX = Number(args[1] ?? 128)
  if (!Number.isSafeInteger(iterationsPerX) || iterationsPerX < 1)
    throw Error("iterations-per-x must be a positive integer")
  await compareAnytime(
    args[0] ? resolve(args[0]) : undefined,
    iterationsPerX,
    args[2] === "--reuse-baselines",
  )
}
