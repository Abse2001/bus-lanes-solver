import { expect, test } from "bun:test"
import { pairInteriorSpacing } from "../lib/pair-interior-spacing"
import type { SimpleRouteJson, Trace } from "../lib/types"

const input: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  bounds: { minX: 0, maxX: 20, minY: -2, maxY: 2 },
  obstacles: [],
  connections: [],
  differentialPairs: [
    { connectionNames: ["P", "N"], traceGap: 0.12, lengthTolerance: 0.127 },
  ],
}
const trace = (name: string, points: number[][]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  coupledSection: [0, points.length - 1],
  route: points.map(([x, y]) => ({
    x,
    y,
    route_type: "wire",
    width: 0.1,
    layer: "top",
  })),
})
test("interior spacing checks copper instead of trusting paired metadata", () => {
  const p = trace("P", [
    [0, 0],
    [20, 0],
  ])
  const coupled = trace("N", [
    [0, 0.22],
    [20, 0.22],
  ])
  const divergent = trace("N", [
    [0, 0.22],
    [5, 0.22],
    [6, 1],
    [14, 1],
    [15, 0.22],
    [20, 0.22],
  ])
  expect(
    pairInteriorSpacing(input, [p, coupled], 2)[0].conductors.every(
      (c) => Math.abs(c.maxGapMm! - 0.12) < 1e-9,
    ),
  ).toBe(true)
  expect(
    pairInteriorSpacing(input, [p, divergent], 2)[0].conductors.some(
      (c) => c.maxGapMm! > 0.8,
    ),
  ).toBe(true)
  expect(pairInteriorSpacing(input, [p], 2)[0].conductors[1].samples).toBe(0)
})
