import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  AnytimeBusLanesSolver,
  type AnytimeBusLanesOptions,
  type AnytimeResult,
} from "../lib/anytime-bus-lanes-solver"
import { separateAnytimeCarriers } from "../lib/anytime-carriers"
import { scoreAnytimeRoutes } from "../lib/anytime-score"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { distance } from "../lib/geometry"
import { fixedRouteLength } from "../lib/route-lengths"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import type { SimpleRouteJson, Trace } from "../lib/types"
import { am3352Hash } from "./am3352-samples"
import {
  loadAnytimeComparisonSamples,
  validateAnytimeComparisonCheckpoint,
} from "./compare-anytime"
import {
  createAnytimePhysicalProbe,
  measureAnytimePhysicalMetrics,
  type AnytimePhysicalMetrics,
} from "./anytime-physical-metrics"

type Sample = Awaited<ReturnType<typeof loadAnytimeComparisonSamples>>[number]
interface CachedBaseline {
  inputSha256: string
  traces: Trace[]
  routingMilliseconds: number
}

/** These are development diagnostics; iteration-zero captures stay in /tmp. */
export interface AnytimeExperimentOptions {
  sampleIds?: string[]
  iterationsPerX?: number
  baselineDirectory?: string
  nativeSeedDirectory?: string
  resultDirectory?: string
  pitchMm?: number
  /** Full native checkpoint audit after this relative physical change. */
  nativeCheckpointThreshold?: number
  dramaticThreshold?: number
  solverOptions?: Omit<AnytimeBusLanesOptions, "effort" | "iterationsPerX">
  solverFactory?: (
    input: SimpleRouteJson,
    seed: Trace[],
    options: AnytimeBusLanesOptions,
  ) => Pick<
    AnytimeBusLanesSolver,
    "solve" | "improve" | "getResult" | "traces"
  > & {
    readonly stats?: unknown
  }
}

const reduction = (before: number, after: number) =>
  before > 0 ? (before - after) / before : 0

/** An optimistic floor, not a promise of routability. Obstacles can raise it.
 * Closing bus/pair bounds accounts for unavoidable matched-length padding. */
export function anytimeExperimentLengthFloor(input: SimpleRouteJson) {
  const floors = new Map(
    input.connections.map((c) => {
      let value = fixedRouteLength(input, c.name)
      for (let i = 1; i < c.pointsToConnect.length; i++)
        value += distance(c.pointsToConnect[i - 1], c.pointsToConnect[i])
      return [c.name, value] as const
    }),
  )
  const groups = [
    ...(input.buses ?? []).map((b) => ({
      connectionNames: b.connectionNames,
      toleranceMm: b.maxLengthSkew,
    })),
    ...(input.differentialPairs ?? []).map((p) => ({
      connectionNames: p.connectionNames,
      toleranceMm: p.lengthTolerance,
    })),
  ]
  for (let pass = 0; pass < input.connections.length; pass++) {
    let changed = false
    for (const group of groups) {
      if (group.toleranceMm === undefined) continue
      const floor =
        Math.max(...group.connectionNames.map((n) => floors.get(n) ?? 0)) -
        group.toleranceMm
      for (const name of group.connectionNames)
        if (floor > (floors.get(name) ?? 0)) {
          floors.set(name, floor)
          changed = true
        }
    }
    if (!changed) break
  }
  return {
    totalLengthMm: [...floors.values()].reduce((a, b) => a + b, 0),
    byConnection: Object.fromEntries(floors),
    note: "Straight-distance plus fixed-fanout and matching floor; obstacles and coupling can tighten it.",
  }
}

/** Fast original strict carrier audit against the entire valid incumbent.
 * Also available to standalone development candidate generators. This helper
 * covers carrier topology changes; changed local escapes need a full audit. */
