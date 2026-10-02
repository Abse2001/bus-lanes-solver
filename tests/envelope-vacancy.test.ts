import { expect, test } from "bun:test"
import { measureEnvelopeVacancy } from "../scripts/measure-envelope-vacancy"
import type { SimpleRouteJson, Trace } from "../lib/types"
const input: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  obstacles: [],
  connections: [],
  bounds: { minX: -1, maxX: 11, minY: -1, maxY: 5 },
}
const line = (y: number, layer = "top"): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: `${layer}-${y}`,
  route: [0, 10].map((x) => ({ route_type: "wire", x, y, width: 0.1, layer })),
})
const measure = (traces: Trace[], board = input) =>
  measureEnvelopeVacancy(board, traces, (p) => p, { start: 0, end: 10 })

test("vacant envelope reports usable interior space, not board area", () => {
  const result = measure([line(0), line(4)])
  expect(result.envelopeAreaMm2).toBeCloseTo(41)
  expect(result.unoccupiedAreaMm2).toBeGreaterThan(34)
  expect(result.unoccupiedAreaMm2).toBeLessThan(37)
  expect(result.layers[0].largestFreeRectangleMm2).toBeCloseTo(
    result.unoccupiedAreaMm2,
  )
  expect(measure([line(0), line(2), line(4)]).unoccupiedAreaMm2).toBeLessThan(
    result.unoccupiedAreaMm2,
  )
  expect(measure([], input).layers).toEqual([])
})

test("vacancy includes fixed power and obstacle clearance on the correct layer", () => {
  const traces = [line(0), line(4)]
  const original = measure(traces)
  const blocked = measure(traces, { ...input, traces: [line(2)] })
  expect(blocked.unoccupiedAreaMm2).toBeLessThan(original.unoccupiedAreaMm2)
  expect(blocked.layers[0].largestFreeRectangleMm2).toBeLessThan(
    original.layers[0].largestFreeRectangleMm2 / 2,
  )
  expect(measure(traces, { ...input, traces: [line(2, "bottom")] })).toEqual(
    original,
  )
  const obstacle = {
    center: { x: 5, y: 2 },
    width: 1,
    height: 2,
    layers: ["top"],
    connectedTo: [],
  }
  expect(
    measure(traces, { ...input, obstacles: [obstacle] }).unoccupiedAreaMm2,
  ).toBeLessThan(original.unoccupiedAreaMm2)
})

test("vacancy is invariant under rigid rotation and translation", () => {
  const traces = [line(0), line(4)],
    before = structuredClone(traces)
  const rotated = traces.map((t) => ({
    ...t,
    route: t.route.map((p) => ({ ...p, x: 20 - p.y, y: p.x - 7 })),
  }))
  const a = measure(traces)
  const b = measureEnvelopeVacancy(
    input,
    rotated,
    (p) => ({ x: p.y + 7, y: 20 - p.x }),
    { start: 0, end: 10 },
  )
  expect(b.envelopeAreaMm2).toBeCloseTo(a.envelopeAreaMm2)
  expect(b.unoccupiedAreaMm2).toBeCloseTo(a.unoccupiedAreaMm2)
  expect(traces).toEqual(before)
})
