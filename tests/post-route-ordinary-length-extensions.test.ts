import { expect, test } from "bun:test"
import { findFixedPathRanges } from "../lib/fixed-route-paths"
import { length } from "../lib/geometry"
import { physicalRoutingAcceptance } from "../lib/physical-routing-acceptance"
import { extendOrdinaryRouteLength } from "../lib/post-route-ordinary-length-extensions"
import { fixedRouteLength } from "../lib/route-lengths"
import { smoothTuningLobes } from "../lib/smooth-tuning"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

type Options = Parameters<typeof extendOrdinaryRouteLength>[2]
type Proposal = Exclude<
  ReturnType<typeof extendOrdinaryRouteLength> extends Generator<infer Yield>
    ? Yield
    : never,
  void
>

const wire = (x: number, y: number): Wire => ({
  route_type: "wire",
  x,
  y,
  layer: "top",
  width: 0.1,
})

function fixture() {
  const original: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "signal-joined",
    connection_name: "signal",
    source_trace_id: "source_signal",
    route: [wire(0, 0), wire(1, 0), wire(5, 0), wire(6, 0)],
  }
  const foreign: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "foreign-joined",
    connection_name: "foreign",
    source_trace_id: "source_foreign",
    route: [wire(-1, 2.5), wire(7, 2.5)],
  }
  const input: SimpleRouteJson = {
    layerCount: 2,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    bounds: { minX: -2, maxX: 8, minY: -4, maxY: 4 },
    connections: [original, foreign].map((trace) => ({
      name: trace.connection_name!,
      source_trace_id: trace.source_trace_id,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!].map((point) => ({
        x: point.x,
        y: point.y,
        layer: "top",
      })),
    })),
    obstacles: [],
    traces: [],
  }
  const fixedEscapes = [
    {
      ...original,
      pcb_trace_id: "signal-prefix",
      route: structuredClone(original.route.slice(0, 2)),
    },
    {
      ...original,
      pcb_trace_id: "signal-suffix",
      route: structuredClone(original.route.slice(-2).toReversed()),
    },
    {
      ...foreign,
      pcb_trace_id: "foreign-path",
      route: structuredClone(foreign.route),
    },
  ]
  return { input, original, foreign, fixedEscapes }
}

function proposals(
  input: SimpleRouteJson,
  routes: readonly Trace[],
  fixedEscapes: readonly Trace[],
  overrides: Partial<Options> = {},
) {
  const result: Proposal[] = []
  let steps = 0
  for (const proposal of extendOrdinaryRouteLength(input, routes, {
    connectionName: "signal",
    minimumLength: 7.5,
    maximumLength: 7.55,
    fixedEscapes,
    maximumCandidates: 2,
    maximumAttempts: 128,
    ...overrides,
  })) {
    if (++steps > 100000)
      throw Error("Planar length extension exceeded its bound")
    if (proposal) result.push(proposal)
  }
  return result
}

