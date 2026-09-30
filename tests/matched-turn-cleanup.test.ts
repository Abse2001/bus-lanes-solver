import { test, expect } from "bun:test"
import { simplifyMatchedTraces } from "../lib/simplify-matched-traces"
import { length } from "../lib/geometry"
import type { Trace } from "../lib/types"

test("reference turn cleanup preserves matched length and endpoints", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 2 },
    { x: 1, y: 3 },
    { x: 2, y: 4 },
  ]
  const input = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 5, minY: -2, maxY: 6 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [points[0], points.at(-1)!].map((p) => ({
          ...p,
          layer: "top",
        })),
      },
    ],
  }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "D",
    connection_name: "D",
    route: points.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.1,
      layer: "top",
    })),
  }
  const [cleaned] = simplifyMatchedTraces(input, [trace])
  expect(cleaned.route.length).toBeLessThan(trace.route.length)
  expect(length(cleaned.route)).toBeCloseTo(length(trace.route), 8)
  expect(cleaned.route[0]).toEqual(trace.route[0])
  expect(cleaned.route.at(-1)).toEqual(trace.route.at(-1))
  expect(trace.route).toHaveLength(5)
  const curved = { ...trace, curvedSegments: [2, 3] }
  expect(simplifyMatchedTraces(input, [curved])[0]).toEqual(curved)
  const paired: Trace = { ...trace, coupledSection: [1, 3] }
  expect(simplifyMatchedTraces(input, [paired])[0]).toEqual(paired)
})