export function validateAnytimeExperimentCandidate(
  input: SimpleRouteJson,
  incumbent: Trace[],
  candidate: Trace[],
) {
  if (
    candidate.length !== input.connections.length ||
    input.connections.some((c) => {
      const matches = candidate.filter((t) => t.connection_name === c.name)
      const route = matches[0]?.route
      return (
        matches.length !== 1 ||
        !route ||
        route.length < 2 ||
        route[0].route_type !== "wire" ||
        route.at(-1)!.route_type !== "wire" ||
        !(c.pointsToConnect[0].layers ?? [c.pointsToConnect[0].layer]).includes(
          (route[0] as Extract<Trace["route"][number], { route_type: "wire" }>)
            .layer,
        ) ||
        !(
          c.pointsToConnect.at(-1)!.layers ?? [c.pointsToConnect.at(-1)!.layer]
        ).includes(
          (
            route.at(-1)! as Extract<
              Trace["route"][number],
              { route_type: "wire" }
            >
          ).layer,
        ) ||
        distance(route[0], c.pointsToConnect[0]) > 1e-8 ||
        distance(route.at(-1)!, c.pointsToConnect.at(-1)!) > 1e-8
      )
    })
  )
    throw Error("Candidate changed original connectivity")
  const changed = new Set(
    candidate
      .filter((t, i) => am3352Hash(t) !== am3352Hash(incumbent[i]))
      .map((t) => t.connection_name!),
  )
  if (!changed.size) return { valid: true, changedConnections: [] as string[] }
  if (!routeAnglesAreConventional(candidate))
    throw Error("Candidate has a nonconventional corner")
  const score = scoreAnytimeRoutes(input, candidate)
  if (
    [...score.busLengths, ...score.pairLengths].some(
      (r) => r.toleranceMm !== null && !r.matched,
    ) ||
    exteriorPairSpacingReports(input, candidate).some((r) => !r.matched)
  )
    throw Error("Candidate violates whole-copper matching or pair spacing")
  const oldContext = separateAnytimeCarriers(input, incumbent)
  const context = separateAnytimeCarriers(input, candidate)
  if (am3352Hash(oldContext.input.traces) !== am3352Hash(context.input.traces))
    throw Error(
      "Candidate changed local escapes; complete native audit required",
    )
  for (const pair of context.input.differentialPairs ?? [])
    if (pair.connectionNames.some((n) => changed.has(n)))
      for (const name of pair.connectionNames) changed.add(name)
  const validationInput: SimpleRouteJson = {
    ...context.input,
    traces: [
      ...(context.input.traces ?? []),
      ...context.traces
        .filter((t) => !changed.has(t.connection_name!))
        .map((t) => ({ ...t, source_trace_id: undefined })),
    ],
    connections: context.input.connections
      .filter((c) => changed.has(c.name))
      .map((c) => ({
        ...c,
        nominalTraceWidth:
          context.input.buses?.find((b) => b.connectionNames.includes(c.name))
            ?.traceWidth ??
          c.nominalTraceWidth ??
          c.width ??
          context.input.minTraceWidth,
      })),
    buses: (context.input.buses ?? []).filter((b) =>
      b.connectionNames.every((n) => changed.has(n)),
    ),
    differentialPairs: (context.input.differentialPairs ?? []).filter((p) =>
      p.connectionNames.every((n) => changed.has(n)),
    ),
  }
  const validator = BusLanesSolver.forValidation(
    validationInput,
    context.traces.filter((t) => changed.has(t.connection_name!)),
    { smoothTuning: true },
  )
  validator.solve()
  if (!validator.solved || validator.failed)
    throw Error(`Original strict carrier audit failed: ${validator.error}`)
  return { valid: true, changedConnections: [...changed] }
}

