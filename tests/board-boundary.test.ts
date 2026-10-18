import { expect, test } from "bun:test"
import {
  BoardBoundary,
  BusLanesSolver,
  boardBoundaryReports,
  type Point,
  type SimpleRouteJson,
  type Trace,
} from "../lib"
import { segmentDistance } from "../lib/geometry"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene } from "../lib/vector-scene"

const notchedBoard = (): SimpleRouteJson => ({
  layerCount: 4,
  minTraceWidth: 0.2,
  minBoardEdgeClearance: 0.2,
  bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
  outline: [
    { x: -5, y: -5 },
    { x: 5, y: -5 },
    { x: 5, y: 5 },
    { x: 1, y: 5 },
    { x: 1, y: -1 },
    { x: -1, y: -1 },
    { x: -1, y: 5 },
    { x: -5, y: 5 },
  ],
  obstacles: [],
  connections: [
    {
      name: "across-notch",
      pointsToConnect: [
        { x: -3, y: 3, layer: "top" },
        { x: 3, y: 3, layer: "top" },
      ],
    },
  ],
})

function auditNotchRoute(input: SimpleRouteJson, route: Point[]) {
  expect(Math.min(...route.map((p) => p.y))).toBeLessThanOrEqual(-1.3 + 1e-8)
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1],
      b = route[i]
    for (let j = 0; j < input.outline!.length; j++)
      expect(
        segmentDistance(
          [a, b],
          [input.outline![j], input.outline![(j + 1) % input.outline!.length]],
        ),
      ).toBeGreaterThanOrEqual(0.3 - 1e-8)
    // The open rectangle is absent PCB material. Check its analytic crossings,
    // independently of the polygon containment implementation.
    for (const x of [-0.9, 0, 0.9]) {
      const t = (x - a.x) / (b.x - a.x)
      if (t >= 0 && t <= 1)
        expect(a.y + (b.y - a.y) * t).toBeLessThanOrEqual(-1.3 + 1e-8)
    }
  }
}

test("vector search detours around a concave board cutout without changing its outline", () => {
  for (const reverse of [false, true]) {
    const input = notchedBoard()
    if (reverse) input.outline!.reverse()
    const before = JSON.stringify(input)
    const solver = new BusLanesSolver(input)
    solver.solve()
    expect(solver.solved).toBe(true)
    expect(JSON.stringify(input)).toBe(before)
    auditNotchRoute(input, solver.traces[0].route)
  }
})

test("grid occupancy and edges cannot take a shortcut through a board cutout", () => {
  const input = notchedBoard()
  const connection = input.connections[0]
  const scene = new VectorScene(input, connection, input.minTraceWidth, [])
  const search = new GridVisibilitySearch(
    scene,
    connection.pointsToConnect[0],
    connection.pointsToConnect[1],
    [],
    4,
    undefined,
    { step: 0.2 },
  )
  for (let i = 0; i < 100000 && !search.solved && !search.failed; i++)
    search.step()
  expect(search.solved).toBe(true)
  auditNotchRoute(input, search.result)
})

test("wire radius, via lands and clearance use the diagonal outline rather than its bounds", () => {
  const input = notchedBoard()
  input.outline = [
    { x: -5, y: -5 },
    { x: 5, y: -5 },
    { x: 5, y: 1 },
    { x: 1, y: 5 },
    { x: -5, y: 5 },
  ]
  const boundary = new BoardBoundary(input)
  expect(
    boundary.containsSegment({ x: 2.9, y: 2.9 }, { x: 2.9, y: 2.9 }, 0.1),
  ).toBe(false)
  expect(
    boundary.containsSegment({ x: 2.7, y: 2.7 }, { x: 2.7, y: 2.7 }, 0.1),
  ).toBe(true)
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "near-diagonal",
    route: [
      { route_type: "wire", x: 2, y: 2, layer: "top", width: 0.2 },
      { route_type: "wire", x: 2.7, y: 2.7, layer: "top", width: 0.2 },
    ],
  }
  expect(boardBoundaryReports(input, [trace]).valid).toBe(true)
  trace.route.push({
    route_type: "via",
    x: 2.7,
    y: 2.7,
    from_layer: "top",
    to_layer: "bottom",
    via_diameter: 1,
  })
  const report = boardBoundaryReports(input, [trace])
  expect(report.valid).toBe(false)
  expect(report.issues.some((issue) => issue.kind === "via")).toBe(true)
})

test("independent acceptance rejects a segment with two interior endpoints crossing a cutout", () => {
  const input = notchedBoard()
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "cutout-shortcut",
    route: input.connections[0].pointsToConnect.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.2,
    })),
  }
  const report = boardBoundaryReports(input, [trace])
  expect(report.valid).toBe(false)
  expect(report.issues.map((issue) => issue.kind)).toEqual(["segment"])
})

test("malformed outlines fail before routing and a repeated closing vertex is supported", () => {
  for (const outline of [
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ],
    [
      { x: -2, y: -2 },
      { x: 2, y: 2 },
      { x: -2, y: 2 },
      { x: 2, y: -2 },
    ],
    [
      { x: 0, y: 0 },
      { x: Number.NaN, y: 1 },
      { x: 1, y: 0 },
    ],
  ]) {
    const solver = new BusLanesSolver({ ...notchedBoard(), outline })
    solver.solve()
    expect(solver.failed).toBe(true)
    expect(solver.traces).toHaveLength(0)
  }
  const input = notchedBoard()
  input.outline!.push({ ...input.outline![0] })
  const solver = new BusLanesSolver(input)
  solver.solve()
  expect(solver.solved).toBe(true)
})
