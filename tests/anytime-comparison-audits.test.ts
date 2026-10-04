import { beforeAll, expect, test } from "bun:test"
import type { SimpleRouteJson, Trace } from "../lib"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { am3352Hash } from "../scripts/am3352-samples"
import type {
  AnytimeComparisonCheckpoint,
  AnytimeComparisonReport,
  AnytimeComparisonSample,
} from "../scripts/anytime-report"
import {
  assertAnytimeComparisonAudits,
  assertAnytimeComparisonPrefix,
  validateAnytimeComparisonCheckpoint,
} from "../scripts/compare-anytime"
import {
  createAnytimePhysicalProbe,
  measureAnytimePhysicalMetrics,
} from "../scripts/anytime-physical-metrics"

const input: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  bounds: { minX: -1, maxX: 5, minY: -1, maxY: 3 },
  obstacles: [],
  connections: [
    {
      name: "D",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top" },
        { x: 4, y: 0, layer: "top" },
      ],
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed-local-escape",
      connection_name: "D",
      route: [4, 4.5].map((x) => ({
        route_type: "wire",
        x,
        y: 0,
        layer: "top",
        width: 0.1,
      })),
    },
  ],
}
const carrier = (points: Array<[number, number]>): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: "new-interconnect",
  connection_name: "D",
  route: points.map(([x, y]) => ({
    route_type: "wire",
    x,
    y,
    layer: "top",
    width: 0.1,
  })),
})
const straight = carrier([
  [0, 0],
  [2, 0],
  [4, 0],
])
const loaded = {
  id: "native-audit-fixture",
  title: "Native audit fixture",
  family: "channel" as const,
  input,
}
const physicalProbe = createAnytimePhysicalProbe(input, [straight])
let sample: AnytimeComparisonSample

async function independentlyAuditedCheckpoint(
  effort: AnytimeComparisonCheckpoint["effort"],
  trace: Trace,
): Promise<AnytimeComparisonCheckpoint> {
  const output = {
    ...structuredClone(input),
    traces: [...input.traces!, trace],
  }
  const started = performance.now()
  const validation = await validateAnytimeComparisonCheckpoint(
    loaded,
    [trace],
    output,
  )
  const validationMilliseconds = performance.now() - started
  return {
    effort,
    solveMilliseconds: 0,
    totalMilliseconds: validationMilliseconds,
    optimizationIterations: effort * 8,
    iterations: effort * 8,
    status: "valid",
    valid: true,
    validation,
    validationMilliseconds,
    cumulativeValidationMilliseconds: validationMilliseconds,
    validationInputSha256: am3352Hash(input),
    validationOutputSha256: am3352Hash(output),
    validationTraceSha256: am3352Hash([trace]),
    physical: measureAnytimePhysicalMetrics(input, [trace], physicalProbe),
    score: {
      objective: 1,
      envelopeAreaMm2: 1,
      skewPenalty: 0,
      totalLengthMm: 4.5,
      busLengths: busLengthReports(input, [trace]),
      pairLengths: pairLengthReports(input, [trace]),
    },
    output,
  }
}

beforeAll(async () => {
  const first = await independentlyAuditedCheckpoint(1, straight)
  sample = {
    ...loaded,
    bounds: input.bounds,
    checkpoints: [
      first,
      ...([2, 5, 10] as const).map((effort) => ({
        ...structuredClone(first),
        effort,
        optimizationIterations: effort * 8,
        iterations: effort * 8,
        validationMilliseconds: 0,
        validationReusedFromEffort: 1 as const,
        physicalReusedFromEffort: 1 as const,
      })),
    ],
  }
})

test("byte-identical completed copper can reuse an earlier original native audit", async () => {
  expect(() => assertAnytimeComparisonAudits(sample)).not.toThrow()
  const fresh = await independentlyAuditedCheckpoint(10, straight)
  expect(fresh.validation).toEqual(sample.checkpoints[3].validation)
  expect(fresh.physical).toEqual(sample.checkpoints[3].physical)
})

test("changed legal copper requires its own native audit before reporting", async () => {
  const changed = structuredClone(sample)
  const detour = carrier([
    [0, 0],
    [1, 1],
    [3, 1],
    [4, 0],
  ])
  changed.checkpoints[3] = await independentlyAuditedCheckpoint(10, detour)
  expect(() => assertAnytimeComparisonAudits(changed)).not.toThrow()
  changed.checkpoints[3].validationReusedFromEffort = 1
  expect(() => assertAnytimeComparisonAudits(changed)).toThrow(
    "invalid native audit reuse",
  )
})

test.each([
  [
    "routed endpoint",
    (s: AnytimeComparisonSample) => {
      s.checkpoints[3].output.traces!.at(-1)!.route[0].x += 0.001
    },
  ],
  [
    "immutable input",
    (s: AnytimeComparisonSample) => {
      s.input.minTraceWidth += 0.001
    },
  ],
  [
    "failed verdict",
    (s: AnytimeComparisonSample) => {
      ;(s.checkpoints[3].validation as { valid: boolean }).valid = false
    },
  ],
  [
    "future audit",
    (s: AnytimeComparisonSample) => {
      s.checkpoints[0].validationReusedFromEffort = 10
    },
  ],
  [
    "cached physical area",
    (s: AnytimeComparisonSample) => {
      s.checkpoints[3].physical!.freeAreaMm2 += 1
    },
  ],
  [
    "missing 10x",
    (s: AnytimeComparisonSample) => {
      s.checkpoints.pop()
    },
  ],
] as const)("artifact audit rejects a forged %s", (_label, mutate) => {
  const changed = structuredClone(sample)
  mutate(changed)
  expect(() => assertAnytimeComparisonAudits(changed)).toThrow()
  expect(() => assertAnytimeComparisonAudits(sample)).not.toThrow()
})

const report = (): AnytimeComparisonReport => ({
  generatedAt: "test-fixture",
  iterationsPerX: 8,
  samples: [structuredClone(sample)],
})
const reference = () => ({
  iterationsPerX: 8,
  samples: [
    {
      id: sample.id,
      checkpoints: sample.checkpoints.slice(0, 3).map((c) => ({
        effort: c.effort,
        valid: c.valid,
        outputSha256: am3352Hash(c.output),
      })),
    },
  ],
})

test("10x export preserves all previously measured routed prefixes", () => {
  expect(assertAnytimeComparisonPrefix(report(), reference())).toBe(3)
  const changed = report()
  changed.samples[0].checkpoints[2].output.traces!.at(-1)!.route[0].x += 0.001
  expect(() => assertAnytimeComparisonPrefix(changed, reference())).toThrow(
    "output changed from the measured prefix",
  )
})

test("prefix comparison rejects different budgets and incomplete native references", () => {
  expect(() =>
    assertAnytimeComparisonPrefix(
      { ...report(), iterationsPerX: 9 },
      reference(),
    ),
  ).toThrow("same samples and base budget")
  const duplicate = reference()
  duplicate.samples[0].checkpoints.push(duplicate.samples[0].checkpoints[0])
  expect(() => assertAnytimeComparisonPrefix(report(), duplicate)).toThrow()
  const failed = reference()
  failed.samples[0].checkpoints[0].valid = false
  expect(() => assertAnytimeComparisonPrefix(report(), failed)).toThrow()
})
