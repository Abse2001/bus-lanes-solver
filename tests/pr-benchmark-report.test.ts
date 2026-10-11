import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  am3352SamplePlacements,
  loadAm3352Sample,
  type Am3352SampleName,
} from "../scripts/am3352-samples"
import {
  SAMPLE_NAMES,
  loadSamplePairs,
  percentile,
  renderComparison,
  summarizeComparison,
  validateSamplePair,
  validateSamplePairs,
  type ComparisonOptions,
  type PairMetadata,
  type SamplePairArtifact,
} from "../scripts/pr-benchmark/report"

const mainSha = "a".repeat(40)
const prSha = "b".repeat(40)
const controllerSha = "c".repeat(40)
const inputSha256 = "d".repeat(64)
const timeoutSeconds = 10
const metadata: PairMetadata = {
  order: ["main", "pr"],
  mainSha,
  prSha,
  controllerSha,
  bunVersion: "1.3.11",
  platform: "linux",
  architecture: "x64",
  runnerName: "paired-runner",
  runnerOS: "Linux",
}

// This is the trusted worker's report schema, with independent solve and wall
// durations and current canonical power-fanout preservation evidence.
function completedReport(sample: string, solveMilliseconds = 100) {
  return {
    sample,
    timeoutSeconds,
    status: "solved",
    solved: true,
    solveMilliseconds,
    milliseconds: solveMilliseconds + 20,
    requestedSignals: 47,
    routedSignals: 47,
    fixedPowerDogbones: 161,
    inputUnchanged: true,
    fixedPowerPreserved: true,
    inputSha256,
    error: null,
    validation: {
      valid: true,
      complete: true,
      matched: true,
      fixedPowerTraces: 161,
      fixedPowerVias: 161,
      fixedPowerPadJoins: 161,
      fixedDrc: { valid: true },
      combinedDrc: { valid: true },
      busLengths: [
        "DDR_BYTE0",
        "DDR_BYTE1",
        ...(sample === "inner-layers-complete-ca" ? ["DDR_ADDR_CTRL_CK"] : []),
      ].map((busId) => ({
        busId,
        matched: true,
        skewMm: 0.01,
        toleranceMm: 0.635,
      })),
      pairLengths: ["pair_0", "pair_1", "pair_2"].map((busId) => ({
        busId,
        matched: true,
        skewMm: 0.002,
        toleranceMm: 0.127,
      })),
    },
  }
}
function pair(sample: string, mainTime = 100, prTime = mainTime) {
  return {
    sample,
    timeoutSeconds,
    main: {
      report: completedReport(sample, mainTime),
      wallMilliseconds: mainTime + 200,
      exitCode: 0,
      error: null,
      timedOut: false,
    },
    pr: {
      report: completedReport(sample, prTime),
      wallMilliseconds: prTime + 300,
      exitCode: 0,
      error: null,
      timedOut: false,
    },
    metadata: { ...metadata },
  }
}
function allPairs() {
  return SAMPLE_NAMES.map((sample, index) => pair(sample, (index + 1) * 100))
}
function options(samples: readonly SamplePairArtifact[]): ComparisonOptions {
  return {
    samples,
    mainSha,
    prSha,
    controllerSha,
    prNumber: 42,
    timeoutSeconds,
    runUrl: "https://github.com/tscircuit/bus-lanes-solver/actions/runs/123",
  }
}

test("the shared canonical manifest contains every AM3352 benchmark sample", () => {
  expect(SAMPLE_NAMES).toEqual(am3352SamplePlacements.map(({ name }) => name))
  expect(SAMPLE_NAMES).toHaveLength(11)
})

test("completion fixtures agree with canonical inputs on signal, bus and differential-pair requirements", async () => {
  for (const sample of SAMPLE_NAMES) {
    const { input } = await loadAm3352Sample(sample as Am3352SampleName)
    const report = completedReport(sample)
    expect(input.connections.length).toBe(report.requestedSignals)
    expect(input.traces?.length).toBe(report.fixedPowerDogbones)
    expect(
      input.buses?.map((bus) => ({
        name: bus.busId,
        tolerance: bus.maxLengthSkew,
      })),
    ).toEqual(
      report.validation.busLengths.map((bus) => ({
        name: bus.busId,
        tolerance: bus.toleranceMm,
      })),
    )
    expect(
      input.differentialPairs?.map((pair, index) => ({
        name: `pair_${index}`,
        tolerance: pair.lengthTolerance,
      })),
    ).toEqual(
      report.validation.pairLengths.map((pair) => ({
        name: pair.busId,
        tolerance: pair.toleranceMm,
      })),
    )
  }
})

