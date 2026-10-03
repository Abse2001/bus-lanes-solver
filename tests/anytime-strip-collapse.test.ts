import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { stripCollapseCandidates } from "../lib/anytime-strip-collapse"
import { offsetPath } from "../lib/coupled-pair-routing"
import { length } from "../lib/geometry"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

const detour: Point[] = [
  { x: 0, y: 0 },
  { x: -1, y: 0 },
  { x: -2, y: 1 },
  { x: -4.5, y: 1 },
  { x: -5, y: 1.5 },
  { x: -5, y: 4.5 },
  { x: -4.5, y: 5 },
  { x: -2, y: 5 },
  { x: -1, y: 6 },
  { x: 10, y: 6 },
]

function trace(name: string, points = detour, layer = "top"): Trace {
  return {
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    route: points.map((p) => ({ ...p, route_type: "wire", layer, width: 0.1 })),
    curvedSegments: [],
  }
}
function input(traces: Trace[]): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -12, maxX: 20, minY: -10, maxY: 20 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
  }
}
function first(board: SimpleRouteJson, traces: Trace[]) {
  for (const candidate of stripCollapseCandidates(board, traces))
    if (candidate) return candidate
  throw Error("No empty outer strip")
}

test("an empty outer strip collapses a detour without changing headings, handoffs, or indices", () => {
  const original = trace("signal"),
    before = structuredClone(original),
    board = input([original]),
    candidate = first(board, [original]),
    after = candidate.traces[0]
  expect(candidate.changedNames).toEqual(["signal"])
  expect(length(after.route)).toBeLessThan(length(original.route) - 4)
  expect(candidate.estimatedLayerAreaSavingMm2).toBeGreaterThan(10)
  expect(routeAnglesAreConventional(candidate.traces)).toBe(true)
  expect(after.route[0]).toEqual(original.route[0])
  expect(after.route.at(-1)).toEqual(original.route.at(-1))
  expect(after.route).toHaveLength(original.route.length)
  expect(after.curvedSegments).toEqual(original.curvedSegments)
  expect(candidate.transform([original])).toEqual(candidate.traces)
  const validator = BusLanesSolver.forValidation(board, candidate.traces, {
    smoothTuning: true,
  })
  validator.solve()
  expect(validator.solved).toBe(true)
  expect(original).toEqual(before)
})

test("both rails move atomically and preserve the shared gap", () => {
  const rails = [-0.11, 0.11].map((offset, i) => {
    const t = trace(`p${i}`, offsetPath(detour, offset))
    t.coupledSection = [0, t.route.length - 1]
    return t
  })
  const board = input(rails)
  board.differentialPairs = [
    { connectionNames: ["p0", "p1"], traceGap: 0.12, lengthTolerance: 1 },
  ]
  const candidate = first(board, rails)
  expect(candidate.changedNames).toEqual(["p0", "p1"])
  expect(
    sharedPairSpacingReports(board, candidate.traces).every((r) => r.matched),
  ).toBe(true)
  for (let i = 0; i < 2; i++) {
    expect(candidate.traces[i].coupledSection).toEqual(rails[i].coupledSection)
    expect(candidate.traces[i].route[0]).toEqual(rails[i].route[0])
    expect(candidate.traces[i].route.at(-1)).toEqual(rails[i].route.at(-1))
  }
})

test("fixed copper and rotated obstacle envelopes are stationary strip anchors", () => {
  const original = trace("signal"),
    board = input([original]),
    fixed = trace("power", [
      { x: -8, y: 10 },
      { x: -7, y: 10 },
    ])
  fixed.source_trace_id = "power-source"
  board.traces = [fixed]
  board.obstacles = [
    {
      center: { x: -6, y: 3 },
      width: 2,
      height: 1,
      ccwRotationDegrees: 45,
      layers: ["top"],
      connectedTo: [],
    },
  ]
  const before = structuredClone(board)
  expect([...stripCollapseCandidates(board, [original])].every((p) => !p)).toBe(
    true,
  )
  expect(board).toEqual(before)
})

test("via joins anchor every adjacent wire run and the transform leaves vias fixed", () => {
  const original = trace("signal")
  original.route = [
    { route_type: "wire", x: -5, y: -1, layer: "bottom", width: 0.1 },
    { route_type: "wire", x: -5, y: 0, layer: "bottom", width: 0.1 },
    {
      route_type: "via",
      x: -5,
      y: 0,
      from_layer: "bottom",
      to_layer: "top",
      via_diameter: 0.3,
    },
    ...original.route.map((p) => ({ ...p, x: p.x - 5 })),
  ]
  const board = input([original]),
    before = structuredClone(original),
    candidate = first(board, [original])
  expect(candidate.traces[0].route.slice(0, 4)).toEqual(
    original.route.slice(0, 4),
  )
  expect(candidate.traces[0].route.at(-1)).toEqual(original.route.at(-1))
  expect(original).toEqual(before)
})

test("diagonal or annotated curved crossings are not squeezed into a new heading", () => {
  const diagonal = trace("signal", [
      { x: 0, y: 0 },
      { x: -5, y: 5 },
      { x: 0, y: 10 },
    ]),
    board = input([diagonal])
  expect([...stripCollapseCandidates(board, [diagonal])].every((p) => !p)).toBe(
    true,
  )
  const annotated = trace("signal")
  annotated.curvedSegments = [3, 7]
  for (const candidate of stripCollapseCandidates(input([annotated]), [
    annotated,
  ])) {
    if (!candidate) continue
    expect(candidate.traces[0].curvedSegments).toEqual([3, 7])
    for (const ending of [3, 7])
      expect(
        length(candidate.traces[0].route.slice(ending - 1, ending + 1)),
      ).toBeCloseTo(length(annotated.route.slice(ending - 1, ending + 1)), 8)
  }
})

test("compatible layer collapses combine into one global envelope transaction", () => {
  const originals = [trace("top"), trace("bottom", detour, "bottom")],
    candidate = first(input(originals), originals)
  expect(new Set(candidate.operations.map((o) => o.layer))).toEqual(
    new Set(["top", "bottom"]),
  )
  expect(candidate.changedNames).toEqual(["top", "bottom"])
  for (const t of candidate.traces)
    expect(Math.min(...t.route.map((p) => p.x))).toBeGreaterThan(-3)
  expect(candidate.estimatedLayerAreaSavingMm2).toBeGreaterThan(20)
})

test("direction subsets retain a matching driver's opposite outer bank", () => {
  const subdivided = detour.flatMap((p, i) =>
      i === 3
        ? [{ x: -2.5, y: 1 }, { x: -3.5, y: 1 }, p]
        : i === 7
          ? [{ x: -3.5, y: 5 }, { x: -2.5, y: 5 }, p]
          : [p],
    ),
    originals = [
      trace("left", subdivided),
      trace(
        "right",
        subdivided.map((p) => ({ x: 10 - p.x, y: p.y })),
        "bottom",
      ),
    ],
    proposals = [
      ...stripCollapseCandidates(input(originals), originals),
    ].filter((p) => p !== undefined),
    partial = proposals.find(
      (p) =>
        p.operations.length > 1 &&
        p.operations.every((op) => op.axis === "x" && op.side === "minimum"),
    )
  expect(partial).toBeDefined()
  expect(partial!.changedNames).toEqual(["left"])
  expect(partial!.traces[1]).toBe(originals[1])
  expect(length(partial!.traces[0].route)).toBeLessThan(
    length(originals[0].route) - 3,
  )
  expect(routeAnglesAreConventional(partial!.traces)).toBe(true)
})