function physicalChange(a: AnytimePhysicalMetrics, b: AnytimePhysicalMetrics) {
  const clearanceFootprintReduction = b.outsideProbeCopper
    ? 0
    : reduction(a.candidateAddedBlockedAreaMm2, b.candidateAddedBlockedAreaMm2)
  return {
    outerEnvelopeReduction: reduction(
      a.carrierEnvelopeAreaMm2,
      b.carrierEnvelopeAreaMm2,
    ),
    layerEnvelopeReduction: reduction(
      a.layerEnvelopeAreaMm2,
      b.layerEnvelopeAreaMm2,
    ),
    signalLengthReduction: reduction(
      a.signalPlanarLengthMm,
      b.signalPlanarLengthMm,
    ),
    clearanceFootprintReduction,
    addedUsableAreaMm2: b.freeAreaMm2 - a.freeAreaMm2,
    outsideProbeCopper: b.outsideProbeCopper,
  }
}

async function nativeSeedKey(sample: Sample, traces: Trace[]) {
  const sources = await Promise.all(
    [
      "./compare-anytime.ts",
      "./validate-am3352-sample.ts",
      "./validate-two-fanout-sample.ts",
      "../lib/bus-lanes-solver.ts",
      "../lib/route-lengths.ts",
      "../lib/exterior-pair-spacing.ts",
    ].map((name) => Bun.file(new URL(name, import.meta.url)).text()),
  )
  return am3352Hash({
    input: sample.input,
    traces,
    metadata: sample.am3352 ?? sample.ddr,
    validators: sources,
  })
}

async function experimentSourceFingerprint() {
  const names = [
    "../lib/anytime-bus-lanes-solver.ts",
    "../lib/anytime-score.ts",
    "../lib/anytime-clearance-footprint.ts",
    "../lib/anytime-carriers.ts",
    "../lib/anytime-skeleton.ts",
    "../lib/anytime-strip-collapse.ts",
    "../lib/anytime-topology-search.ts",
    "../lib/anytime-transaction-search.ts",
    "../lib/anytime-strip-collapse.ts",
    "../lib/anytime-joint-tuning.ts",
    "../lib/anytime-pair-topology.ts",
    "./anytime-physical-metrics.ts",
    "./experiment-anytime.ts",
  ]
  const sources = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        am3352Hash(await Bun.file(new URL(name, import.meta.url)).text()),
      ]),
    ),
  )
  return { sha256: am3352Hash(sources), files: sources }
}

/** Reuse only an exact, successful native 0x audit. Current solver factories
 * still perform their own seed checks; cached independent audits save repeats. */
export async function cacheAnytimeExperimentNativeSeeds(
  reportFile: string,
  directory = "/tmp/bus-lanes-anytime-native-baselines",
) {
  const report = await Bun.file(reportFile).json()
  const samples = await loadAnytimeComparisonSamples()
  await mkdir(directory, { recursive: true })
  let count = 0
  for (const row of report.samples) {
    const sample = samples.find((s) => s.id === row.id)
    const seed = row.checkpoints.find((c: { effort: number }) => c.effort === 0)
    if (
      !sample ||
      seed?.native?.status !== "passed" ||
      row.inputSha256 !== am3352Hash(sample.input)
    )
      continue
    const output = JSON.parse(
      new TextDecoder().decode(
        Bun.gunzipSync(
          new Uint8Array(
            await Bun.file(
              join(resolve(reportFile, ".."), seed.outputFile),
            ).arrayBuffer(),
          ),
        ),
      ),
    ) as SimpleRouteJson
    const traces = output.traces!.slice(sample.input.traces?.length ?? 0)
    if (
      am3352Hash(traces) !== row.pristineSeedSha256 ||
      am3352Hash(traces) !== seed.traceHash
    )
      throw Error(`${row.id}: native seed hash mismatch`)
    const key = await nativeSeedKey(sample, traces)
    await Bun.write(
      join(directory, `${sample.id}.json`),
      JSON.stringify({ key, validation: seed.native.validation }),
    )
    count++
  }
  return count
}