test("linear percentile interpolation handles boundaries, unsorted data, and empty sets", () => {
  expect(percentile([], 0.5)).toBeNull()
  expect(percentile([123], 0.95)).toBe(123)
  const values = [40, 10, 30, 20]
  expect(percentile(values, 0)).toBe(10)
  expect(percentile(values, 0.5)).toBe(25)
  expect(percentile(values, 0.8)).toBeCloseTo(34)
  expect(percentile(values, 0.9)).toBeCloseTo(37)
  expect(percentile(values, 0.95)).toBeCloseTo(38.5)
  expect(percentile(values, 1)).toBe(40)
  expect(values).toEqual([40, 10, 30, 20])
  for (const probability of [-0.1, 1.1, NaN, Infinity])
    expect(() => percentile(values, probability)).toThrow()
  for (const value of [-1, NaN, Infinity])
    expect(() => percentile([value], 0.5)).toThrow()
})

test("all accepted samples use solve duration and require the canonical signal counts", () => {
  const summary = summarizeComparison(options(allPairs()))
  expect(summary.main.accepted).toBe(11)
  expect(summary.pr.accepted).toBe(11)
  expect(summary.main.budgeted).toEqual({
    p50: 600,
    p80: 900,
    p90: 1000,
    p95: 1050,
  })
  expect(summary.matched.count).toBe(11)
  expect(summary.matched.main).toEqual(summary.main.budgeted)
  expect(summary.matched.deltaPercent).toEqual({
    p50: 0,
    p80: 0,
    p90: 0,
    p95: 0,
  })
  expect(summary.samples[0].main.wallMilliseconds).toBe(300)
  expect(summary.samples[0].main.solveMilliseconds).toBe(100)
  expect(summary.samples[0].main.busSkews[0].skewMm).toBe(0.01)
  expect(summary.samples[9].pr.accepted).toBeTrue()
})

test("a lost fast completion receives a budget penalty and survivor comparisons use the same cases", () => {
  const samples = allPairs()
  for (const sample of samples)
    sample.pr.report.solveMilliseconds =
      sample.main.report.solveMilliseconds / 2
  samples[0].pr.report.validation.complete = false
  const summary = summarizeComparison(options(samples))
  expect(summary.lost).toEqual(["control"])
  expect(summary.gained).toEqual([])
  expect(summary.pr.accepted).toBe(10)
  expect(summary.pr.failures).toBe(1)
  expect(summary.samples[0].pr.budgetedMilliseconds).toBe(10000)
  expect(summary.pr.budgeted.p95).toBe(5275)
  expect(summary.matched.count).toBe(10)
  expect(summary.matched.main.p50).toBe(650)
  expect(summary.matched.pr.p50).toBe(325)
  expect(summary.matched.deltaPercent.p50).toBe(-50)
  expect(summary.samples[0].pr.busSkews).toEqual([])
})

test("completion requires every trusted validation and fixed-power preservation check", () => {
  const mutations: Array<(report: ReturnType<typeof completedReport>) => void> =
    [
      (r) => {
        r.status = "failed"
      },
      (r) => {
        r.solved = false
      },
      (r) => {
        r.validation.valid = false
      },
      (r) => {
        r.validation.complete = false
      },
      (r) => {
        r.validation.matched = false
      },
      (r) => {
        r.validation.fixedDrc.valid = false
      },
      (r) => {
        r.validation.combinedDrc.valid = false
      },
      (r) => {
        r.inputUnchanged = false
      },
      (r) => {
        r.fixedPowerPreserved = false
      },
      (r) => {
        r.routedSignals--
      },
      (r) => {
        r.requestedSignals = 0
        r.routedSignals = 0
      },
      (r) => {
        r.fixedPowerDogbones--
      },
      (r) => {
        r.validation.fixedPowerTraces--
      },
      (r) => {
        r.validation.fixedPowerVias--
      },
      (r) => {
        r.validation.fixedPowerPadJoins--
      },
      (r) => {
        r.validation.busLengths[0].matched = false
      },
      (r) => {
        r.validation.pairLengths[0].skewMm = 0.2
      },
      (r) => {
        r.validation.busLengths = []
      },
      (r) => {
        r.validation.pairLengths = []
      },
      (r) => {
        r.validation.busLengths.push({ ...r.validation.busLengths[0] })
      },
    ]
  for (const mutate of mutations) {
    const sample = pair("control")
    mutate(sample.pr.report)
    const result = summarizeComparison(options([sample])).samples[0].pr
    expect(result.accepted).toBeFalse()
    expect(result.budgetedMilliseconds).toBe(10000)
    expect(result.busSkews).toEqual([])
    expect(result.pairSkews).toEqual([])
  }
})

