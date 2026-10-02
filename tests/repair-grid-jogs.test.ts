import { expect, test } from "bun:test"
import { repairGridJogs } from "../lib/repair-grid-jogs"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

const input: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  defaultObstacleMargin: 0.1,
  bounds: { minX: -1, maxX: 5, minY: -2, maxY: 2 },
  obstacles: [],
  connections: [
    {
      name: "D",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top" },
        { x: 4, y: 0, layer: "top" },
      ],
    },
  ],
}
function badTrace(): Trace {
  return {
    type: "pcb_trace",
    pcb_trace_id: "D",
    connection_name: "D",
    route: [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 0.1],
      [3, 0.1],
      [4, 0],
    ].map(([x, y]) => ({ x, y, route_type: "wire", layer: "top", width: 0.1 })),
  }
}
function run(traces: Trace[]) {
  const search = repairGridJogs(input, traces, fixedCopper(input))
  let state = search.next(),
    count = 0
  while (!state.done && count++ < 10000) state = search.next()
  expect(state.done).toBe(true)
  return state.value
}

test("repair removes a returning jog with clearance checked against fixed copper", () => {
  const trace = badTrace(),
    ends = [trace.route[0], trace.route.at(-1)!]
  expect(tuningPathIsSelfClear(trace.route, 0.2)).toBe(false)
  expect(run([trace])).toBe(true)
  expect(tuningPathIsSelfClear(trace.route, 0.2)).toBe(true)
  expect([trace.route[0], trace.route.at(-1)!]).toEqual(ends)
  expect(
    new VectorScene(input, input.connections[0], 0.1, [
      ...fixedCopper(input),
      ...routeCopper(trace),
    ]).pathVisible(trace.route),
  ).toBe(true)
})

test("single-rail repair never changes a declared coupled corridor", () => {
  const trace = badTrace()
  trace.coupledSection = [1, 4]
  const before = structuredClone(trace)
  expect(run([trace])).toBe(false)
  expect(trace).toEqual(before)
})
