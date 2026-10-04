import { expect, test } from "bun:test"
import {
  terminalViaCopperIsClear,
  createTerminalViaClearanceChecker,
} from "../lib/terminal-via-clearance"
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

test("a newly generated escape cannot grandfather a bend inside its own via land", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 0.049, y: 0.049 },
    { x: 0.1193, y: 0.049 },
    { x: 0.13248, y: 0.0492 },
    { x: 0.14566, y: 0.0498 },
    { x: 0.15884, y: 0.0508 },
    { x: 0.17202, y: 0.0522 },
    { x: 0.1852, y: 0.0539 },
    { x: 1, y: 0.1 },
  ]
  const generated = {
    ...trace,
    route: path.map((p) => ({
      ...p,
      route_type: "wire" as const,
      layer: "inner1",
      width: 0.1,
    })),
  }
  expect(
    createTerminalViaClearanceChecker(input, generated)(generated.route),
  ).toBe(true)
  expect(
    createTerminalViaClearanceChecker(input, generated, {
      preserveExistingApproach: false,
    })(generated.route),
  ).toBe(false)
  const straightExit = [
    { x: 0, y: 0 },
    { x: 0.3, y: 0 },
    { x: 0.5, y: 0.2 },
  ]
  expect(
    createTerminalViaClearanceChecker(input, generated, {
      preserveExistingApproach: false,
    })(straightExit),
  ).toBe(true)
})
