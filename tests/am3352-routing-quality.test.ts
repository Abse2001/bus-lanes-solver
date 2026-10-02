import { expect, test } from "bun:test"
import type { Point, SimpleRouteJson, Trace } from "../lib"
import { measureAm3352RoutingQuality } from "../scripts/measure-am3352-routing-quality"

const input: SimpleRouteJson = {
  layerCount: 4,
  minTraceWidth: 0.1,
  bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
  connections: [],
  obstacles: [],
}
const trace = (name: string, path: Point[]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  route: [
    { route_type: "wire", ...path[0], layer: "top", width: 0.1 },
    {
      route_type: "via",
      ...path[0],
      from_layer: "top",
      to_layer: "inner1",
    },
    ...path.map((p) => ({
      route_type: "wire" as const,
      ...p,
      layer: "inner1",
      width: 0.1,
    })),
    {
      route_type: "via",
      ...path.at(-1)!,
      from_layer: "inner1",
      to_layer: "top",
    },
    { route_type: "wire", ...path.at(-1)!, layer: "top", width: 0.1 },
  ],
})

test("quality audit measures detours and little turns without an old-layout ceiling", () => {
  const routed = trace("D", [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1.1, y: 0.1 },
    { x: 2.1, y: 0.1 },
  ])
  const quality = measureAm3352RoutingQuality(input, [routed])
  expect(quality.signalCount).toBe(1)
  expect(quality.totalPlanarLengthMm).toBeCloseTo(2 + Math.sqrt(0.02), 10)
  expect(quality.maxDetourRatio).toBeGreaterThan(1)
  expect(quality.ordinaryTurns).toBe(2)
  expect(quality.shortJogs).toBe(1)
  expect(quality.acuteCorners).toBe(0)
  expect(quality.illegalOrdinaryCorners).toBe(0)
  expect(quality.issues).toEqual([])
})

test("quality audit rejects ordinary sharp turns and validates full-route curve indices", () => {
  const corner = trace("D", [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 1 },
  ])
  expect(
    measureAm3352RoutingQuality(input, [corner]).illegalOrdinaryCorners,
  ).toBe(1)
  corner.curvedSegments = [3]
  expect(measureAm3352RoutingQuality(input, [corner]).issues).toContain(
    "D: sharp curved routing geometry",
  )
  const alignedChord = trace("A", [
    { x: 0, y: 0 },
    { x: 1, y: 0.5 },
    { x: 2, y: 1.5 },
    { x: 2.5, y: 2.5 },
  ])
  alignedChord.curvedSegments = [3, 4, 5]
  expect(measureAm3352RoutingQuality(input, [alignedChord]).issues).toEqual([])
  const curve = trace("C", [
    { x: 0, y: 0 },
    { x: 1, y: 0.25 },
    { x: 2, y: 1 },
  ])
  curve.curvedSegments = [3, 4]
  expect(measureAm3352RoutingQuality(input, [curve]).issues).toEqual([])
  curve.curvedSegments = [1, 3, 4]
  expect(measureAm3352RoutingQuality(input, [curve]).issues).toContain(
    "C: invalid curve ending-vertex indices",
  )
  curve.curvedSegments = [3, 3, 4]
  expect(measureAm3352RoutingQuality(input, [curve]).issues).toContain(
    "C: invalid curve ending-vertex indices",
  )
})

test("pair gap audit uses emitted shared sections rather than a fixed endpoint trim", () => {
  const first = trace("P", [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
  ])
  const second = trace("N", [
    { x: 0, y: 0.22 },
    { x: 4, y: 0.22 },
  ])
  first.coupledSection = second.coupledSection = [2, 3]
  const pairInput = {
    ...input,
    differentialPairs: [
      {
        connectionNames: ["P", "N"] as [string, string],
        lengthTolerance: 0.127,
        traceGap: 0.12,
      },
    ],
  }
  const quality = measureAm3352RoutingQuality(pairInput, [first, second])
  expect(quality.issues).toEqual([])
  expect(quality.pairGaps[0].sharedSectionPresent).toBe(true)
  expect(quality.pairGaps[0].minEdgeGapMm).toBeCloseTo(0.12, 10)
  expect(quality.pairGaps[0].maxEdgeGapMm).toBeCloseTo(0.12, 10)
  expect(quality.pairGaps[0].maxSamplingErrorMm).toBeLessThanOrEqual(0.005)
  expect(quality.pairGaps[0].sharedCopperMm).toEqual([4, 4])
  second.coupledSection = [1, 3]
  const invalid = measureAm3352RoutingQuality(pairInput, [first, second])
  expect(invalid.issues).toContain("N: invalid coupled-section indices")
  expect(invalid.pairGaps[0].sharedSectionPresent).toBe(false)
})

test("declared pair coupling cannot pass the audit without two valid shared sections", () => {
  const first = trace("P", [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
  ])
  const second = trace("N", [
    { x: 0, y: 0.22 },
    { x: 4, y: 0.22 },
  ])
  for (const coupling of [{ traceGap: 0.12 }, { maxUncoupledLength: 1 }]) {
    const pairedInput = {
      ...input,
      defaultObstacleMargin: 0.12,
      differentialPairs: [
        {
          connectionNames: ["P", "N"] as [string, string],
          lengthTolerance: 0.127,
          ...coupling,
        },
      ],
    }
    first.coupledSection = [2, 3]
    delete second.coupledSection
    expect(
      measureAm3352RoutingQuality(pairedInput, [first, second]).issues,
    ).toContain("P/N: missing or invalid paired shared section")
    second.coupledSection = [2, 3]
    expect(
      measureAm3352RoutingQuality(pairedInput, [first, second]).issues,
    ).toEqual([])
    second.coupledSection = [3, 20]
    expect(
      measureAm3352RoutingQuality(pairedInput, [first, second]).issues,
    ).toContain("P/N: missing or invalid paired shared section")
  }
  delete second.coupledSection
  expect(
    measureAm3352RoutingQuality(
      {
        ...input,
        differentialPairs: [
          { connectionNames: ["P", "N"], lengthTolerance: 0.127 },
        ],
      },
      [first, second],
    ).issues,
  ).toEqual([])
})

test("pair separation fails even when lengths match and no uncoupled budget was supplied", () => {
  const first = trace("P", [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
  ])
  const second = trace("N", [
    { x: 0, y: 1 },
    { x: 4, y: 1 },
  ])
  first.coupledSection = second.coupledSection = [2, 3]
  const pairedInput: SimpleRouteJson = {
    ...input,
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.127, traceGap: 0.12 },
    ],
  }
  const quality = measureAm3352RoutingQuality(pairedInput, [first, second])
  expect(quality.issues).toContain(
    "P/N: paired shared section exceeds allowed separation",
  )
  expect(quality.pairGaps[0].matched).toBe(false)
})
