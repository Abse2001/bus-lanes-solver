import { expect, test } from "bun:test"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import type { Trace } from "../lib/types"

const trace = (points: number[][]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: "test",
  connection_name: "signal",
  route: points.map(([x, y]) => ({
    route_type: "wire",
    x,
    y,
    layer: "bottom",
    width: 0.1,
  })),
})
test("octilinear ordinary bends and sampled gentle curves are conventional", () => {
  expect(
    routeAnglesAreConventional([
      trace([
        [0, 0],
        [2, 0],
        [3, 1],
        [3, 3],
      ]),
    ]),
  ).toBe(true)
  const curve = trace(
    Array.from({ length: 37 }, (_, i) => [
      Math.cos((i * Math.PI) / 36),
      Math.sin((i * Math.PI) / 36),
    ]),
  )
  curve.curvedSegments = curve.route.map((_, i) => i).slice(1)
  expect(routeAnglesAreConventional([curve])).toBe(true)
})
test("sharp ordinary and annotated curve handoffs are rejected", () => {
  const corner = trace([
    [0, 0],
    [2, 0],
    [2, 2],
  ])
  expect(routeAnglesAreConventional([corner])).toBe(false)
  const acute = trace([
    [0, 0],
    [2, 0],
    [1, 1],
  ])
  acute.curvedSegments = [1, 2]
  expect(routeAnglesAreConventional([acute])).toBe(false)
})
