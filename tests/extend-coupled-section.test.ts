import { expect, test } from "bun:test"
import { extendCoupledSectionEnds } from "../lib/extend-coupled-section"
import { length } from "../lib/geometry"
import type { Trace } from "../lib/types"

test("paired section extends over existing parallel approaches without moving copper", () => {
  const traces: Trace[] = [0, 0.22].map((x, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `p${i}`,
    connection_name: `p${i}`,
    coupledSection: [0, 1],
    curvedSegments: [3],
    route: [
      { x, y: 0 },
      { x, y: 2 },
      { x, y: 4 + i },
      { x: x + 1, y: 5 + i },
    ].map((p) => ({ ...p, route_type: "wire", width: 0.1, layer: "top" })),
  }))
  const result = extendCoupledSectionEnds(traces)
  for (let i = 0; i < 2; i++) {
    expect(result[i].route[result[i].coupledSection![1]].y).toBe(4)
    expect(length(result[i].route)).toBeCloseTo(length(traces[i].route), 10)
    expect(result[i].route.at(-1)).toEqual(traces[i].route.at(-1))
    expect(traces[i].route[1].y).toBe(2)
  }
  expect(result[0].curvedSegments).toEqual([2])
  expect(result[1].curvedSegments).toEqual([3])
})
