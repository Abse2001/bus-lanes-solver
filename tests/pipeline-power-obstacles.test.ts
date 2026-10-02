import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  BusLanesPipelineSolver,
  type SimpleRouteJson,
  type Trace,
} from "../lib"
import { distance } from "../lib/geometry"
import { fixedCopper, VectorScene } from "../lib/vector-scene"

test("immutable power dogbones obstruct signal layers and appear exactly once in pipeline output", () => {
  const power: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "fixed_vcc_dogbone",
    connection_name: "VCC",
    source_trace_id: "VCC",
    route: [
      { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.1 },
      { route_type: "wire", x: 0.4, y: 0.4, layer: "top", width: 0.1 },
      {
        route_type: "via",
        x: 0.4,
        y: 0.4,
        from_layer: "top",
        to_layer: "bottom",
        layers: ["top", "inner1", "inner2", "bottom"],
        via_diameter: 0.3,
        via_hole_diameter: 0.15,
      },
      { route_type: "wire", x: 0.4, y: 0.4, layer: "bottom", width: 0.1 },
    ],
  }
  const input: SimpleRouteJson = {
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    layerCount: 4,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -2, y: 0.4, layer: "inner1" },
          { x: 2, y: 0.4, layer: "inner1" },
        ],
      },
    ],
    obstacles: [
      {
        componentId: "U1",
        shape: "circle",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 0.4,
        layers: ["top"],
        connectedTo: ["VCC"],
      },
    ],
    traces: [power],
  }
  const original = structuredClone(input)
  const connection = input.connections[0]
  const [a, b] = connection.pointsToConnect
  expect(new VectorScene(input, connection, 0.1, []).visible(a, b)).toBe(true)
  expect(
    new VectorScene(input, connection, 0.1, fixedCopper(input)).visible(a, b),
  ).toBe(false)
  const solver = new BusLanesPipelineSolver(input, {
    fanout: "none",
    smoothTuning: false,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.error).toBeNull()
  expect(solver.traces).toHaveLength(1)
  expect(solver.traces[0].connection_name).toBe("D")
  expect(solver.traces[0].route.every((p) => p.route_type === "wire")).toBe(
    true,
  )
  const output = solver.getOutput()
  expect(input).toEqual(original)
  expect(
    output.traces.filter((t) => t.pcb_trace_id === power.pcb_trace_id),
  ).toEqual([power])
  expect(output.traces).toHaveLength(2)
  expect(
    solver.traces[0].route
      .slice(1)
      .reduce(
        (total, p, i) => total + distance(solver.traces[0].route[i], p),
        0,
      ),
  ).toBeGreaterThan(distance(a, b))
  const validationInput = {
    ...input,
    connections: [
      ...input.connections,
      { name: "VCC", pointsToConnect: [{ x: 0, y: 0, layer: "top" }] },
    ],
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: validationInput,
    routedSrj: { ...output, connections: validationInput.connections },
    clearance: input.minTraceToPadEdgeClearance!,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.issues).toEqual([])
  expect(drc.valid).toBe(true)
  expect(drc.checkedViaCount).toBe(1)
})
