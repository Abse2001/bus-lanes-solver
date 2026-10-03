import { expect, test } from "bun:test"
import {
  anytimeMatchingCohort,
  searchAnytimeTopology,
  type AnytimeTopologyProposal,
} from "../lib/anytime-topology-search"
import { length } from "../lib/geometry"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"

const trace = (name: string, points: Point[]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  route: points.map((p) => ({
    ...p,
    route_type: "wire",
    layer: "top",
    width: 0.1,
  })),
})

function fixture(traces: Trace[]): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        x: p.x,
        y: p.y,
        layer: "top",
      })),
    })),
  }
}

function drain(
  generator: Generator<AnytimeTopologyProposal | undefined>,
  limit = 3000,
) {
  const proposals: AnytimeTopologyProposal[] = []
  let heartbeats = 0
  for (let step = 0; step < limit; step++) {
    const next = generator.next()
    if (next.done) return { proposals, heartbeats }
    if (next.value) proposals.push(next.value)
    else heartbeats++
  }
  generator.return(undefined)
  throw Error("Topology search exceeded its bounded test work")
}

function expectClear(input: SimpleRouteJson, traces: Trace[]) {
  for (const t of traces) {
    const connection = input.connections.find(
      (c) => c.name === t.connection_name,
    )!
    const scene = new VectorScene(input, connection, 0.1, [
      ...fixedCopper(input),
      ...traces.flatMap(routeCopper),
    ])
    expect(scene.pathVisible(t.route)).toBe(true)
    expect(t.route[0]).toMatchObject(connection.pointsToConnect[0])
    expect(t.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
  }
}

test("scratch rerouting contracts a boundary detour and changes topology around immutable copper", () => {
  const traces = [
    trace("A", [
      { x: -4, y: 0 },
      { x: -4, y: -4 },
      { x: 4, y: -4 },
      { x: 4, y: 0 },
    ]),
  ]
  const input = fixture(traces)
  input.obstacles = [
    {
      center: { x: 0, y: 0 },
      width: 2,
      height: 2,
      layers: ["top"],
      connectedTo: [],
    },
  ]
  input.traces = [
    trace("fixed_power", [
      { x: -0.5, y: -1.4 },
      { x: 0.5, y: -1.4 },
    ]),
  ]
  const before = structuredClone({ input, traces })
  const { proposals, heartbeats } = drain(
    searchAnytimeTopology(input, traces, {
      maxTargets: 1,
      contractions: [0.25],
      maxSearchExpansions: 10_000,
    }),
  )
  expect(proposals.length).toBeGreaterThan(0)
  expect(heartbeats).toBeGreaterThan(0)
  const proposal = proposals[0]
  expect(proposal.stage).toBe("contract")
  expect(length(proposal.traces[0].route)).toBeLessThan(
    length(traces[0].route) - 2,
  )
  expect(proposal.envelope.minY).toBeGreaterThan(-4)
  for (const point of proposal.traces[0].route)
    expect(point.y).toBeGreaterThanOrEqual(proposal.envelope.minY)
  expectClear(input, proposal.traces)
  expect({ input, traces }).toEqual(before)
})

test("a coordinated rip-up moves a blocking U route and frees the shorter corridor", () => {
  const traces = [
    trace("A", [
      { x: -4, y: 0 },
      { x: -3, y: -1 },
      { x: -3, y: -2 },
      { x: 3, y: -2 },
      { x: 3, y: -1 },
      { x: 4, y: 0 },
    ]),
    trace("B", [
      { x: -1, y: 1 },
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
    ]),
  ]
  const input = fixture(traces)
  const { proposals } = drain(
    searchAnytimeTopology(input, traces, {
      maxTargets: 2,
      maxTransactions: 20,
      contractions: [0],
      beamWidth: 3,
      maxSearchExpansions: 2000,
    }),
  )
  const coordinated = proposals.find(
    (proposal) =>
      proposal.stage === "rip_up" &&
      proposal.changedNames.includes("A") &&
      proposal.changedNames.includes("B") &&
      Math.abs(length(proposal.traces[0].route) - 8) < 1e-7 &&
      Math.abs(length(proposal.traces[1].route) - 2) < 1e-7,
  )
  expect(coordinated).toBeDefined()
  expectClear(input, coordinated!.traces)
})

test("whole-cohort repacking abandons nested detour channels and cuts envelope area by more than half", () => {
  const traces = [
    trace("A", [
      { x: -4, y: 0 },
      { x: -4, y: -4 },
      { x: 4, y: -4 },
      { x: 4, y: 0 },
    ]),
    trace("B", [
      { x: -3, y: 1 },
      { x: -3, y: -2 },
      { x: 3, y: -2 },
      { x: 3, y: 1 },
    ]),
    trace("C", [
      { x: -1, y: 2 },
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 2 },
    ]),
  ]
  const input = fixture(traces)
  input.buses = [
    { busId: "bundle", connectionNames: ["A", "B", "C"], maxLengthSkew: 0.1 },
  ]
  const proposals = drain(
    searchAnytimeTopology(input, traces, {
      maxTargets: 1,
      maxTransactions: 8,
      contractions: [0],
      maxProposals: 4,
    }),
  ).proposals
  const repacked = proposals.find(
    (proposal) => proposal.changedNames.length === 3,
  )
  expect(repacked).toBeDefined()
  expect(repacked!.retuneNames).toEqual(["A", "B", "C"])
  const area = (routes: Trace[]) => {
    const points = routes.flatMap((t) => t.route)
    return (
      (Math.max(...points.map((p) => p.x)) -
        Math.min(...points.map((p) => p.x)) +
        0.1) *
      (Math.max(...points.map((p) => p.y)) -
        Math.min(...points.map((p) => p.y)) +
        0.1)
    )
  }
  expect(area(repacked!.traces)).toBeLessThan(area(traces) / 2)
  expectClear(input, repacked!.traces)
  const weighted = searchAnytimeTopology(input, traces, {
    maxTargets: 3,
    maxTransactions: 8,
    contractions: [0],
    repackChunksPerRound: 16,
  })
  const firstFive = Array.from({ length: 5 }, () => weighted.next().value)
  weighted.return(undefined)
  expect(
    firstFive.some((proposal) => proposal?.changedNames.length === 3),
  ).toBe(true)
})

