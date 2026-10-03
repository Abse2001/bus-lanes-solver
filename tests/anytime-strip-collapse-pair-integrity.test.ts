import { expect, test } from "bun:test"
import { AnytimeBusLanesSolver } from "../lib/anytime-bus-lanes-solver"
import { scoreAnytimeRoutes } from "../lib/anytime-score"
import { stripCollapseCandidates } from "../lib/anytime-strip-collapse"
import { recoverAnytimeSkeleton } from "../lib/anytime-skeleton"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { offsetPath } from "../lib/coupled-pair-routing"
import { length } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { roundedPairedLobes } from "../lib/smooth-tuning"
import { routeCopper, VectorScene } from "../lib/vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

test("cumulative orthogonal strip cuts preserve both curved rails and accepted bank capacity", () => {
  const center: Point[] = [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -2, y: 1 },
    { x: -4.5, y: 1 },
    { x: -5, y: 1.5 },
    { x: -5, y: 10.5 },
    { x: -4.5, y: 11 },
    { x: -2, y: 11 },
    { x: -1, y: 10 },
    { x: -1, y: 7 },
    { x: 0, y: 6 },
    { x: 10, y: 6 },
  ]
  const banks = roundedPairedLobes(
    { x: 1, y: 6 },
    { x: 9, y: 6 },
    0.22,
    4,
    2,
    -1,
    0.12,
  )!
  const traces: Trace[] = [0.11, -0.11].map((offset, side) => {
    const ordinary = offsetPath(center, offset)
    const points = [...ordinary.slice(0, -1), ...banks[side], ordinary.at(-1)!]
    return {
      type: "pcb_trace",
      pcb_trace_id: `pair${side}`,
      connection_name: `pair${side}`,
      route: points.map(
        (p): Wire => ({ ...p, route_type: "wire", width: 0.1, layer: "top" }),
      ),
      coupledSection: [0, points.length - 1],
      curvedSegments: points.slice(1).flatMap((p, i) => {
        const dx = Math.abs(p.x - points[i].x),
          dy = Math.abs(p.y - points[i].y)
        return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8
          ? [i + 1]
          : []
      }),
    }
  })
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -12, maxX: 20, minY: -3, maxY: 15 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
    differentialPairs: [
      {
        connectionNames: ["pair0", "pair1"],
        traceGap: 0.12,
        lengthTolerance: 1,
      },
    ],
  }
  const unchanged = structuredClone({ input, traces })
  const beforeBanks = recoverAnytimeSkeleton(input, traces).banks
  const proposal = [
    ...stripCollapseCandidates(input, traces, { maxCandidates: 1 }),
  ].find(Boolean)!
  expect(proposal).toBeDefined()
  expect(new Set(proposal.operations.map((op) => op.axis))).toEqual(
    new Set(["x", "y"]),
  )
  expect(proposal.changedNames).toEqual(["pair0", "pair1"])
  expect(routeAnglesAreConventional(proposal.traces)).toBe(true)
  const gap = sharedPairSpacingReports(input, proposal.traces)[0]
  expect(gap.matched).toBe(true)
  expect(gap.minEdgeGapMm).toBeGreaterThan(0.118)
  const conflict = new CopperConflictIndex().firstConflict(
    routeCopper(proposal.traces[0]),
    routeCopper(proposal.traces[1]),
    0.118,
  )
  expect(conflict).toBeUndefined()
  const afterBanks = recoverAnytimeSkeleton(input, proposal.traces).banks
  expect(beforeBanks).toHaveLength(1)
  expect(afterBanks).toHaveLength(1)
  expect(afterBanks[0].kind).toBe("paired")
  for (const side of [0, 1]) {
    expect(proposal.traces[side].route[0]).toEqual(traces[side].route[0])
    expect(proposal.traces[side].route.at(-1)).toEqual(
      traces[side].route.at(-1),
    )
    expect(proposal.traces[side].coupledSection).toEqual(
      traces[side].coupledSection,
    )
    expect(proposal.traces[side].curvedSegments).toEqual(
      traces[side].curvedSegments,
    )
    expect(tuningPathIsSelfClear(proposal.traces[side].route, 0.175)).toBe(true)
    expect(length(proposal.traces[side].route)).toBeLessThan(
      length(traces[side].route) - 6,
    )
    expect(afterBanks[0].members[side].deficitMm).toBeCloseTo(
      beforeBanks[0].members[side].deficitMm,
      8,
    )
  }
  expect(proposal.transform(traces)).toEqual(proposal.traces)
  expect({ input, traces }).toEqual(unchanged)
})

test("the public incumbent rejects an otherwise valid improving proposal that narrows an accepted pair", () => {
  const center: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: -1 },
    { x: 2, y: -3 },
    { x: 3, y: -4 },
    { x: 7, y: -4 },
    { x: 8, y: -3 },
    { x: 8, y: -1 },
    { x: 9, y: 0 },
    { x: 10, y: 0 },
  ]
  const make = (points: Point[], side: number): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `pair${side}`,
    connection_name: `pair${side}`,
    route: points.map(
      (p): Wire => ({ ...p, route_type: "wire", layer: "top", width: 0.1 }),
    ),
    coupledSection: [0, points.length - 1],
    curvedSegments: [],
  })
  const traces = [-0.11, 0.11].map((offset, side) =>
    make(offsetPath(center, offset), side),
  )
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -2, maxX: 12, minY: -6, maxY: 2 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
    differentialPairs: [
      {
        connectionNames: ["pair0", "pair1"],
        traceGap: 0.12,
        lengthTolerance: 0.1,
      },
    ],
  }
  const narrowed = [
    make(
      [
        { x: 0, y: -0.11 },
        { x: 10, y: -0.11 },
      ],
      0,
    ),
    make(
      [
        { x: 0, y: 0.11 },
        { x: 1, y: 0.11 },
        { x: 1.04, y: 0.07 },
        { x: 8.96, y: 0.07 },
        { x: 9, y: 0.11 },
        { x: 10, y: 0.11 },
      ],
      1,
    ),
  ]
  expect(sharedPairSpacingReports(input, narrowed)[0].matched).toBe(true)
  const allCopper = narrowed.flatMap(routeCopper)
  expect(
    narrowed.every((t, side) =>
      new VectorScene(
        input,
        input.connections[side],
        0.1,
        allCopper,
      ).pathVisible(t.route),
    ),
  ).toBe(true)
  expect(routeAnglesAreConventional(narrowed)).toBe(true)
  expect(scoreAnytimeRoutes(input, narrowed).objective).toBeLessThan(
    scoreAnytimeRoutes(input, traces).objective,
  )
  const solver = AnytimeBusLanesSolver.fromCompleted(input, traces, {
    fanout: "none",
    iterationsPerX: 1,
  })
  const incumbent = solver.getResult()
  // Deliberately inject one valid-shaped scratch proposal at the production
  // acceptance boundary; neighborhood generators need not themselves prove
  // every physical property of the complete bus.
  Object.assign(solver, {
    candidates: (function* () {
      yield narrowed
    })(),
  })
  const result = solver.solve()
  expect(result.status).toBe("valid")
  expect(result.acceptedImprovements).toBe(0)
  expect(solver.stats.proposals).toBe(1)
  expect(solver.stats.validationRejected).toBe(1)
  expect(result.score).toEqual(incumbent.score)
  expect(result.output.traces).toEqual(incumbent.output.traces)
})
