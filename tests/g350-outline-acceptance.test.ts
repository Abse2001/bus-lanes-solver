import { expect, test } from "bun:test"
import { loadG350Am3352Sample } from "../scripts/g350-am3352-sample"
import { validateG350Am3352Sample } from "../scripts/validate-g350-am3352-sample"
import type { Trace } from "../lib/types"

test("G350 acceptance checks the preserved waist cutout between two inside endpoints", () => {
  const input = loadG350Am3352Sample()
  const before = structuredClone(input)
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "crosses_actual_waist",
    connection_name: input.connections[0].name,
    route: [
      { x: -30, y: -35, route_type: "wire", layer: "top", width: 0.1016 },
      { x: 0, y: -55, route_type: "wire", layer: "top", width: 0.1016 },
    ],
  }
  const result = validateG350Am3352Sample(input, { ...input, traces: [trace] })
  expect(result.outline.valid).toBe(false)
  expect(result.outline.issues).toContainEqual({
    pcbTraceId: trace.pcb_trace_id,
    routeIndex: 0,
    kind: "wire",
  })
  expect(result.valid).toBe(false)
  expect(input).toEqual(before)
})

test("G350 outline acceptance checks actual via land radius and board-edge clearance", () => {
  const input = loadG350Am3352Sample()
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "land_too_close_to_actual_waist",
    connection_name: input.connections[0].name,
    route: [
      {
        x: 10.55,
        y: -50,
        route_type: "via",
        from_layer: "top",
        to_layer: "bottom",
        layers: ["top", "inner1", "inner2", "bottom"],
        via_diameter: 0.4572,
        via_hole_diameter: 0.254,
      },
    ],
  }
  const result = validateG350Am3352Sample(input, { ...input, traces: [trace] })
  expect(result.outline.valid).toBe(false)
  expect(result.outline.issues).toEqual([
    { pcbTraceId: trace.pcb_trace_id, routeIndex: 0, kind: "via" },
  ])
  expect(result.valid).toBe(false)
})