export async function listAnytimeExperimentSeeds(
  baselineDirectory = "/tmp/bus-lanes-anytime-baselines",
) {
  const samples = await loadAnytimeComparisonSamples()
  const drivers = []
  for (const sample of samples) {
    const cached = (await Bun.file(
      join(baselineDirectory, `${sample.id}.json`),
    ).json()) as CachedBaseline
    if (cached.inputSha256 !== am3352Hash(sample.input))
      throw Error(`${sample.id}: pristine input differs from cached baseline`)
    const score = scoreAnytimeRoutes(sample.input, cached.traces)
    const floor = anytimeExperimentLengthFloor(sample.input)
    drivers.push({
      sampleId: sample.id,
      inputSha256: cached.inputSha256,
      seedSha256: am3352Hash(cached.traces),
      baselineLengthMm: score.totalLengthMm,
      matchedLengthFloorMm: floor.totalLengthMm,
      optimisticLengthHeadroom: reduction(
        score.totalLengthMm,
        floor.totalLengthMm,
      ),
      baselineOuterEnvelopeMm2: score.envelopeAreaMm2,
      baselineLayerEnvelopesMm2: score.layerEnvelopeAreaMm2,
      baselineRoutePoints: cached.traces.reduce(
        (n, t) => n + t.route.length,
        0,
      ),
    })
  }
  return drivers
}

/** No rerouting of the original seeds. Each selected sample uses one genuine
 * sequence, and both 0x→5x and 1x→5x gains are reported without weakening 1x. */
