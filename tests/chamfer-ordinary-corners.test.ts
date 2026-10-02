import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { chamferOrdinaryCorners } from "../lib/chamfer-ordinary-corners"
import { distance, length } from "../lib/geometry"
import type { SimpleRouteJson, Trace } from "../lib/types"

const trace = (name: string, points: number[][], width = 0.1): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  route: points.map(([x, y]) => ({
    route_type: "wire",
    x,
    y,
    layer: "bottom",
    width,
  })),
})
const inputFor = (traces: Trace[]): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  bounds: { minX: -4, maxX: 8, minY: -2, maxY: 8 },
  obstacles: [],
  connections: traces.map((t) => ({
    name: t.connection_name!,
    pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
      x: p.x,
      y: p.y,
      layer: "bottom",
    })),
  })),
})
const nativeDrc = (input: SimpleRouteJson, traces: Trace[]) =>
  validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: [...(input.traces ?? []), ...traces] },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])

test("ordinary right-angle bends become two clear turns of 45 degrees before matching", () => {
  const routes = [
    trace("D", [
      [0, 0],
      [3, 0],
      [3, 3],
    ]),
  ]
  const input = inputFor(routes)
  const before = structuredClone({ input, routes })
  const next = chamferOrdinaryCorners(input, routes)
  expect(next[0].route).toHaveLength(4)
  expect(next[0].route[1].x).toBeCloseTo(2.85, 12)
  expect(next[0].route[2].y).toBeCloseTo(0.15, 12)
  expect(length(next[0].route)).toBeLessThan(length(routes[0].route))
  expect(next[0].route[0]).toEqual(routes[0].route[0])
  expect(next[0].route.at(-1)).toEqual(routes[0].route.at(-1))
  for (let i = 1; i < next[0].route.length - 1; i++) {
    const [a, b, c] = next[0].route.slice(i - 1, i + 2)
    const dot =
      ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
      (distance(a, b) * distance(b, c))
    expect(dot).toBeCloseTo(Math.SQRT1_2, 10)
  }
  expect(nativeDrc(input, next).valid).toBe(true)
  expect({ input, routes }).toEqual(before)
})

test("a neighboring net forces a smaller continuous-clearance bevel", () => {
  const routes = [
    trace("D", [
      [0, 0],
      [3, 0],
      [3, 3],
    ]),
    trace("Q", [
      [2.8, 0.2],
      [2.8, 1],
    ]),
  ]
  const input = inputFor(routes)
  expect(nativeDrc(input, routes).valid).toBe(true)
  const next = chamferOrdinaryCorners(input, routes)
  expect(next[0].route[1].x).toBeCloseTo(2.925, 12)
  expect(next[0].route[2].y).toBeCloseTo(0.075, 12)
  expect(next[1]).toEqual(routes[1])
  expect(nativeDrc(input, next).issues).toEqual([])
})

test("shared-section boundary chamfers retain the interior and support smaller matching candidates", () => {
  const start = trace("P", [
    [0, 0],
    [2, 0],
    [2, 2],
    [3, 3],
  ])
  start.coupledSection = [1, 3]
  const end = trace("N", [
    [0, -1],
    [2, -1],
    [2, -1.9],
  ])
  end.coupledSection = [0, 1]
  const input = inputFor([start, end])
  const next = chamferOrdinaryCorners(input, [start, end], [], 0.75)
  expect(next[0].coupledSection).toEqual([2, 4])
  expect(next[0].route[2].y).toBeCloseTo(0.075, 12)
  expect(next[0].route.slice(3)).toEqual(start.route.slice(2))
  expect(next[1].coupledSection).toEqual([0, 1])
  expect(next[1].route[1].x).toBeCloseTo(1.925, 12)
  expect(next[1].route[1].y).toBe(-1)
  expect(nativeDrc(input, next).issues).toEqual([])
})

test("fixed power through-vias obstruct bevels and remain immutable", () => {
  const routes = [
    trace(
      "D",
      [
        [0, 0],
        [3, 0],
        [3, 3],
      ],
      0.2,
    ),
  ]
  const input = inputFor(routes)
  const power: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "fixed_power",
    connection_name: "VCC",
    route: [
      { route_type: "wire", x: 2.65, y: 0.35, layer: "top", width: 0.1 },
      {
        route_type: "via",
        x: 2.65,
        y: 0.35,
        from_layer: "top",
        to_layer: "bottom",
        layers: ["top", "bottom"],
        via_diameter: 0.3,
        via_hole_diameter: 0.15,
      },
      { route_type: "wire", x: 2.65, y: 0.35, layer: "bottom", width: 0.1 },
    ],
  }
  input.traces = [power]
  input.connections.push({ name: "VCC", pointsToConnect: [] })
  const before = structuredClone(input)
  expect(nativeDrc(input, routes).valid).toBe(true)
  const next = chamferOrdinaryCorners(input, routes)
  expect(next[0].route[1].x).toBeCloseTo(2.85, 12)
  expect(next[0].route[2].y).toBeCloseTo(0.15, 12)
  expect(nativeDrc(input, next).issues).toEqual([])
  expect(input).toEqual(before)
})

test("bevel insertion remaps future curves and shared-section indices without changing their interior", () => {
  const routed = trace("D", [
    [-3, 0],
    [0, 0],
    [0, 3],
    [1, 4],
    [2, 4.5],
    [3, 4.8],
  ])
  routed.coupledSection = [2, 3]
  routed.curvedSegments = [4, 5]
  const before = structuredClone(routed)
  const next = chamferOrdinaryCorners(inputFor([routed]), [routed])[0]
  expect(next.coupledSection).toEqual([3, 4])
  expect(next.curvedSegments).toEqual([5, 6])
  expect(next.route.slice(3)).toEqual(before.route.slice(2))
  expect(routed).toEqual(before)
  const shared = trace("P", [
    [0, 0],
    [3, 0],
    [3, 3],
    [6, 3],
  ])
  shared.coupledSection = [0, 3]
  expect(chamferOrdinaryCorners(inputFor([shared]), [shared])).toEqual([shared])
  const curvedCorner = trace("C", [
    [0, 0],
    [3, 0],
    [3, 3],
  ])
  curvedCorner.curvedSegments = [1]
  expect(
    chamferOrdinaryCorners(inputFor([curvedCorner]), [curvedCorner]),
  ).toEqual([curvedCorner])
})
