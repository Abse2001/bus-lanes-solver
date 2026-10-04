import { expect, test } from "bun:test"
import { terminalViaCopperIsClear } from "../lib/terminal-via-clearance"
import type { SimpleRouteJson, Trace } from "../lib"

const trace: Trace = {
  type: "pcb_trace",
  pcb_trace_id: "lane",
  connection_name: "data",
  route: [{ route_type: "wire", x: 0, y: 0, width: 0.1, layer: "inner1" }],
}
const input: SimpleRouteJson = {
  layerCount: 4,
  minTraceWidth: 0.1,
  bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
  obstacles: [],
  connections: [],
  traces: [
    {
      ...trace,
      route: [
        {
          route_type: "via",
          x: 0,
          y: 0,
          from_layer: "top",
          to_layer: "inner1",
          via_diameter: 0.3,
        },
      ],
    },
  ],
}

test("independent tuning cannot cut back through its own via land", () => {
  const returning = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0.1, y: 0.1 },
    { x: -1, y: 1 },
  ]
  expect(
    terminalViaCopperIsClear(input, trace, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]),
  ).toBe(true)
  expect(terminalViaCopperIsClear(input, trace, returning)).toBe(false)
  expect(terminalViaCopperIsClear(input, trace, returning.toReversed())).toBe(
    false,
  )
  expect(
    terminalViaCopperIsClear(input, trace, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0.3, y: 0.3 },
      { x: -1, y: 1 },
    ]),
  ).toBe(true)
})
