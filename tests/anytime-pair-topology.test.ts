import { expect, test } from "bun:test"
import { pairTopologyCandidates } from "../lib/anytime-pair-topology"
import { offsetPath } from "../lib/coupled-pair-routing"
import { length } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { routeCopper, VectorScene } from "../lib/vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

function fixture(): { input: SimpleRouteJson; traces: Trace[] } {
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
  const traces = [-0.11, 0.11].map((offset, side): Trace => {
    const middle = offsetPath(center, offset)
    const points = [{ x: -1, y: offset }, ...middle, { x: 11, y: offset }]
    return {
      type: "pcb_trace",
      pcb_trace_id: `pair-${side}`,
      connection_name: `rail${side}`,
      source_trace_id: `source${side}`,
      route: points.map(
        (p): Wire => ({
          ...p,
          route_type: "wire",
          layer: "top",
          width: 0.1,
        }),
      ),
      coupledSection: [1, middle.length],
      curvedSegments: [1, 3, middle.length + 1],
    }
  })
  traces.push({
    type: "pcb_trace",
    pcb_trace_id: "unrelated",
    connection_name: "unrelated",
    route: [0, 10].map((x) => ({
      route_type: "wire",
      x,
      y: 1,
      layer: "top",
      width: 0.1,
    })),
  })
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    bounds: { minX: -2, maxX: 12, minY: -6, maxY: 2 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      source_trace_id: t.source_trace_id,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
    differentialPairs: [
      {
        connectionNames: ["rail0", "rail1"],
        traceGap: 0.12,
        lengthTolerance: 0.001,
      },
    ],
  }
  return { input, traces }
}

test("paired centerline topology reclaims a boundary detour while preserving strict rail spacing and approaches", () => {
  const { input, traces } = fixture()
  const untouched = structuredClone({ input, traces })
  const work = [...pairTopologyCandidates(input, traces, { maxCandidates: 2 })]
  expect(work).toHaveLength(2)
  expect(work[0]).toBeUndefined()
  const candidate = work[1]!
  expect(candidate).toBeDefined()
  expect(candidate[2]).toBe(traces[2])
  expect(length(candidate[0].route) + length(candidate[1].route)).toBeLessThan(
    0.7 * (length(traces[0].route) + length(traces[1].route)),
  )
  const report = sharedPairSpacingReports(input, candidate)[0]
  expect(report.matched).toBe(true)
  expect(report.minEdgeGapMm).toBeCloseTo(0.12, 8)
  expect(report.maxEdgeGapMm).toBeCloseTo(0.12, 8)
  expect(routeAnglesAreConventional(candidate)).toBe(true)
  const copper = candidate.flatMap(routeCopper)
  for (const [side, rail] of candidate.slice(0, 2).entries()) {
    expect(rail.route[0]).toEqual(traces[side].route[0])
    expect(rail.route[1]).toEqual(traces[side].route[1])
    expect(rail.route.at(-2)).toEqual(traces[side].route.at(-2))
    expect(rail.route.at(-1)).toEqual(traces[side].route.at(-1))
    expect(rail.coupledSection).toEqual([1, 2])
    expect(rail.curvedSegments).toEqual([1, 3])
    expect(rail.source_trace_id).toBe(traces[side].source_trace_id)
    expect(
      rail.route.every(
        (p) => p.route_type === "wire" && p.width === 0.1 && p.layer === "top",
      ),
    ).toBe(true)
    expect(tuningPathIsSelfClear(rail.route, 0.15)).toBe(true)
    expect(
      new VectorScene(input, input.connections[side], 0.1, copper).pathVisible(
        rail.route,
      ),
    ).toBe(true)
  }
  expect({ input, traces }).toEqual(untouched)
})

test("pair topology exposes bounded work and refuses incomplete paired handoffs", () => {
  const { input, traces } = fixture()
  expect([
    ...pairTopologyCandidates(input, traces, { maxCandidates: 0 }),
  ]).toEqual([])
  expect([
    ...pairTopologyCandidates(input, traces, { maxCandidates: 1 }),
  ]).toEqual([undefined])
  const broken = structuredClone(traces)
  broken[1].route[broken[1].coupledSection![0]].y += 0.02
  expect([
    ...pairTopologyCandidates(input, broken, { maxCandidates: 8 }),
  ]).toEqual([undefined])
})

test("a blocked paired middle corridor yields bounded grid work before an atomic shorter detour", () => {
  const { input, traces } = fixture()
  input.obstacles.push({
    center: { x: 5, y: 0 },
    width: 2,
    height: 3,
    layers: ["top"],
    connectedTo: [],
  })
  const stream = pairTopologyCandidates(input, traces, {
    maxCandidates: 96,
    maxShortcutWindows: 1,
    maxGridWindows: 1,
    maxSearchExpansions: 4000,
    gridSteps: [0.2],
  })
  let chunks = 0,
    candidate: Trace[] | undefined
  try {
    for (const proposal of stream) {
      chunks++
      if (proposal && length(proposal[0].route) < length(traces[0].route) - 1) {
        candidate = proposal
        break
      }
    }
  } finally {
    stream.return(undefined)
  }
  expect(chunks).toBeGreaterThan(2)
  expect(chunks).toBeLessThanOrEqual(96)
  expect(candidate).toBeDefined()
  expect(
    sharedPairSpacingReports(input, candidate!).every((r) => r.matched),
  ).toBe(true)
  expect(routeAnglesAreConventional(candidate!)).toBe(true)
  for (const [side, rail] of candidate!.slice(0, 2).entries()) {
    expect(rail.route[0]).toEqual(traces[side].route[0])
    expect(rail.route[1]).toEqual(traces[side].route[1])
    expect(rail.route.at(-2)).toEqual(traces[side].route.at(-2))
    expect(rail.route.at(-1)).toEqual(traces[side].route.at(-1))
    expect(tuningPathIsSelfClear(rail.route, 0.15)).toBe(true)
  }
})
