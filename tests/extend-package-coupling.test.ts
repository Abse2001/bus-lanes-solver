import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { expect, test } from "bun:test"
import { extendPackageCoupling } from "../lib/extend-package-coupling"
import { packageApproachRegions } from "../lib/package-approach-regions"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const wire = (x: number, y: number): Wire => ({
  x,
  y,
  layer: "bottom",
  width: 0.1,
  route_type: "wire",
})
const fixture = () => {
  const traces: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "P",
      connection_name: "P",
      coupledSection: [0, 1],
      route: [
        [0, 0],
        [4, 0],
        [8, 0],
        [10, 0],
      ].map(([x, y]) => wire(x, y)),
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "N",
      connection_name: "N",
      coupledSection: [0, 1],
      route: [
        [0, -0.22],
        [4, -0.22],
        [4.78, -1],
        [9.22, -1],
        [10, -0.22],
      ].map(([x, y]) => wire(x, y)),
    },
  ]
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -1, maxX: 12, minY: -3, maxY: 2 },
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
    obstacles: [0, -0.22].map((y, i) => ({
      componentId: "ram",
      center: { x: 10, y },
      width: 0.3,
      height: 0.15,
      layers: ["top"],
      connectedTo: [i ? "N" : "P"],
    })),
    differentialPairs: [
      { connectionNames: ["P", "N"], traceGap: 0.12, lengthTolerance: 2 },
    ],
    buses: [{ busId: "data", connectionNames: ["P", "N"], maxLengthSkew: 2 }],
  }
  return { input, traces }
}
const run = (input: SimpleRouteJson, traces: Trace[]) => {
  const generator = extendPackageCoupling(input, traces)
  let step = generator.next(),
    iterations = 0
  while (!step.done && iterations++ < 3000) step = generator.next()
  expect(step.done).toBe(true)
  return step.value as Trace[]
}

test("pair remains together up to the native package region, with endpoints and matching preserved", () => {
  const { input, traces } = fixture(),
    before = structuredClone({ input, traces })
  const result = run(input, traces)
  expect(result[0].route[result[0].coupledSection![1]].x).toBeGreaterThan(9)
  expect(result[1].route[result[1].coupledSection![1]].x).toBeGreaterThan(9)
  expect(routeAnglesAreConventional(result)).toBe(true)
  expect(sharedPairSpacingReports(input, result).every((r) => r.matched)).toBe(
    true,
  )
  expect(
    [
      ...busLengthReports(input, result),
      ...pairLengthReports(input, result),
    ].every((r) => r.matched),
  ).toBe(true)
  for (let i = 0; i < 2; i++) {
    expect(result[i].route[0]).toEqual(traces[i].route[0])
    expect(result[i].route.at(-1)).toEqual(traces[i].route.at(-1))
  }
  expect({ input, traces }).toEqual(before)
})

test("local native fanout vias extend the region, but an interconnect does not", () => {
  const { input } = fixture()
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "dogbone",
      route: [
        wire(10, 0),
        {
          route_type: "via",
          x: 9.7,
          y: 0.3,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.3,
        },
      ],
    },
  ]
  const regions = packageApproachRegions(input, 0.15)
  expect(regions[0].copper.minX).toBeCloseTo(9.4, 10)
  expect(regions[0].copper.maxY).toBeCloseTo(0.6, 10)
  const localVia = input.traces[0].route[1]
  input.traces[0].route[1] = { ...localVia, x: -20 }
  expect(packageApproachRegions(input, 0.15)[0].copper.minX).toBeCloseTo(
    9.7,
    10,
  )
  input.traces[0].route[1] = localVia
  input.traces[0].route.push({
    route_type: "via",
    x: -20,
    y: 0,
    from_layer: "bottom",
    to_layer: "top",
  })
  expect(packageApproachRegions(input, 0.15)[0].copper.minX).toBeCloseTo(
    9.7,
    10,
  )
})