test("a cohort keeps an unchanged continuous corridor when bounded grid work is exhausted", () => {
  const traces = [
    trace("A", [
      { x: -4, y: 0 },
      { x: -4, y: -4 },
      { x: 4, y: -4 },
      { x: 4, y: 0 },
    ]),
    trace("B", [
      { x: -3, y: 2 },
      { x: -3, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 2 },
    ]),
  ]
  traces[1].curvedSegments = [2]
  const input = fixture(traces)
  input.obstacles = [
    {
      center: { x: 0, y: 2 },
      width: 2,
      height: 2,
      layers: ["top"],
      connectedTo: [],
    },
  ]
  expectClear(input, traces)
  const proposals = drain(
    searchAnytimeTopology(input, traces, {
      maxTargets: 0,
      maxTransactions: 1,
      maxSearchExpansions: 0,
      contractions: [0],
    }),
  ).proposals
  expect(proposals).toHaveLength(1)
  expect(proposals[0].changedNames).toEqual(["A"])
  expect(proposals[0].traces[1]).toEqual(traces[1])
  expectClear(input, proposals[0].traces)
})

test("a targeted transaction clears all seven actual blockers beyond the small local rip-up beam", () => {
  const target = trace("A", [
    { x: -4, y: 0 },
    { x: -4, y: -4.4 },
    { x: 4, y: -4.4 },
    { x: 4, y: 0 },
  ])
  const blockers = Array.from({ length: 7 }, (_, index) => {
    const x = 3.5 - index * 0.4,
      top = 2.3 - index * 0.25,
      bottom = -2 + index * 0.25
    return trace(`B${index}`, [
      { x: -x, y: top },
      { x: -x, y: bottom },
      { x, y: bottom },
      { x, y: top },
    ])
  })
  const traces = [target, ...blockers]
  const input = fixture(traces)
  expectClear(input, traces)
  const proposals = drain(
    searchAnytimeTopology(input, traces, {
      maxTargets: 1,
      maxTransactions: 4,
      maxRipUp: 2,
      beamWidth: 1,
      contractions: [0],
      repackWholeCohort: false,
    }),
  ).proposals
  const closure = proposals.find(
    (proposal) => proposal.changedNames.length === 8,
  )
  expect(closure).toBeDefined()
  expect(length(closure!.traces[0].route)).toBeCloseTo(8, 8)
  expectClear(input, closure!.traces)
})

test("outside-face portals expose a package detour beyond the longitudinal inter-package window", () => {
  const traces = [
    trace("A", [
      { x: -0.8, y: 0 },
      { x: -2, y: 0 },
      { x: -2, y: -3 },
      { x: -4, y: -3 },
      { x: -4, y: 13 },
      { x: -2, y: 13 },
      { x: -2, y: 10 },
      { x: -0.8, y: 10 },
    ]),
  ]
  const input = fixture(traces)
  input.bounds = { minX: -5, maxX: 5, minY: -5, maxY: 15 }
  input.obstacles = [0, 10].map((y, index) => ({
    componentId: `U${index}`,
    center: { x: 0, y },
    width: 2,
    height: 2,
    layers: ["top"],
    connectedTo: ["A"],
  }))
  const proposals = drain(
    searchAnytimeTopology(input, traces, {
      maxTargets: 1,
      maxTransactions: 2,
      contractions: [0],
    }),
  ).proposals
  expect(proposals.length).toBeGreaterThan(0)
  const improved = proposals[0].traces[0]
  expect(length(improved.route)).toBeLessThan(length(traces[0].route) - 10)
  expect(Math.min(...improved.route.map((p) => p.y))).toBeGreaterThanOrEqual(0)
  expect(Math.max(...improved.route.map((p) => p.y))).toBeLessThanOrEqual(10)
  expectClear(input, proposals[0].traces)
})