export async function runAnytimeExperiment(
  options: AnytimeExperimentOptions = {},
) {
  const directory = resolve(
    options.resultDirectory ?? "/tmp/bus-lanes-topology-experiment",
  )
  if (!directory.startsWith("/tmp/"))
    throw Error("Development/0x diagnostics must remain local under /tmp")
  const perX = options.iterationsPerX ?? 512
  if (!Number.isInteger(perX) || perX < 1)
    throw Error("iterationsPerX must be a positive integer")
  const requested = new Set(options.sampleIds)
  const allSamples = await loadAnytimeComparisonSamples()
  const samples = allSamples.filter(
    (s) => !requested.size || requested.has(s.id),
  )
  for (const id of requested)
    if (!samples.some((s) => s.id === id)) throw Error(`Unknown sample ${id}`)
  const factory = options.solverFactory ?? AnytimeBusLanesSolver.fromCompleted
  const report = {
    createdAt: new Date().toISOString(),
    sourceFingerprint: await experimentSourceFingerprint(),
    iterationsPerX: perX,
    dramaticThreshold: options.dramaticThreshold ?? 0.2,
    nativeCheckpointThreshold: options.nativeCheckpointThreshold ?? 0.005,
    definitions: {
      efforts:
        "0x is the pristine completed route; 1x, 2x, 5x continue one identical search sequence.",
      dramatic:
        "At least 20% signal length, carrier clearance-exclusion footprint, or physical outer envelope reduction; layer-envelope reduction qualifies with at least 10% clearance-footprint reduction. Weighted objective alone never qualifies.",
      clearance:
        "Conservative wholly-free-cell raster on one frozen ROI, probe width and pitch for every effort; fixed copper/obstacles retained. Outside-ROI geometry disqualifies free-space gains.",
      native:
        "Full independent native checkpoint audits follow meaningful physical changes; unchanged geometry reuses its audit. A strict-only checkpoint is development evidence, not a publication artifact.",
    },
    samples: [] as Array<Record<string, unknown>>,
  }
  await mkdir(join(directory, "outputs"), { recursive: true })
  for (const sample of samples) {
    const inputHash = am3352Hash(sample.input)
    const cache = (await Bun.file(
      join(
        options.baselineDirectory ?? "/tmp/bus-lanes-anytime-baselines",
        `${sample.id}.json`,
      ),
    ).json()) as CachedBaseline
    if (cache.inputSha256 !== inputHash)
      throw Error(`${sample.id}: cached baseline input hash mismatch`)
    const beforeFactory = performance.now()
    const solver = factory(sample.input, structuredClone(cache.traces), {
      ...options.solverOptions,
      effort: 1,
      iterationsPerX: perX,
      fanout: options.solverOptions?.fanout ?? "none",
    })
    const seedValidationMilliseconds = performance.now() - beforeFactory
    if (solver.getResult().optimizationIterations !== 0)
      throw Error(`${sample.id}: solver factory spent effort before 0x capture`)
    const probe = createAnytimePhysicalProbe(sample.input, cache.traces, {
      pitchMm: options.pitchMm ?? 0.1,
    })
    const nativeDirectory =
      options.nativeSeedDirectory ?? "/tmp/bus-lanes-anytime-native-baselines"
    const seedAuditKey = await nativeSeedKey(sample, cache.traces)
    const seedAuditFile = join(nativeDirectory, `${sample.id}.json`)
    const savedSeedAudit = (await Bun.file(seedAuditFile).exists())
      ? await Bun.file(seedAuditFile).json()
      : undefined
    const checkpoints = []
    let lastStrict = cache.traces
    let lastNative:
      | { traceHash: string; physical: AnytimePhysicalMetrics; effort: number }
      | undefined
    let priorObjective = Infinity
    let optimizationMilliseconds = 0
    for (const effort of [0, 1, 2, 5] as const) {
      const started = performance.now()
      const result: AnytimeResult =
        effort === 0
          ? solver.getResult()
          : effort === 1
            ? solver.solve()
            : solver.improve(effort)
      if (effort > 0) optimizationMilliseconds += performance.now() - started
      const traces = solver.traces
      if (
        result.status !== "valid" ||
        result.score.objective > priorObjective + 1e-10 ||
        am3352Hash(sample.input) !== inputHash ||
        am3352Hash(
          result.output.traces?.slice(0, sample.input.traces?.length ?? 0),
        ) !== am3352Hash(sample.input.traces ?? [])
      )
        throw Error(
          `${sample.id}/${effort}x: lost validity, monotonicity, or immutable input`,
        )
      priorObjective = result.score.objective
      const strictStart = performance.now()
      const strict = validateAnytimeExperimentCandidate(
        sample.input,
        lastStrict,
        traces,
      )
      const strictMilliseconds = performance.now() - strictStart
      lastStrict = traces
      const metricStart = performance.now()
      const physical = measureAnytimePhysicalMetrics(
        sample.input,
        traces,
        probe,
      )
      const measurementMilliseconds = performance.now() - metricStart
      const traceHash = am3352Hash(traces)
      const change = lastNative
        ? physicalChange(lastNative.physical, physical)
        : undefined
      const meaningful =
        !lastNative ||
        (change &&
          Math.max(
            change.outerEnvelopeReduction,
            change.layerEnvelopeReduction,
            change.signalLengthReduction,
            change.clearanceFootprintReduction,
          ) >= report.nativeCheckpointThreshold)
      let native: unknown
      let nativeMilliseconds = 0
      if (lastNative?.traceHash === traceHash) {
        native = { status: "same_geometry", auditedEffort: lastNative.effort }
      } else if (effort === 0 && savedSeedAudit?.key === seedAuditKey) {
        native = {
          status: "cached_seed",
          validation: savedSeedAudit.validation,
        }
        lastNative = { traceHash, physical, effort }
      } else if (meaningful) {
        const nativeStart = performance.now()
        const validation = await validateAnytimeComparisonCheckpoint(
          sample,
          traces,
          result.output,
        )
        nativeMilliseconds = performance.now() - nativeStart
        native = { status: "passed", validation }
        lastNative = { traceHash, physical, effort }
        if (effort === 0) {
          await mkdir(nativeDirectory, { recursive: true })
          await Bun.write(
            seedAuditFile,
            JSON.stringify({ key: seedAuditKey, validation }),
          )
        }
      } else
        native = {
          status: "strict_only",
          reason: "Physical change below native checkpoint threshold",
        }
      const outputFile = `outputs/${sample.id}-${effort}x.json.gz`
      await Bun.write(
        join(directory, outputFile),
        Bun.gzipSync(JSON.stringify(result.output), { level: 9 }),
      )
      checkpoints.push({
        effort,
        traceHash,
        outputFile,
        score: result.score,
        physical,
        optimizationIterations: result.optimizationIterations,
        acceptedImprovements: result.acceptedImprovements,
        diagnostics: solver.stats,
        optimizationMilliseconds,
        strict,
        strictMilliseconds,
        native,
        nativeMilliseconds,
        measurementMilliseconds,
      })
      console.log(
        `${sample.id} ${effort}x: attempts=${result.optimizationIterations}, accepted=${result.acceptedImprovements}, length=${physical.signalPlanarLengthMm.toFixed(3)}mm, carrier-exclusion=${physical.candidateAddedBlockedAreaMm2.toFixed(3)}mm², native=${(native as { status: string }).status}`,
      )
    }
    const seed = checkpoints[0].physical,
      one = checkpoints[1].physical,
      five = checkpoints[3].physical
    const seedToFive = physicalChange(seed, five),
      oneToFive = physicalChange(one, five)
    const qualifies = (d: ReturnType<typeof physicalChange>) =>
      d.signalLengthReduction >= report.dramaticThreshold ||
      d.clearanceFootprintReduction >= report.dramaticThreshold ||
      (d.outerEnvelopeReduction >= report.dramaticThreshold &&
        d.clearanceFootprintReduction > 0) ||
      (d.layerEnvelopeReduction >= report.dramaticThreshold &&
        d.clearanceFootprintReduction >= 0.1)
    report.samples.push({
      id: sample.id,
      family: sample.family,
      inputSha256: inputHash,
      pristineSeedSha256: am3352Hash(cache.traces),
      originalRoutingMilliseconds: cache.routingMilliseconds,
      seedValidationMilliseconds,
      probe: {
        roi: probe.roi,
        pitchMm: probe.pitchMm,
        layers: probe.layers,
        clearanceMm: probe.clearanceMm,
        probeTraceWidthMm: probe.probeTraceWidthMm,
      },
      lengthFloor: anytimeExperimentLengthFloor(sample.input),
      checkpoints,
      seedToFive,
      oneToFive,
      dramaticSeedToFive: qualifies(seedToFive),
      dramaticOneToFive: qualifies(oneToFive),
    })
    await Bun.write(
      join(directory, "measurements.json"),
      JSON.stringify(report, null, 2) + "\n",
    )
  }
  const finalSource = await experimentSourceFingerprint()
  Object.assign(report, {
    sourceChangedDuringRun:
      finalSource.sha256 !== report.sourceFingerprint.sha256,
    finalSourceFingerprint: finalSource,
  })
  await Bun.write(
    join(directory, "measurements.json"),
    JSON.stringify(report, null, 2) + "\n",
  )
  return report
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  const value = (name: string) => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args[i + 1]
  }
  if (!args.includes("--run")) {
    console.log(
      JSON.stringify(
        await listAnytimeExperimentSeeds(value("--baselines")),
        null,
        2,
      ),
    )
    console.log(
      "No optimization run. Use --run after optimizer readiness is confirmed; --samples id,id --iterations-per-x 512 --pitch .1 --output /tmp/path.",
    )
  } else {
    const adapter = value("--adapter")
    const solverFactory = adapter
      ? (await import(resolve(adapter))).createAnytimeExperimentSolver
      : undefined
    await runAnytimeExperiment({
      sampleIds: value("--samples")?.split(","),
      iterationsPerX: Number(value("--iterations-per-x") ?? 512),
      pitchMm: Number(value("--pitch") ?? 0.1),
      baselineDirectory: value("--baselines"),
      resultDirectory: value("--output"),
      solverFactory,
    })
  }
}