test("worker timeout, reported timeout, crash and invalid reports retain raw durations but receive penalties", () => {
  const samples = allPairs()
  samples[0].pr.timedOut = true
  samples[1].pr.report.status = "timed_out"
  samples[2].pr.exitCode = 23
  // A worker can crash without emitting a report.
  samples[3].pr.report = null as unknown as ReturnType<typeof completedReport>
  samples[3].pr.exitCode = 1
  samples[4].pr.report.solveMilliseconds = -1
  samples[5].pr.report.inputSha256 = "not-a-hash"
  const summary = summarizeComparison(options(samples))
  expect(summary.samples.slice(0, 6).map((s) => s.pr.status)).toEqual([
    "timed_out",
    "timed_out",
    "crashed",
    "crashed",
    "invalid",
    "invalid",
  ])
  expect(summary.pr.accepted).toBe(5)
  expect(summary.pr.timeouts).toBe(2)
  expect(summary.pr.failures).toBe(4)
  for (const sample of summary.samples.slice(0, 6))
    expect(sample.pr.budgetedMilliseconds).toBe(10000)
  expect(summary.samples[0].pr.solveMilliseconds).toBe(100)
  expect(summary.samples[0].pr.wallMilliseconds).toBe(400)
  expect(summary.samples[3].pr.solveMilliseconds).toBeNull()
  expect(summary.samples[4].pr.solveMilliseconds).toBeNull()
})

test("invalid raw durations, signal counts and matching measurements cannot complete", () => {
  for (const key of [
    "solveMilliseconds",
    "milliseconds",
    "requestedSignals",
    "routedSignals",
  ] as const) {
    for (const value of [-1, NaN, Infinity]) {
      const sample = pair("control")
      sample.pr.report[key] = value
      const result = summarizeComparison(options([sample])).samples[0].pr
      expect(result.status).toBe("invalid")
      expect(result.budgetedMilliseconds).toBe(10000)
    }
  }
  for (const key of ["skewMm", "toleranceMm"] as const) {
    for (const value of [-1, NaN, Infinity]) {
      const sample = pair("control")
      sample.pr.report.validation.pairLengths[0][key] = value
      expect(
        summarizeComparison(options([sample])).samples[0].pr.accepted,
      ).toBeFalse()
    }
  }
})

test("reaching or exceeding the solve budget is timed out, while actual elapsed durations remain visible", () => {
  const samples = allPairs()
  samples[0].main.report.solveMilliseconds = 20000
  samples[0].pr.report.solveMilliseconds = 10000
  const summary = summarizeComparison(options(samples))
  expect(summary.samples[0].main.accepted).toBeFalse()
  expect(summary.samples[0].pr.accepted).toBeFalse()
  expect(summary.samples[0].main.status).toBe("timed_out")
  expect(summary.samples[0].pr.status).toBe("timed_out")
  expect(summary.samples[0].main.budgetedMilliseconds).toBe(10000)
  expect(summary.samples[0].main.solveMilliseconds).toBe(20000)
  expect(summary.main.budgeted.p95).toBe(5550)
  expect(summary.matched.count).toBe(10)
  expect(summary.matched.main.p95).toBe(1055)
  expect(summary.matched.pr.p95).toBe(1055)
  const rendered = renderComparison(options(samples))
  expect(rendered).toContain("Budgeted time to valid completion")
  expect(rendered).toContain("not percentiles of actual elapsed durations")
  expect(rendered).toContain("solve 20.000 s")
})