test("alternate outside portals reach a continuous channel the highest-merit splice cannot use", () => {
  const traces = [
    trace("A", [
      { x: -0.8, y: 0 },
      { x: -2, y: 0 },
      { x: -2, y: 2 },
      { x: -2.2, y: 2.2 },
      { x: -7, y: 2.2 },
      { x: -7, y: 7.8 },
      { x: -2.2, y: 7.8 },
      { x: -2, y: 8 },
      { x: -2, y: 10 },
      { x: -0.8, y: 10 },
    ]),
  ]
  const input = fixture(traces)
  input.bounds = { minX: -8, maxX: 5, minY: -5, maxY: 15 }
  input.obstacles = [0, 10].map((y, index) => ({
    componentId: `U${index}`,
    center: { x: 0, y },
    width: 2,
    height: 2,
    layers: ["top"],
    connectedTo: ["A"],
  }))
  input.traces = [
    trace("fixed_power", [
      { x: -2.38, y: 3 },
      { x: -2.38, y: 7 },
    ]),
  ]
  expectClear(input, traces)
  const options = {
    maxTargets: 1,
    maxTransactions: 4,
    contractions: [0],
    maxSearchExpansions: 0,
  }
  expect(
    drain(
      searchAnytimeTopology(input, traces, {
        ...options,
        maxPortalVariants: 1,
      }),
    ).proposals,
  ).toHaveLength(0)
  const proposals = drain(
    searchAnytimeTopology(input, traces, {
      ...options,
      maxPortalVariants: 4,
    }),
  ).proposals
  expect(proposals.length).toBeGreaterThan(0)
  expect(length(proposals[0].traces[0].route)).toBeLessThan(
    length(traces[0].route) - 8,
  )
  for (const proposal of proposals) expectClear(input, proposal.traces)
})

test("paired rails remain unchanged and retuning closes every overlapping electrical cohort", () => {
  const traces = [
    trace("A", [
      { x: -4, y: 0 },
      { x: -3, y: -2 },
      { x: 3, y: -2 },
      { x: 4, y: 0 },
    ]),
    trace("P", [
      { x: -4, y: 2 },
      { x: 4, y: 2 },
    ]),
    trace("N", [
      { x: -4, y: 2.22 },
      { x: 4, y: 2.22 },
    ]),
    trace("C", [
      { x: -4, y: 3 },
      { x: 4, y: 3 },
    ]),
  ]
  const input = fixture(traces)
  input.buses = [
    { busId: "first", connectionNames: ["A", "P"], maxLengthSkew: 0.1 },
    { busId: "second", connectionNames: ["N", "C"], maxLengthSkew: 0.1 },
  ]
  input.differentialPairs = [
    { connectionNames: ["P", "N"], lengthTolerance: 0.1, traceGap: 0.12 },
  ]
  expect(anytimeMatchingCohort(input, ["A"])).toEqual(["A", "P", "N", "C"])
  const { proposals } = drain(
    searchAnytimeTopology(input, traces, {
      maxTargets: 1,
      maxTransactions: 4,
      contractions: [0],
    }),
  )
  expect(proposals.length).toBeGreaterThan(0)
  for (const proposal of proposals) {
    expect(proposal.traces[1]).toEqual(traces[1])
    expect(proposal.traces[2]).toEqual(traces[2])
    expect(proposal.retuneNames).toEqual(["A", "P", "N", "C"])
    expectClear(input, proposal.traces)
  }
})

test("work chunks and scratch proposals reproduce exactly after stopping and restarting", () => {
  const traces = [
    trace("A", [
      { x: -4, y: 0 },
      { x: -3, y: -2 },
      { x: 3, y: -2 },
      { x: 4, y: 0 },
    ]),
  ]
  const input = fixture(traces)
  const options = { maxTargets: 1, maxTransactions: 4, contractions: [0, 0.25] }
  const first = drain(searchAnytimeTopology(input, traces, options))
  const second = drain(searchAnytimeTopology(input, traces, options))
  expect(second).toEqual(first)
  const generator = searchAnytimeTopology(input, traces, options)
  generator.next()
  generator.return(undefined)
  expect(drain(searchAnytimeTopology(input, traces, options))).toEqual(first)
})
