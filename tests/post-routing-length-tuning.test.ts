import { expect, test } from "bun:test"
import { length } from "../lib/geometry"
import {
  postProcessRoutedLengths,
  routedLengthMatchingProblem,
  type PostRoutingLengthProposalFactory,
} from "../lib/post-routing-length-tuning"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const wire = (x: number, y: number): Wire => ({
  route_type: "wire",
  x,
  y,
  layer: "top",
  width: 0.1,
})

function fixture() {
  const traces: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "short",
      connection_name: "D0",
      route: [wire(0, 0), wire(6, 0)],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "long",
      connection_name: "D1",
      route: [wire(0, 3), wire(8, 3)],
    },
  ]
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 10, minY: -4, maxY: 5 },
    connections: traces.map((trace) => ({
      name: trace.connection_name!,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
    })),
    obstacles: [],
    traces: [],
    buses: [
      { busId: "DATA", connectionNames: ["D0", "D1"], maxLengthSkew: 0.1 },
    ],
  }
  const output = { ...structuredClone(input), traces: structuredClone(traces) }
  return { input, output, traces }
}

function extended(trace: Trace, extra: number): Trace {
  const cut = 0.1
  const height = (extra + 4 * (2 - Math.SQRT2) * cut) / 2
  return {
    ...structuredClone(trace),
    route: [
      trace.route[0],
      wire(1, 0),
      wire(1 + cut, -cut),
      wire(1 + cut, -height + cut),
      wire(1 + 2 * cut, -height),
      wire(2 - 2 * cut, -height),
      wire(2 - cut, -height + cut),
      wire(2 - cut, -cut),
      wire(2, 0),
      trace.route.at(-1)!,
    ],
  }
}

function run(work: ReturnType<typeof postProcessRoutedLengths>) {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}

test("postprocessor reaches all configured limits without changing native input", () => {
  const { input, output, traces } = fixture()
  const beforeInput = structuredClone(input)
  const beforeOutput = structuredClone(output)
  const proposal: PostRoutingLengthProposalFactory = function* () {
    yield { replacements: [extended(traces[0], 2)] }
  }
  const result = run(
    postProcessRoutedLengths(input, output, { proposalFactories: [proposal] }),
  )
  expect(result.timingSolved).toBe(true)
  expect(result.reason).toBe("matched")
  expect(result.physicalRoutingAccepted).toBe(true)
  expect(result.acceptance.nativeDrc.issues).toHaveLength(0)
  expect(result.acceptance.buses[0].skewMm).toBeCloseTo(0, 10)
  expect(result.evaluation.actualConstraintFailures).toBe(0)
  expect(input).toEqual(beforeInput)
  expect(output).toEqual(beforeOutput)
})

test("default tuning reaches native bus matching without adding vias", () => {
  const { input, output } = fixture()
  const result = run(
    postProcessRoutedLengths(input, output, { timeBudgetMs: 1000 }),
  )
  expect(result.timingSolved).toBe(true)
  expect(result.acceptance.buses[0].skewMm).toBeLessThanOrEqual(0.1 + 1e-7)
  expect(result.statistics.acceptedCandidates).toBeGreaterThan(0)
  expect(
    result.output
      .traces!.flatMap((trace) => trace.route)
      .filter((point) => point.route_type === "via"),
  ).toHaveLength(0)
  expect(result.acceptance.nativeDrc.issues).toHaveLength(0)
})

test("an operator budget gives later operators a turn and preserves decision evidence", () => {
  const { input, output, traces } = fixture()
  const blocked: PostRoutingLengthProposalFactory = function* () {
    while (true) yield undefined
  }
  const valid: PostRoutingLengthProposalFactory = function* () {
    yield { replacements: [extended(traces[0], 2)], operator: "valid-later" }
  }
  const work = postProcessRoutedLengths(input, output, {
    proposalFactories: [blocked, valid],
    maximumOperatorTimeMs: 10,
    maximumSteps: 1000000,
  })
  let next = work.next()
  let sawBestDecision = false
  while (!next.done) {
    sawBestDecision ||=
      next.value.operator === "valid-later" && next.value.decision === "best"
    next = work.next()
  }
  expect(next.value.timingSolved).toBe(true)
  expect(next.value.statistics.trialAcceptedCandidates).toBe(1)
  expect(sawBestDecision).toBe(true)
})

test("zero operator budget preserves the baseline without invoking proposals", () => {
  const { input, output } = fixture()
  let invoked = false
  const proposal: PostRoutingLengthProposalFactory = function* () {
    invoked = true
    yield undefined
  }
  const result = run(
    postProcessRoutedLengths(input, output, {
      maximumOperatorTimeMs: 0,
      proposalFactories: [proposal],
    }),
  )
  expect(invoked).toBe(false)
  expect(result.output).toEqual(output)
  expect(result.statistics.checkedCandidates).toBe(0)
  expect(() =>
    postProcessRoutedLengths(input, output, {
      maximumOperatorTimeMs: -1,
    }).next(),
  ).toThrow("budgets")
})

test("later worse, shorted and throwing attempts retain the best partial result", () => {
  const { input, output, traces } = fixture()
  const proposal: PostRoutingLengthProposalFactory = function* () {
    yield { replacements: [extended(traces[0], 1)] }
    yield { replacements: [traces[0]] }
    const shorted = {
      ...traces[0],
      route: [
        traces[0].route[0],
        wire(1, 0),
        wire(1, 3),
        wire(5, 3),
        wire(5, 0),
        traces[0].route.at(-1)!,
      ],
    }
    yield { replacements: [shorted] }
    throw Error("proposal failed")
  }
  const result = run(
    postProcessRoutedLengths(input, output, {
      proposalFactories: [proposal],
      maximumPlans: 1,
      maximumPasses: 1,
    }),
  )
  expect(result.timingSolved).toBe(false)
  expect(result.reason).toBe("budget")
  expect(length(result.output.traces![0].route)).toBeCloseTo(7, 10)
  expect(result.statistics.acceptedCandidates).toBe(1)
  expect(result.acceptance.nativeDrc.issues).toHaveLength(0)
  expect(result.errors).toContain("proposal failed")
  expect(result.output.traces![1]).toEqual(traces[1])
})

