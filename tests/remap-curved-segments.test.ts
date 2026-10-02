import { expect, test } from "bun:test"
import { remapCurvedSegments } from "../lib/remap-curved-segments"
import type { Trace } from "../lib/types"

const trace: Trace = {
  type: "pcb_trace",
  pcb_trace_id: "curve",
  curvedSegments: [2, 3],
  route: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1.5, y: 0.1 },
    { x: 2, y: 0.3 },
    { x: 3, y: 0.3 },
  ].map((p) => ({ ...p, route_type: "wire", layer: "top", width: 0.1 })),
}
test("curve annotations survive edits elsewhere in the route", () => {
  const route = [trace.route[0], { x: 0.5, y: 0 }, ...trace.route.slice(1)]
  expect(remapCurvedSegments(trace, route)).toEqual([3, 4])
})
test("removed curves and new arbitrary diagonals are not annotated", () => {
  const route = [trace.route[0], { x: 0.2, y: 0.7 }, ...trace.route.slice(3)]
  expect(remapCurvedSegments(trace, route)).toEqual([])
})
