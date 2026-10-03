import { expect, test } from "bun:test"
import { compactTuningCandidates } from "../lib/anytime-candidates"
import { distance, length, simplify } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { roundedPairedLobes, roundedTuningLobes } from "../lib/smooth-tuning"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"

function bankTrace(angle = 0, side = 1): Trace {
  const at = (x: number, y: number): Point => ({
    x: 3 + x * Math.cos(angle) - y * Math.sin(angle),
    y: -2 + x * Math.sin(angle) + y * Math.cos(angle),
  })
  const points = simplify([
    at(0, 0),
    ...roundedTuningLobes(at(1, 0), at(9, 0), 8, 2, side, 0.12)!,
    at(10, 0),
  ])
  return {
    type: "pcb_trace",
    pcb_trace_id: "D",
    connection_name: "D",
    curvedSegments: points.slice(1).flatMap((p, i) => {
      const dx = Math.abs(p.x - points[i].x),
        dy = Math.abs(p.y - points[i].y)
      return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8 ? [i + 1] : []
    }),
    route: points.map((p) => ({
      ...p,
      route_type: "wire",
      layer: "top",
      width: 0.1,
    })),
  }
}

function board(traces: Trace[]): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
  }
}

function excursion(t: Trace) {
  const a = t.route[0],
    b = t.route.at(-1)!,
    span = distance(a, b)
  return Math.max(
    ...t.route.map((p) =>
      Math.abs(((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / span),
    ),
  )
}

test("compact banks preserve total length and handoffs under rotation and reflection", () => {
  for (const angle of [0, Math.PI / 4, Math.PI / 2])
    for (const side of [-1, 1]) {
      const original = bankTrace(angle, side),
        input = board([original]),
        before = structuredClone({ input, original })
      const candidates = [
        ...compactTuningCandidates(input, [original], {
          maxCandidates: 4,
          lengthScales: [1],
        }),
      ].filter((t): t is Trace[] => !!t)
      expect(candidates.length).toBeGreaterThan(0)
      const compact = candidates[0][0]
      expect(excursion(compact)).toBeLessThan(excursion(original) / 2)
      expect(length(compact.route)).toBeCloseTo(length(original.route), 7)
      expect(compact.route[0]).toEqual(original.route[0])
      expect(compact.route.at(-1)).toEqual(original.route.at(-1))
      expect(routeAnglesAreConventional([compact])).toBe(true)
      expect(tuningPathIsSelfClear(compact.route, 0.175)).toBe(true)
      expect({ input, original }).toEqual(before)
    }
})

test("trial rejections yield control and other copper stays clear", () => {
  const original = bankTrace(),
    other: Trace = {
      type: "pcb_trace",
      pcb_trace_id: "neighbor",
      connection_name: "neighbor",
      route: [
        { route_type: "wire", x: 3, y: -2.25, layer: "top", width: 0.1 },
        { route_type: "wire", x: 13, y: -2.25, layer: "top", width: 0.1 },
      ],
    },
    input = board([original, other])
  const candidates = [
    ...compactTuningCandidates(input, [original, other], {
      maxCandidates: 16,
      lengthScales: [1],
    }),
  ]
  // Two discovery steps and sixteen trials, including blocked mirrored banks.
  expect(candidates).toHaveLength(18)
  expect(candidates.some((t) => t === undefined)).toBe(true)
  const valid = candidates.filter((t): t is Trace[] => !!t)
  expect(valid.length).toBeGreaterThan(0)
  for (const result of valid) {
    expect(result[1]).toEqual(other)
    expect(length(result[0].route)).toBeCloseTo(length(original.route), 7)
    expect(
      new VectorScene(input, input.connections[0], 0.1, [
        ...fixedCopper(input),
        ...result.flatMap(routeCopper),
      ]).pathVisible(result[0].route),
    ).toBe(true)
  }
})

test("independent bank replacement reindexes and preserves the shared pair corridor", () => {
  const original = bankTrace()
  original.route.push(
    { route_type: "wire", x: 14, y: -2, layer: "top", width: 0.1 },
    { route_type: "wire", x: 16, y: -2, layer: "top", width: 0.1 },
  )
  original.coupledSection = [
    original.route.length - 2,
    original.route.length - 1,
  ]
  const input = board([original])
  const candidates = [
    ...compactTuningCandidates(input, [original], {
      maxCandidates: 4,
      lengthScales: [1],
    }),
  ].filter((t): t is Trace[] => !!t)
  expect(candidates.length).toBeGreaterThan(0)
  for (const [compact] of candidates) {
    const section = compact.coupledSection!
    expect(compact.route.slice(section[0], section[1] + 1)).toEqual(
      original.route.slice(
        original.coupledSection[0],
        original.coupledSection[1] + 1,
      ),
    )
  }
  original.coupledSection = [0, original.route.length - 1]
  expect(
    [
      ...compactTuningCandidates(input, [original], { maxCandidates: 4 }),
    ].filter(Boolean),
  ).toHaveLength(0)
})

test("shorter alternatives reduce excess length for the caller's matching validator", () => {
  const original = bankTrace(),
    input = board([original])
  const candidates = [
    ...compactTuningCandidates(input, [original], {
      maxCandidates: 4,
      lengthScales: [0.95],
    }),
  ].filter((t): t is Trace[] => !!t)
  expect(candidates.length).toBeGreaterThan(0)
  for (const [compact] of candidates)
    expect(length(compact.route)).toBeCloseTo(length(original.route) - 0.4, 7)
})

test("shared banks compact both offset rails atomically while retaining coupling", () => {
  const waves = roundedPairedLobes(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    0.22,
    8,
    2,
    1,
    0.12,
  )!
  const traces: Trace[] = waves.map((points, k) => ({
    type: "pcb_trace",
    pcb_trace_id: `pair${k}`,
    connection_name: `pair${k}`,
    coupledSection: [0, points.length - 1],
    curvedSegments: points.slice(1).flatMap((p, i) => {
      const dx = Math.abs(p.x - points[i].x),
        dy = Math.abs(p.y - points[i].y)
      return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8 ? [i + 1] : []
    }),
    route: points.map((p) => ({
      ...p,
      route_type: "wire",
      layer: "top",
      width: 0.1,
    })),
  }))
  const input = board(traces)
  input.differentialPairs = [
    {
      connectionNames: ["pair0", "pair1"],
      traceGap: 0.12,
      lengthTolerance: 0.001,
    },
  ]
  const candidates = [
    ...compactTuningCandidates(input, traces, {
      maxCandidates: 4,
      lengthScales: [1],
    }),
  ].filter((t): t is Trace[] => !!t)
  expect(candidates.length).toBeGreaterThan(0)
  const first = candidates[0]
  for (const [k, compact] of first.entries()) {
    expect(excursion(compact)).toBeLessThan(excursion(traces[k]) / 2)
    expect(length(compact.route)).toBeCloseTo(18, 7)
    expect(compact.route[0]).toEqual(traces[k].route[0])
    expect(compact.route.at(-1)).toEqual(traces[k].route.at(-1))
    expect(compact.coupledSection).toEqual([0, compact.route.length - 1])
    expect(
      new VectorScene(
        input,
        input.connections[k],
        0.1,
        first.flatMap(routeCopper),
      ).pathVisible(compact.route),
    ).toBe(true)
  }
  expect(routeAnglesAreConventional(first)).toBe(true)
})