test("cancelling the generator returns the best verified checkpoint", () => {
  const { input, output, traces } = fixture()
  const proposal: PostRoutingLengthProposalFactory = function* () {
    yield { replacements: [extended(traces[0], 1)] }
    while (true) yield undefined
  }
  const work = postProcessRoutedLengths(input, output, {
    proposalFactories: [proposal],
    maximumPlans: 1,
  })
  const first = work.next()
  expect(first.done).toBe(false)
  const result = work.return(undefined as never)
  expect(result.done).toBe(true)
  if (!result.done) throw Error("Postprocessor did not close")
  expect(result.value.reason).toBe("interrupted")
  expect(result.value.timingSolved).toBe(false)
  expect(length(result.value.output.traces![0].route)).toBeCloseTo(7, 10)
  expect(result.value.acceptance.physicalRoutingAccepted).toBe(true)
})

test("step and time budgets return the unchanged baseline when no candidate fits", () => {
  const { input, output } = fixture()
  for (const budget of [
    { maximumSteps: 0 },
    { timeBudgetMs: 0 },
    { maximumPasses: 0 },
  ]) {
    const result = run(postProcessRoutedLengths(input, output, budget))
    expect(result.reason).toBe("budget")
    expect(result.output).toEqual(output)
    expect(result.timingSolved).toBe(false)
    expect(result.statistics.acceptedCandidates).toBe(0)
  }
})

test("fixed paths and terminal metadata cannot be changed to improve timing", () => {
  const { input, output, traces } = fixture()
  const held: Trace = { ...traces[0], route: [traces[0].route[0], wire(2, 0)] }
  traces[0].route.splice(1, 0, wire(2, 0))
  output.traces = structuredClone(traces)
  const proposal: PostRoutingLengthProposalFactory = function* () {
    yield { replacements: [extended(traces[0], 2)] }
    yield {
      replacements: [{ ...extended(traces[0], 2), pcb_trace_id: "renamed" }],
    }
  }
  const result = run(
    postProcessRoutedLengths(input, output, {
      fixedEscapes: [held],
      proposalFactories: [proposal],
      maximumPasses: 1,
    }),
  )
  expect(result.output).toEqual(output)
  expect(result.statistics.acceptedCandidates).toBe(0)
  expect(result.acceptance.escapesPreserved).toBe(true)
})

test("the fixed-path lower bound counts overlapping escapes only once", () => {
  const { input, traces } = fixture()
  traces[0].route = [
    wire(0, 0),
    wire(1, -1),
    wire(2, -1),
    wire(3, 0),
    wire(6, 0),
  ]
  const fixed: Trace[] = [
    { ...traces[0], route: traces[0].route.slice(0, 3) },
    { ...traces[0], route: traces[0].route.slice(1, 3) },
  ]
  const problem = routedLengthMatchingProblem(input, traces, fixed)
  expect(problem.nets[0].lowerBoundMm).toBeCloseTo(
    1 + Math.SQRT2 + Math.sqrt(17),
    10,
  )
  expect(problem.nets[0].fixedLength).toBe(false)
})

test("changed board geometry and partial starting routes fail before search", () => {
  const { input, output } = fixture()
  const wrongBoard = { ...output, minTraceWidth: 0.2 }
  expect(() => postProcessRoutedLengths(input, wrongBoard).next()).toThrow(
    "geometry",
  )
  expect(() =>
    postProcessRoutedLengths(input, {
      ...output,
      traces: output.traces!.slice(1),
    }).next(),
  ).toThrow("complete DRC-clean")
})

test("infeasible timing rules return the complete physical baseline with diagnostics", () => {
  const { input, output } = fixture()
  input.buses![0].minLength = 12
  input.buses![0].maxLength = 3
  output.buses = structuredClone(input.buses)
  const result = run(postProcessRoutedLengths(input, output))
  expect(result.timingSolved).toBe(false)
  expect(result.output).toEqual(output)
  expect(result.portfolio.plans).toHaveLength(0)
  expect(result.portfolio.failures.length).toBeGreaterThan(0)
  expect(result.acceptance.physicalRoutingAccepted).toBe(true)
})

test("a proposal cannot exchange an untimed RESET route for timing progress", () => {
  const { input, output, traces } = fixture()
  const reset: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "reset",
    connection_name: "RESET",
    route: [wire(0, 4), wire(8, 4)],
  }
  input.connections.push({
    name: "RESET",
    pointsToConnect: [reset.route[0], reset.route.at(-1)!] as Wire[],
  })
  output.connections = structuredClone(input.connections)
  output.traces!.push(reset)
  const proposal: PostRoutingLengthProposalFactory = function* () {
    yield {
      replacements: [
        extended(traces[0], 2),
        { ...reset, route: [reset.route[0], wire(4, 4), reset.route.at(-1)!] },
      ],
    }
  }
  const result = run(
    postProcessRoutedLengths(input, output, { proposalFactories: [proposal] }),
  )
  expect(result.timingSolved).toBe(false)
  expect(result.output).toEqual(output)
  expect(result.statistics.acceptedCandidates).toBe(0)
})
