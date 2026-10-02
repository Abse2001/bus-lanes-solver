import { expect, test } from "bun:test"
import { offsetPath } from "../lib/coupled-pair-routing"
import { roundCoupledReturnBends } from "../lib/round-coupled-return-bends"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

function fixture(center: Point[]) {
  const traces: Trace[] = [-0.11, 0.11].map((offset, i) => {
    const route = offsetPath(center, offset).map((p) => ({
      ...p,
      route_type: "wire" as const,
      width: 0.1,
      layer: "bottom",
    }))
    return {
      type: "pcb_trace",
      pcb_trace_id: `rail${i}`,
      connection_name: `rail${i}`,
      route,
      coupledSection: [0, route.length - 1],
    }
  })
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as any,
    })),
    differentialPairs: [
      {
        connectionNames: ["rail0", "rail1"],
        lengthTolerance: 0.127,
        traceGap: 0.12,
      },
    ],
  }
  return { input, traces }
}

test("paired return bends stay tangent and coupled across rotations and mirrors", () => {
  for (const base of [
    [
      { x: 3, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0.8 },
      { x: 3, y: 0.8 },
    ],
    [
      { x: 0.69, y: 0.69 },
      { x: 0, y: 0 },
      { x: 0.68, y: 0 },
      { x: 1.94, y: 1.26 },
    ],
  ])
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI])
      for (const mirror of [-1, 1]) {
        const center = base.map((p) => ({
          x: 2 + p.x * Math.cos(angle) - mirror * p.y * Math.sin(angle),
          y: -3 + p.x * Math.sin(angle) + mirror * p.y * Math.cos(angle),
        }))
        const { input, traces } = fixture(center),
          original = structuredClone({ input, traces })
        const rounded = roundCoupledReturnBends(input, traces)
        expect(rounded[0]).not.toBe(traces[0])
        expect(routeAnglesAreConventional(rounded)).toBe(true)
        expect(
          sharedPairSpacingReports(input, rounded).every((p) => p.matched),
        ).toBe(true)
        for (const [i, t] of rounded.entries()) {
          expect(tuningPathIsSelfClear(t.route, 0.2)).toBe(true)
          expect(t.route[0]).toEqual(traces[i].route[0])
          expect(t.route.at(-1)).toEqual(traces[i].route.at(-1))
          expect(t.curvedSegments).toHaveLength(32)
        }
        expect({ input, traces }).toEqual(original)
      }
})

test("rejects a return whose inner rail would violate self clearance", () => {
  const { input, traces } = fixture([
    { x: 3, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0.3 },
    { x: 3, y: 0.3 },
  ])
  expect(roundCoupledReturnBends(input, traces)).toEqual(traces)
})

test("fixed copper inside the rounded path prevents the replacement", () => {
  const { input, traces } = fixture([
    { x: 3, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0.8 },
    { x: 3, y: 0.8 },
  ])
  const point = { x: -0.4, y: 0.4 }
  const fixed = [
    { a: point, b: point, layer: "bottom", radius: 0.1, owners: ["power"] },
  ]
  expect(roundCoupledReturnBends(input, traces, fixed)).toEqual(traces)
})