test("missing canonical artifacts remain visible and suppress matched-duration comparisons", () => {
  const summary = summarizeComparison(options([pair("right")]))
  expect(summary.samples).toHaveLength(11)
  expect(summary.main.accepted).toBe(1)
  expect(summary.main.failures).toBe(10)
  expect(summary.main.budgeted.p50).toBe(10000)
  expect(summary.samples[0].main.status).toBe("missing")
  expect(summary.matched.count).toBe(1)
  expect(summary.matched.main.p50).toBeNull()
  const rendered = renderComparison(options([pair("right")]))
  expect(rendered).toContain("Incomplete artifacts")
  expect(rendered).toContain("cannot establish no regression")
  expect(rendered).toContain("| control | missing")
  expect(rendered).toContain("| P50 | n/a | n/a | n/a |")
})

test("a missing revision worker preserves its paired result and suppresses matched-duration statistics", () => {
  const samples: SamplePairArtifact[] = allPairs()
  samples[0].pr = {
    report: null,
    wallMilliseconds: 0,
    exitCode: null,
    error: "Worker did not run",
    timedOut: false,
    missing: true,
  }
  const parsed = validateSamplePairs(samples)
  const summary = summarizeComparison(options(parsed))
  expect(summary.artifactComplete).toBeFalse()
  expect(summary.samples[0].main.accepted).toBeTrue()
  expect(summary.samples[0].pr.status).toBe("missing")
  expect(summary.samples[0].pr.wallMilliseconds).toBeNull()
  expect(summary.samples[0].pr.budgetedMilliseconds).toBe(10000)
  expect(summary.matched.count).toBe(10)
  expect(summary.matched.main.p50).toBeNull()
  expect(renderComparison(options(parsed))).toContain(
    "missing canonical samples or revision workers",
  )
  expect(() =>
    validateSamplePair({
      ...samples[0],
      pr: { ...samples[0].pr, report: completedReport("control") },
    }),
  ).toThrow()
})

test("different input hashes invalidate both paired results and disable comparison", () => {
  const samples = allPairs()
  samples[0].pr.report.inputSha256 = "e".repeat(64)
  const summary = summarizeComparison(options(samples))
  expect(summary.inputComparable).toBeFalse()
  expect(summary.samples[0].comparable).toBeFalse()
  expect(summary.samples[0].main.status).toBe("invalid")
  expect(summary.samples[0].pr.status).toBe("invalid")
  expect(summary.samples[0].main.budgetedMilliseconds).toBe(10000)
  expect(summary.main.accepted).toBe(10)
  expect(summary.pr.accepted).toBe(10)
  expect(summary.matched.main.p50).toBeNull()
  expect(renderComparison(options(samples))).toContain("Input mismatch")
  samples[0].pr.report.inputSha256 = inputSha256.toUpperCase()
  expect(summarizeComparison(options(samples)).inputComparable).toBeTrue()
})

test("revision metadata must match independently supplied pinned commits", () => {
  for (const key of ["mainSha", "prSha", "controllerSha"] as const) {
    const samples = allPairs()
    samples[0].metadata[key] = "f".repeat(40)
    const summary = summarizeComparison(options(samples))
    expect(summary.metadataComparable).toBeFalse()
    expect(summary.samples[0].main.accepted).toBeFalse()
    expect(summary.samples[0].pr.accepted).toBeFalse()
    expect(summary.matched.main.p50).toBeNull()
    expect(renderComparison(options(samples))).toContain("Revision mismatch")
  }
  const reversed = pair("control")
  reversed.metadata.order = ["pr", "main"]
  expect(validateSamplePair(reversed).metadata?.order).toEqual(["pr", "main"])
})

test("accepted reports require complete canonical group identities and unchanged tolerances", () => {
  const mutations: Array<(report: ReturnType<typeof completedReport>) => void> =
    [
      (r) => {
        r.requestedSignals = 73
        r.routedSignals = 73
      },
      (r) => {
        r.validation.busLengths.pop()
      },
      (r) => {
        r.validation.pairLengths.pop()
      },
      (r) => {
        r.validation.busLengths[0].busId = "wrong_bus"
      },
      (r) => {
        r.validation.pairLengths[0].busId = "pair_3"
      },
      (r) => {
        r.validation.busLengths[0].toleranceMm = 100
      },
      (r) => {
        r.validation.pairLengths[0].toleranceMm = 100
      },
      (r) => {
        r.validation.busLengths[0].busId = "DDR_ADDR_CTRL_CK"
      },
    ]
  for (const mutate of mutations) {
    const sample = pair("control")
    mutate(sample.pr.report)
    expect(
      summarizeComparison(options([sample])).samples[0].pr.accepted,
    ).toBeFalse()
  }
  const incompleteCa = pair("inner-layers-complete-ca")
  incompleteCa.pr.report.validation.busLengths.pop()
  expect(
    summarizeComparison(options([incompleteCa])).samples[9].pr.accepted,
  ).toBeFalse()
  const noMetadata: Record<string, unknown> = pair("control")
  delete noMetadata.metadata
  expect(() => validateSamplePair(noMetadata)).toThrow("metadata")
})

