import { expect, test } from "bun:test"
import { scoreAnytimeRoutes } from "../lib/anytime-score"
import type { SimpleRouteJson, Trace } from "../lib/types"

const input: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  bounds: { minX: -2, maxX: 12, minY: -2, maxY: 12 },
  obstacles: [],
  connections: [
    {
      name: "a",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top" },
        { x: 10, y: 0, layer: "top" },
      ],
    },
  ],
}
const trace: Trace = {
  type: "pcb_trace",
  pcb_trace_id: "a",
  connection_name: "a",
  route: [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 1 },
    { x: 7, y: 1 },
    { x: 8, y: 0 },
    { x: 10, y: 0 },
  ].map((p) => ({ ...p, route_type: "wire", layer: "top", width: 0.1 })),
}

test("bank annotations cannot improve the acceptance score without changing physical copper", () => {
  const ordinary = scoreAnytimeRoutes(input, [trace])
  const annotated = scoreAnytimeRoutes(input, [
    { ...trace, curvedSegments: [2, 4] },
  ])
  expect(annotated.tuningEnvelopeAreaMm2).toBeGreaterThan(
    ordinary.tuningEnvelopeAreaMm2,
  )
  expect(annotated.objective).toBe(ordinary.objective)
  expect(annotated.normalizedArea).toBe(ordinary.normalizedArea)
  expect(annotated.envelopeAreaMm2).toBe(ordinary.envelopeAreaMm2)
})

test("area acceptance responds to the outer physical envelope including wire radius", () => {
  const shorter = { ...trace, route: [trace.route[0], trace.route.at(-1)!] }
  const before = scoreAnytimeRoutes(input, [trace], {
    area: 1,
    skew: 0,
    length: 0,
  })
  const after = scoreAnytimeRoutes(input, [shorter], {
    area: 1,
    skew: 0,
    length: 0,
  })
  expect(before.envelopeAreaMm2).toBeCloseTo(10.1 * 1.1, 10)
  expect(after.envelopeAreaMm2).toBeCloseTo(10.1 * 0.1, 10)
  expect(after.objective).toBeLessThan(before.objective / 2)
})