function assertCandidate(
  input: SimpleRouteJson,
  original: Trace,
  foreign: Trace,
  fixedEscapes: readonly Trace[],
  proposal: Proposal,
) {
  const report = physicalRoutingAcceptance(input, [proposal.trace, foreign], {
    escapes: fixedEscapes,
  })
  expect(report.physicalRoutingAccepted).toBe(true)
  expect(Object.values(report.gates).every(Boolean)).toBe(true)
  expect(report.nativeDrc.issues).toEqual([])
  expect(report.output.traces!.slice(0, input.traces?.length ?? 0)).toEqual(
    input.traces ?? [],
  )
  expect(findFixedPathRanges(proposal.trace, fixedEscapes)).not.toBeNull()
  expect(proposal.trace.route[0]).toEqual(original.route[0])
  expect(proposal.trace.route.at(-1)).toEqual(original.route.at(-1))
  expect(proposal.trace.pcb_trace_id).toBe(original.pcb_trace_id)
  expect(proposal.trace.source_trace_id).toBe(original.source_trace_id)
  expect(proposal.trace.connection_name).toBe(original.connection_name)
  expect(
    proposal.trace.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(0)
  expect(proposal.addedVias).toBe(0)
  expect(proposal.fullOwnedLength).toBeCloseTo(
    length(proposal.trace.route) + fixedRouteLength(input, "signal"),
    8,
  )
  expect(proposal.fullOwnedLength).toBeGreaterThan(
    length(original.route) + fixedRouteLength(input, "signal"),
  )
}

test("a free planar edge reaches the requested band with no vias and complete foreign copper intact", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  input.buses = [
    {
      busId: "data",
      connectionNames: ["signal", "foreign"],
      minLength: 7.99,
      maxLength: 8.01,
      maxLengthSkew: 0.02,
    },
  ]
  const routes = [original, foreign]
  const before = structuredClone({ input, routes, fixedEscapes })
  expect(
    physicalRoutingAcceptance(input, routes, { escapes: fixedEscapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  const result = proposals(input, routes, fixedEscapes, {
    minimumLength: 7.99,
    maximumLength: 8.01,
  })
  expect(result.length).toBeGreaterThan(0)
  for (const proposal of result) {
    assertCandidate(input, original, foreign, fixedEscapes, proposal)
    expect(proposal.withinTargetBand).toBe(true)
    expect(proposal.distanceToTargetBand).toBeLessThanOrEqual(1e-7)
    expect(proposal.previousDistanceToTargetBand).toBeCloseTo(1.99, 8)
    expect(proposal.fullOwnedLength).toBeGreaterThanOrEqual(7.99 - 1e-7)
    expect(proposal.fullOwnedLength).toBeLessThanOrEqual(8.01 + 1e-7)
    const report = physicalRoutingAcceptance(input, [proposal.trace, foreign], {
      escapes: fixedEscapes,
    })
    expect(report.ddrTimingAccepted).toBe(true)
    expect(report.buses[0]).toMatchObject({
      matched: true,
      aboveMinimumLength: true,
      withinLengthLimit: true,
    })
  }
  expect({ input, routes, fixedEscapes }).toEqual(before)
})

test("native supplied copper contributes once to the full-owned length target", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "native-signal",
      connection_name: "signal",
      source_trace_id: "source_signal",
      route: [wire(-0.5, 0), wire(0, 0)],
    },
  ]
  const before = structuredClone(input)
  expect(
    physicalRoutingAcceptance(input, [original, foreign], {
      escapes: fixedEscapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  const result = proposals(input, [original, foreign], fixedEscapes, {
    minimumLength: 8,
    maximumLength: 8.05,
  })
  expect(result.length).toBeGreaterThan(0)
  for (const proposal of result) {
    assertCandidate(input, original, foreign, fixedEscapes, proposal)
    expect(proposal.fullOwnedLength).toBeCloseTo(
      length(proposal.trace.route) + 0.5,
      8,
    )
    expect(proposal.fullOwnedLength).toBeGreaterThanOrEqual(8 - 1e-7)
    expect(proposal.fullOwnedLength).toBeLessThanOrEqual(8.05 + 1e-7)
  }
  expect(input).toEqual(before)
})

test("a two-attempt budget reaches an open later span after the first span is blocked", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  original.route.splice(2, 0, wire(3, 0))
  foreign.route = [wire(1.1, 0.4), wire(2.9, 0.4)]
  input.connections[1].pointsToConnect = [
    { x: 1.1, y: 0.4, layer: "top" },
    { x: 2.9, y: 0.4, layer: "top" },
  ]
  fixedEscapes[2] = {
    ...fixedEscapes[2],
    route: structuredClone(foreign.route),
  }
  const before = structuredClone({ input, original, foreign, fixedEscapes })
  expect(
    physicalRoutingAcceptance(input, [original, foreign], {
      escapes: fixedEscapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  const result = proposals(input, [original, foreign], fixedEscapes, {
    maximumAttempts: 2,
    maximumCandidates: 1,
  })
  expect(result).toHaveLength(1)
  assertCandidate(input, original, foreign, fixedEscapes, result[0])
  expect(result[0].withinTargetBand).toBe(true)
  expect(result[0].trace.route.slice(0, 3)).toEqual(original.route.slice(0, 3))
  expect(
    result[0].trace.route.some(
      (point) => point.x > 3 && point.x < 5 && point.y > 0.1,
    ),
  ).toBe(true)
  expect({ input, original, foreign, fixedEscapes }).toEqual(before)
})

test("partial progress is opt-in and stays truthfully below an unreachable band", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  input.bounds.minY = -1.5
  input.bounds.maxY = 1.5
  foreign.route = [wire(-1, 1.2), wire(7, 1.2)]
  input.connections[1].pointsToConnect = [
    { x: -1, y: 1.2, layer: "top" },
    { x: 7, y: 1.2, layer: "top" },
  ]
  fixedEscapes[2] = {
    ...fixedEscapes[2],
    route: structuredClone(foreign.route),
  }
  const before = structuredClone({ input, original, foreign, fixedEscapes })
  expect(
    physicalRoutingAcceptance(input, [original, foreign], {
      escapes: fixedEscapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  const budget = {
    minimumLength: 12,
    maximumLength: 12.05,
    maximumAttempts: 8,
    maximumCandidates: 1,
  }
  expect(proposals(input, [original, foreign], fixedEscapes, budget)).toEqual(
    [],
  )
  const result = proposals(input, [original, foreign], fixedEscapes, {
    ...budget,
    allowPartialProgress: true,
  })
  expect(result).toHaveLength(1)
  assertCandidate(input, original, foreign, fixedEscapes, result[0])
  expect(result[0].withinTargetBand).toBe(false)
  expect(result[0].fullOwnedLength).toBeLessThan(12)
  expect(result[0].distanceToTargetBand).toBeCloseTo(
    12 - result[0].fullOwnedLength,
    8,
  )
  expect(result[0].previousDistanceToTargetBand).toBeCloseTo(6, 8)
  expect(result[0].distanceToTargetBand).toBeLessThan(
    result[0].previousDistanceToTargetBand,
  )
  expect({ input, original, foreign, fixedEscapes }).toEqual(before)
})

test("outside curve permissions and tiny handoff field values remain exact after insertion", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  original.route[1].x += 1e-12
  original.route[2].x -= 1e-12
  original.curvedSegments = [1, 3]
  fixedEscapes[0] = {
    ...fixedEscapes[0],
    route: structuredClone(original.route.slice(0, 2)),
    curvedSegments: [1],
  }
  fixedEscapes[1] = {
    ...fixedEscapes[1],
    route: structuredClone(original.route.slice(-2).toReversed()),
    curvedSegments: [1],
  }
  const result = proposals(input, [original, foreign], fixedEscapes)
  expect(result.length).toBeGreaterThan(0)
  for (const proposal of result) {
    assertCandidate(input, original, foreign, fixedEscapes, proposal)
    expect(proposal.trace.route[1]).toEqual(original.route[1])
    expect(proposal.trace.route.at(-2)).toEqual(original.route.at(-2))
    expect(proposal.trace.curvedSegments).toContain(1)
    expect(proposal.trace.curvedSegments).toContain(
      proposal.trace.route.length - 1,
    )
  }
})

test("a foreign trace and native lower wall block planar extension on both sides", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  foreign.route = [wire(-1, 0.18), wire(7, 0.18)]
  input.connections[1].pointsToConnect = [
    { x: -1, y: 0.18, layer: "top" },
    { x: 7, y: 0.18, layer: "top" },
  ]
  fixedEscapes[2] = {
    ...fixedEscapes[2],
    route: structuredClone(foreign.route),
  }
  input.obstacles = [
    {
      type: "rect",
      center: { x: 3, y: -2.1 },
      width: 10,
      height: 3.8,
      layers: ["top"],
      connectedTo: ["lower-wall"],
    },
  ]
  expect(
    physicalRoutingAcceptance(input, [original, foreign], {
      escapes: fixedEscapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  expect(proposals(input, [original, foreign], fixedEscapes)).toEqual([])
})

test("a four-attempt budget reaches the clear opposite side after both positive-side methods fail", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  foreign.route = [wire(-1, 0.18), wire(7, 0.18)]
  input.connections[1].pointsToConnect = [
    { x: -1, y: 0.18, layer: "top" },
    { x: 7, y: 0.18, layer: "top" },
  ]
  fixedEscapes[2] = {
    ...fixedEscapes[2],
    route: structuredClone(foreign.route),
  }
  const before = structuredClone({ input, original, foreign, fixedEscapes })
  expect(
    physicalRoutingAcceptance(input, [original, foreign], {
      escapes: fixedEscapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  const result = proposals(input, [original, foreign], fixedEscapes, {
    maximumAttempts: 4,
    maximumCandidates: 1,
  })
  expect(result).toHaveLength(1)
  assertCandidate(input, original, foreign, fixedEscapes, result[0])
  expect(result[0].withinTargetBand).toBe(true)
  expect(result[0].trace.route.some((point) => point.y < -0.1)).toBe(true)
  expect(result[0].trace.route.every((point) => point.y <= 0)).toBe(true)
  expect({ input, original, foreign, fixedEscapes }).toEqual(before)
})

test("a narrow finite bay admits tiny truthful partial progress after coarse lobes fail", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  foreign.route = [wire(-1, 0.2), wire(7, 0.2)]
  input.connections[1].pointsToConnect = [
    { x: -1, y: 0.2, layer: "top" },
    { x: 7, y: 0.2, layer: "top" },
  ]
  fixedEscapes[2] = {
    ...fixedEscapes[2],
    route: structuredClone(foreign.route),
  }
  input.obstacles = [
    {
      type: "rect",
      center: { x: 3, y: -2.075 },
      width: 10,
      height: 3.85,
      layers: ["top"],
      connectedTo: ["lower-wall"],
    },
  ]
  const before = structuredClone({ input, original, foreign, fixedEscapes })
  expect(
    physicalRoutingAcceptance(input, [original, foreign], {
      escapes: fixedEscapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  const coarse = smoothTuningLobes(
    original.route[1],
    original.route[2],
    1.5,
    1,
    1,
    0.12,
  )
  expect(coarse).not.toBeNull()
  const coarseTrace: Trace = {
    ...original,
    route: [
      original.route[0],
      ...coarse!.map((point) => wire(point.x, point.y)),
      original.route.at(-1)!,
    ],
    curvedSegments: coarse!.slice(1).map((_, index) => index + 2),
  }
  const coarseReport = physicalRoutingAcceptance(
    input,
    [coarseTrace, foreign],
    { escapes: fixedEscapes },
  )
  expect(coarseReport.physicalRoutingAccepted).toBe(false)
  expect(coarseReport.nativeDrc.valid).toBe(false)
  const budget = {
    minimumLength: 12,
    maximumLength: 12.05,
    maximumAttempts: 20,
    maximumCandidates: 1,
  }
  expect(proposals(input, [original, foreign], fixedEscapes, budget)).toEqual(
    [],
  )
  const result = proposals(input, [original, foreign], fixedEscapes, {
    ...budget,
    allowPartialProgress: true,
  })
  expect(result).toHaveLength(1)
  assertCandidate(input, original, foreign, fixedEscapes, result[0])
  expect(result[0].withinTargetBand).toBe(false)
  expect(result[0].fullOwnedLength).toBeLessThan(6.01)
  expect(result[0].distanceToTargetBand).toBeCloseTo(
    12 - result[0].fullOwnedLength,
    8,
  )
  expect(
    result[0].previousDistanceToTargetBand - result[0].distanceToTargetBand,
  ).toBeGreaterThan(1e-7)
  expect({ input, original, foreign, fixedEscapes }).toEqual(before)
})

test("absent or changed fixed paths and incomplete complete-route input reject", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  const changed = structuredClone(fixedEscapes)
  changed[0].route[1].x += 1e-12
  expect(proposals(input, [original, foreign], changed)).toEqual([])
  expect(proposals(input, [original], fixedEscapes)).toEqual([])
  const missing = [
    ...fixedEscapes,
    { ...original, pcb_trace_id: "absent-fixed-path", route: [wire(100, 100)] },
  ]
  expect(proposals(input, [original, foreign], missing)).toEqual([])
})

test("paired and explicitly coupled owners are skipped", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  input.differentialPairs = [
    { connectionNames: ["signal", "foreign"], lengthTolerance: 100 },
  ]
  expect(
    physicalRoutingAcceptance(input, [original, foreign], {
      escapes: fixedEscapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  expect(proposals(input, [original, foreign], fixedEscapes)).toEqual([])
  input.differentialPairs = []
  original.coupledSection = [1, 2]
  expect(proposals(input, [original, foreign], fixedEscapes)).toEqual([])
})

test("expired deadlines and zero attempt or proposal budgets produce no candidates", () => {
  const { input, original, foreign, fixedEscapes } = fixture()
  for (const budget of [
    { deadlineMs: performance.now() - 1 },
    { maximumAttempts: 0 },
    { maximumCandidates: 0 },
  ]) {
    expect(proposals(input, [original, foreign], fixedEscapes, budget)).toEqual(
      [],
    )
  }
})