test("gain/loss accounting distinguishes successful validation from a fast failure", () => {
  const samples = allPairs()
  samples[0].main.report.validation.valid = false
  samples[1].pr.report.validation.valid = false
  const summary = summarizeComparison(options(samples))
  expect(summary.gained).toEqual(["control"])
  expect(summary.lost).toEqual(["control-inner1"])
  expect(summary.matched.count).toBe(9)
  expect(renderComparison(options(samples))).toContain("| control | failed")
})

test("zero-duration successful baseline leaves percentage changes undefined", () => {
  const samples = SAMPLE_NAMES.map((sample) => pair(sample, 0, 100))
  const summary = summarizeComparison(options(samples))
  expect(summary.main.accepted).toBe(11)
  expect(summary.matched.main.p50).toBe(0)
  expect(summary.matched.deltaPercent.p50).toBeNull()
})

test("malformed numeric envelopes, duplicate samples, unexpected names and unsafe trusted links are rejected", () => {
  expect(() => validateSamplePairs([pair("control"), pair("control")])).toThrow(
    "Duplicate",
  )
  expect(() => validateSamplePair(pair("unexpected"))).toThrow()
  expect(() => validateSamplePairs(null)).toThrow()
  for (const value of [-1, NaN, Infinity]) {
    const sample = pair("control")
    sample.main.wallMilliseconds = value
    expect(() => validateSamplePair(sample)).toThrow()
  }
  const sample = pair("control")
  sample.timeoutSeconds = Infinity
  expect(() => validateSamplePair(sample)).toThrow()
  sample.timeoutSeconds = 9
  expect(() => summarizeComparison(options([sample]))).toThrow("budget")
  const invalidOrder = pair("control")
  invalidOrder.metadata.order = [
    "main",
    "main",
  ] as unknown as PairMetadata["order"]
  expect(() => validateSamplePair(invalidOrder)).toThrow("metadata")
  for (const runUrl of [
    "javascript:alert(1)",
    "https://example.com/run",
    "https://github.com/org/repo/actions/runs/1)\n[bad](x)",
  ])
    expect(() => renderComparison({ ...options(allPairs()), runUrl })).toThrow()
})

test("failure details cannot inject Markdown, HTML, or mentions and unknown skew identifiers fail validation", () => {
  const samples = allPairs()
  const attack =
    "<script>@person</script> | [click](javascript:alert(1))\n# heading `code`"
  samples[0].pr.report.status = "failed"
  samples[0].pr.error = attack as unknown as null
  samples[1].pr.report.validation.busLengths[0].busId = attack
  const rendered = renderComparison(options(samples))
  expect(rendered).not.toContain("<script>")
  expect(rendered).not.toContain("@person")
  expect(rendered).not.toContain("[click]")
  expect(rendered).not.toContain("\n# heading")
  expect(rendered).toContain("&#60;script&#62;&#64;person")
  expect(rendered).toContain("&#124;")
  expect(rendered).toContain("n/a (not accepted)")
  expect(rendered).toContain(mainSha)
  expect(rendered).toContain(prSha)
})

test("loader parses nested JSON artifacts without executing code or following symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-report-"))
  try {
    await mkdir(join(directory, "nested"))
    await writeFile(
      join(directory, "nested", "control.json"),
      JSON.stringify(pair("control")),
    )
    await writeFile(
      join(directory, "payload.ts"),
      "throw Error('must never execute')",
    )
    await symlink(join(directory, "nested"), join(directory, "alias"))
    const loaded = await loadSamplePairs(directory)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].sample).toBe("control")
    await writeFile(
      join(directory, "duplicate.json"),
      JSON.stringify(pair("control")),
    )
    await expect(loadSamplePairs(directory)).rejects.toThrow("Duplicate")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