test("missing native package regions cannot silently redefine the paired corridor", () => {
  const { input, traces } = fixture()
  input.obstacles = []
  expect(run(input, traces)).toEqual(traces)
})

test("source package approaches use the same coupling repair in reverse", () => {
  const { input, traces } = fixture()
  const reversed = traces.map((t) => ({
    ...t,
    route: t.route.toReversed(),
    coupledSection: [
      t.route.length - 1 - t.coupledSection![1],
      t.route.length - 1 - t.coupledSection![0],
    ] as [number, number],
  }))
  input.connections = reversed.map((t) => ({
    name: t.connection_name!,
    pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
  }))
  const result = run(input, reversed)
  for (let i = 0; i < 2; i++) {
    expect(result[i].route[result[i].coupledSection![0]].x).toBeGreaterThan(9)
    expect(result[i].route[0]).toEqual(reversed[i].route[0])
    expect(result[i].route.at(-1)).toEqual(reversed[i].route.at(-1))
  }
  expect(sharedPairSpacingReports(input, result).every((r) => r.matched)).toBe(
    true,
  )
})

test("fixed copper can prevent an extension without moving or removing that copper", () => {
  const { input, traces } = fixture()
  input.obstacles.push(
    ...[-0.22, -0.78].map((y) => ({
      center: { x: 6, y },
      width: 0.5,
      height: 0.02,
      layers: ["bottom"],
      connectedTo: ["fixed"],
    })),
  )
  const before = structuredClone(input)
  expect(run(input, traces)).toEqual(traces)
  expect(input).toEqual(before)
})

test("the exterior audit rejects a separated trunk even if its declared shared section passes", () => {
  const { input, traces } = fixture()
  input.obstacles.push(
    ...[0, -0.22].map((y, i) => ({
      componentId: "cpu",
      center: { x: 0, y },
      width: 0.3,
      height: 0.15,
      layers: ["top"],
      connectedTo: [i ? "N" : "P"],
    })),
  )
  expect(sharedPairSpacingReports(input, traces)[0].matched).toBe(true)
  expect(exteriorPairSpacingReports(input, traces)[0]).toMatchObject({
    applicable: true,
    matched: false,
  })
  expect(
    exteriorPairSpacingReports(input, traces)[0].separatedExteriorLengthMm,
  ).toBeGreaterThan(5)
  const result = run(input, traces)
  expect(exteriorPairSpacingReports(input, result)[0]).toMatchObject({
    applicable: true,
    matched: true,
    separatedExteriorLengthMm: 0,
  })
})

test("simplification preserves a collinear shared-section start", () => {
  const { input, traces } = fixture()
  for (const t of traces) {
    const first = t.route[0] as Wire
    t.route.splice(1, 0, { ...first, x: 1 })
    t.coupledSection = [1, 2]
  }
  const result = run(input, traces)
  for (const t of result) {
    expect(t.coupledSection![0]).toBeGreaterThanOrEqual(0)
    expect(t.route[t.coupledSection![0]].x).toBe(1)
    expect(t.route[t.coupledSection![1]].x).toBeGreaterThan(9)
  }
  expect(sharedPairSpacingReports(input, result).every((r) => r.matched)).toBe(
    true,
  )
})

test("repair stays local when another approach still needs corner cleanup", () => {
  const { input, traces } = fixture()
  const other: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "other",
    connection_name: "other",
    route: [wire(1, 1.5), wire(2, 1.5), wire(2, 1.8)],
  }
  input.connections.push({
    name: "other",
    pointsToConnect: [other.route[0], other.route.at(-1)!] as Wire[],
  })
  const before = structuredClone(other)
  const result = run(input, [...traces, other])
  expect(result[0].route[result[0].coupledSection![1]].x).toBeGreaterThan(9)
  expect(result[2]).toBe(other)
  expect(other).toEqual(before)
  expect(routeAnglesAreConventional(result.slice(0, 2))).toBe(true)
})
